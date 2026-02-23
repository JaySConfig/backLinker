#!/usr/bin/env node
/**
 * scripts/analyzeAll.js
 *
 * One-off script: iterates every row in the Supabase `pages` table,
 * runs backlink analysis on each URL, and saves the results to the
 * `suggestions` table.
 *
 * Pages are processed in batches of BATCH_SIZE with a BATCH_PAUSE_MS
 * pause between batches to stay within Groq's free-tier rate limits.
 *
 * Usage:
 *   node scripts/analyzeAll.js
 *
 * Credentials are loaded from .env.local in the project root.
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
const MAX_CANDIDATES = 15;     // max sentences sent to Groq for confirmation

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

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}
if (!GROQ_API_KEY) {
  console.error('Missing GROQ_API_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const groq     = new Groq({ apiKey: GROQ_API_KEY });

// ---------------------------------------------------------------------------
// 2. URL helpers
// ---------------------------------------------------------------------------
function normalizeUrl(u) {
  return u
    .toLowerCase()
    .replace(/^http:\/\//, 'https://')
    .replace(/^https:\/\/www\./, 'https://')
    .replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// 3. Page scraper
// ---------------------------------------------------------------------------
async function fetchPageContent(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BackLinker-AnalyzeAll/1.0 (internal tool)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;

  const rawHrefValues = [...html.matchAll(/href=["']([^"'\s]+)["']/gi)].map((m) => m[1]);
  const existingHrefs = new Set(
    rawHrefValues.flatMap((href) => {
      try {
        const parsed = new URL(href, url);
        return [normalizeUrl(parsed.origin + parsed.pathname)];
      } catch {
        return [];
      }
    }),
  );

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

  return { title, content, existingHrefs };
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30);
}

// ---------------------------------------------------------------------------
// 4. Groq helpers
// ---------------------------------------------------------------------------
function parseJson(raw) {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const obj = trimmed.match(/\{[\s\S]*\}/);
    if (obj) return JSON.parse(obj[0]);
    const arr = trimmed.match(/\[[\s\S]*\]/);
    if (arr) return JSON.parse(arr[0]);
    throw new Error(`Unparseable Groq response: ${trimmed.slice(0, 200)}`);
  }
}

async function extractKeywords(content) {
  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content: 'You are an SEO expert. Respond only with valid JSON — no markdown fences, no explanation.',
      },
      {
        role: 'user',
        content: `Analyse the blog post below and return a JSON object with two keys:
- "primary": the single most important keyword or short phrase (2-4 words) that the post is about.
- "variations": an array of exactly 5 natural language variations of that keyword.

Blog post content:
---
${content}
---`,
      },
    ],
  });
  return parseJson(res.choices[0].message.content);
}

async function confirmSuggestions(newPostTitle, newPostSummary, candidates) {
  if (candidates.length === 0) return [];
  const candidateText = candidates
    .map((c, i) => `${i + 1}. Source: "${c.sourceTitle}" (${c.sourceUrl})\n   Sentence: "${c.sentence}"`)
    .join('\n\n');

  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    temperature: 0.4,
    messages: [
      {
        role: 'system',
        content: 'You are an internal linking specialist. Respond only with valid JSON — no markdown fences, no explanation.',
      },
      {
        role: 'user',
        content: `We have a newly published blog post:
Title: "${newPostTitle}"
Summary: "${newPostSummary}"

Below are candidate sentences from existing pages that might be good places to add an internal link back to the new post. For each candidate:
1. Decide if it is genuinely a good backlink opportunity (contextually relevant, natural placement).
2. If yes, choose anchor text using this priority order:
   a. FIRST CHOICE — extract the most specific and descriptive phrase directly from the post title "${newPostTitle}".
   b. FALLBACK ONLY — if no phrase from the title can be woven in naturally, use a relevant keyword variation.
   The anchor text must read naturally within the candidate sentence — never force it.
3. If no, exclude it from the output.

Return a JSON array where each item has:
- "sourceUrl": string
- "sourceTitle": string
- "suggestedAnchorText": string
- "anchorSource": either "title" or "variation"
- "context": the original sentence (lightly tidied if needed)
- "reason": one sentence explaining the relevance

Candidates:
${candidateText}`,
      },
    ],
  });
  return parseJson(res.choices[0].message.content);
}

// ---------------------------------------------------------------------------
// 5. Core analysis
// ---------------------------------------------------------------------------
async function analyzeUrl(url) {
  const { title, content, existingHrefs } = await fetchPageContent(url);

  const { primary, variations } = await extractKeywords(content);
  const allKeywords = [primary, ...variations].map((k) => k.toLowerCase());

  const ilikeFilters = allKeywords.map((kw) => `content.ilike.%${kw}%`).join(',');
  const { data: matchingPages, error: dbError } = await supabase
    .from('pages')
    .select('url, title, summary, content')
    .or(ilikeFilters)
    .neq('url', url)
    .limit(20);

  if (dbError) throw new Error(`Supabase query failed: ${dbError.message}`);
  if (!matchingPages || matchingPages.length === 0) {
    return { newPostTitle: title, primary, variations, suggestions: [] };
  }

  const candidates = [];
  for (const page of matchingPages) {
    if (!page.content) continue;
    for (const sentence of splitSentences(page.content)) {
      if (allKeywords.some((kw) => sentence.toLowerCase().includes(kw))) {
        candidates.push({ sourceUrl: page.url, sourceTitle: page.title || page.url, sentence });
      }
    }
  }

  const confirmed = await confirmSuggestions(title, content.slice(0, 500), candidates.slice(0, MAX_CANDIDATES));

  const suggestions = confirmed.filter((s) => !existingHrefs.has(normalizeUrl(s.sourceUrl)));
  return { newPostTitle: title, suggestions };
}

// ---------------------------------------------------------------------------
// 6. Save to Supabase
// ---------------------------------------------------------------------------
async function saveSuggestions(targetUrl, targetTitle, suggestions) {
  if (!suggestions.length) return;
  const rows = suggestions.map((s) => ({
    target_url: targetUrl,
    target_title: targetTitle,
    source_url: s.sourceUrl,
    source_title: s.sourceTitle,
    suggested_anchor_text: s.suggestedAnchorText,
    anchor_source: s.anchorSource ?? null,
    context: s.context,
    reason: s.reason,
    status: 'pending',
  }));
  const { error } = await supabase
    .from('suggestions')
    .upsert(rows, { onConflict: 'target_url,source_url' });
  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// 7. Main
// ---------------------------------------------------------------------------
async function run() {
  const { data: pages, error } = await supabase
    .from('pages')
    .select('url, title')
    .order('id', { ascending: true });

  if (error) {
    console.error('Failed to fetch pages:', error.message);
    process.exit(1);
  }

  console.log(`Found ${pages.length} page(s) to analyse.`);
  console.log(`Batch size: ${BATCH_SIZE} | Pause between batches: ${BATCH_PAUSE_MS / 1000}s\n`);

  const totalBatches   = Math.ceil(pages.length / BATCH_SIZE);
  let totalSuggestions = 0;
  let totalErrors      = 0;

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batch = pages.slice(batchIdx * BATCH_SIZE, (batchIdx + 1) * BATCH_SIZE);
    console.log(`── Batch ${batchIdx + 1}/${totalBatches} ──`);

    for (const page of batch) {
      process.stdout.write(`  [${pages.indexOf(page) + 1}/${pages.length}] ${page.url} … `);
      try {
        const { newPostTitle, suggestions } = await analyzeUrl(page.url);
        await saveSuggestions(page.url, newPostTitle || page.title, suggestions);
        console.log(`${suggestions.length} suggestion(s) saved`);
        totalSuggestions += suggestions.length;
      } catch (err) {
        console.log(`ERROR — ${err.message}`);
        totalErrors++;
      }
    }

    if (batchIdx < totalBatches - 1) {
      console.log(`\n  Pausing ${BATCH_PAUSE_MS / 1000}s before next batch…\n`);
      await sleep(BATCH_PAUSE_MS);
    }
  }

  console.log('\n── Analysis complete ──');
  console.log(`  Pages processed  : ${pages.length}`);
  console.log(`  Suggestions saved: ${totalSuggestions}`);
  console.log(`  Errors           : ${totalErrors}`);
}

run().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
