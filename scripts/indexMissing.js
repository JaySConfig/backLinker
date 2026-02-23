#!/usr/bin/env node
/**
 * scripts/indexMissing.js
 *
 * One-off script: fetches the sitemap from SITEMAP_URL, compares all URLs
 * against the Supabase `pages` table, and indexes every missing page by
 * scraping its content then generating a summary and keywords with Groq.
 *
 * Pages are processed in batches of BATCH_SIZE with a BATCH_PAUSE_MS pause
 * between batches to stay within Groq's free-tier rate limits.
 *
 * Usage:
 *   node scripts/indexMissing.js
 *
 * Credentials and SITEMAP_URL are loaded from .env.local in the project root.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BATCH_SIZE     = 3;
const BATCH_PAUSE_MS = 60_000; // 60 s between batches

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1. Load .env.local
// ---------------------------------------------------------------------------
function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env.local not found at: ${envPath}`);
  }
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key   = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv(path.resolve(__dirname, '..', '.env.local'));

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SITEMAP_URL  = process.env.SITEMAP_URL;

for (const [name, val] of [
  ['NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL],
  ['NEXT_PUBLIC_SUPABASE_ANON_KEY', SUPABASE_KEY],
  ['GROQ_API_KEY', GROQ_API_KEY],
  ['SITEMAP_URL', SITEMAP_URL],
]) {
  if (!val) { console.error(`Missing ${name} in .env.local`); process.exit(1); }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const groq     = new Groq({ apiKey: GROQ_API_KEY });

// ---------------------------------------------------------------------------
// 2. Sitemap fetcher — handles both sitemap index and standard sitemaps
// ---------------------------------------------------------------------------
async function fetchSitemapUrls(sitemapUrl) {
  const res = await fetch(sitemapUrl, {
    headers: { 'User-Agent': 'BackLinker-IndexMissing/1.0 (internal tool)' },
  });
  if (!res.ok) throw new Error(`Sitemap fetch failed: ${res.status} ${res.statusText}`);
  const xml = await res.text();

  if (xml.includes('<sitemapindex')) {
    const childUrls = [...xml.matchAll(/<sitemap>[\s\S]*?<loc>(.*?)<\/loc>[\s\S]*?<\/sitemap>/gi)]
      .map((m) => m[1].trim());
    const nested = await Promise.all(childUrls.map(fetchSitemapUrls));
    return nested.flat();
  }

  return [...xml.matchAll(/<url>[\s\S]*?<loc>(.*?)<\/loc>[\s\S]*?<\/url>/gi)]
    .map((m) => m[1].trim());
}

// ---------------------------------------------------------------------------
// 3. Page scraper
// ---------------------------------------------------------------------------
async function scrapePage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BackLinker-IndexMissing/1.0 (internal tool)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;

  const content = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 15000);

  return { title, content };
}

// ---------------------------------------------------------------------------
// 4. Groq — generate summary + keywords for a page
// ---------------------------------------------------------------------------
function parseGroqJson(raw) {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Unparseable Groq response: ${trimmed.slice(0, 200)}`);
  }
}

async function generatePageMetadata(title, content) {
  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content: 'You are an SEO content analyst. Respond only with valid JSON — no markdown fences, no explanation.',
      },
      {
        role: 'user',
        content: `Analyse the page below and return a JSON object with two keys:
- "summary": a 2-3 sentence plain English summary of what the page is about (max 300 characters).
- "keywords": an array of 8-12 relevant keywords or short phrases (each 1-4 words).

Page title: "${title}"
Page content:
---
${content.slice(0, 8000)}
---`,
      },
    ],
  });
  return parseGroqJson(res.choices[0].message.content);
}

// ---------------------------------------------------------------------------
// 5. Main
// ---------------------------------------------------------------------------
async function run() {
  // ----- Fetch sitemap -----
  process.stdout.write(`Fetching sitemap from ${SITEMAP_URL} … `);
  const sitemapUrls = await fetchSitemapUrls(SITEMAP_URL);
  console.log(`${sitemapUrls.length} URL(s) found.`);

  // ----- Load existing URLs from Supabase -----
  process.stdout.write('Loading existing pages from Supabase … ');
  const { data: existingRows, error: fetchErr } = await supabase
    .from('pages')
    .select('url');
  if (fetchErr) {
    console.error('Supabase query failed:', fetchErr.message);
    process.exit(1);
  }
  const existingUrlSet = new Set(existingRows.map((r) => r.url));
  console.log(`${existingUrlSet.size} already indexed.`);

  // ----- Determine missing URLs -----
  const missingUrls = sitemapUrls.filter((u) => !existingUrlSet.has(u));
  if (missingUrls.length === 0) {
    console.log('\nAll sitemap URLs are already indexed. Nothing to do.');
    return;
  }
  console.log(`\n${missingUrls.length} URL(s) to index.\n`);

  const totalBatches = Math.ceil(missingUrls.length / BATCH_SIZE);
  let inserted = 0;
  let failed   = 0;

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batch = missingUrls.slice(batchIdx * BATCH_SIZE, (batchIdx + 1) * BATCH_SIZE);
    console.log(`── Batch ${batchIdx + 1}/${totalBatches} ──`);

    for (const url of batch) {
      const progress = `[${missingUrls.indexOf(url) + 1}/${missingUrls.length}]`;
      process.stdout.write(`  ${progress} ${url}\n`);

      try {
        process.stdout.write('    Scraping … ');
        const { title, content } = await scrapePage(url);
        console.log(`done (${content.length} chars)`);

        process.stdout.write('    Generating metadata … ');
        const { summary, keywords } = await generatePageMetadata(title, content);
        console.log('done');

        const { error: upsertErr } = await supabase
          .from('pages')
          .upsert({ url, title, summary, keywords, content }, { onConflict: 'url' });

        if (upsertErr) throw new Error(upsertErr.message);

        console.log(`    Inserted: "${title}"`);
        inserted++;
      } catch (err) {
        console.log(`    ERROR — ${err.message}`);
        failed++;
      }
    }

    if (batchIdx < totalBatches - 1) {
      console.log(`\n  Pausing ${BATCH_PAUSE_MS / 1000}s before next batch…\n`);
      await sleep(BATCH_PAUSE_MS);
    }
  }

  console.log('\n── Indexing complete ──');
  console.log(`  Inserted : ${inserted}`);
  console.log(`  Failed   : ${failed}`);
  console.log(`  Skipped  : ${sitemapUrls.length - missingUrls.length} (already indexed)`);
}

run().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
