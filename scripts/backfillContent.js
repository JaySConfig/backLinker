#!/usr/bin/env node
/**
 * scripts/backfillContent.js
 *
 * One-off script: fetches every row in the Supabase `pages` table where
 * `content` is null, scrapes the live URL to extract body text, and writes
 * the result back to the `content` column.
 *
 * Usage:
 *   node scripts/backfillContent.js
 *
 * Credentials are loaded from .env.local in the project root.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// 1. Load .env.local
// ---------------------------------------------------------------------------
function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env.local not found at: ${envPath}`);
  }
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv(path.resolve(__dirname, '..', '.env.local'));

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------------------------------------------------------
// 2. Scraper — strips boilerplate HTML and returns plain text
// ---------------------------------------------------------------------------
async function scrapePage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BackLinker-Backfill/1.0 (internal tool)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();

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

  return content;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 3. Main
// ---------------------------------------------------------------------------
async function run() {
  // Fetch every row where content is null
  const { data: rows, error } = await supabase
    .from('pages')
    .select('url')
    .is('content', null)
    .order('id', { ascending: true });

  if (error) {
    console.error('Supabase query failed:', error.message);
    process.exit(1);
  }

  console.log(`Found ${rows.length} row(s) with null content.\n`);

  let updated = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const { url } = rows[i];
    const progress = `[${i + 1}/${rows.length}]`;

    try {
      process.stdout.write(`${progress} Scraping ${url} … `);
      const content = await scrapePage(url);

      const { error: updateErr } = await supabase
        .from('pages')
        .update({ content })
        .eq('url', url);

      if (updateErr) throw new Error(updateErr.message);

      console.log(`done (${content.length} chars)`);
      updated++;
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
      failed++;
    }

    // Polite delay between requests (skip after the last one)
    if (i < rows.length - 1) await sleep(2000);
  }

  console.log('\n--- Backfill complete ---');
  console.log(`  Updated : ${updated}`);
  console.log(`  Failed  : ${failed}`);
}

run().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
