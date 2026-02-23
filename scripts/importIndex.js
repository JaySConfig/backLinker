#!/usr/bin/env node
/**
 * scripts/importIndex.js
 *
 * One-off script: reads /Users/gareththompson/Documents/internalLinker/index.json
 * and upserts every page into the Supabase `pages` table.
 *
 * Usage:
 *   node scripts/importIndex.js
 *
 * Credentials are loaded from .env.local in the project root.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// 1. Load .env.local manually (no dotenv dependency needed)
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

const envFile = path.resolve(__dirname, '..', '.env.local');
loadEnv(envFile);

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Read index.json
// ---------------------------------------------------------------------------
const INDEX_PATH = '/Users/gareththompson/Documents/internalLinker/index.json';

if (!fs.existsSync(INDEX_PATH)) {
  console.error(`index.json not found at: ${INDEX_PATH}`);
  process.exit(1);
}

const raw = fs.readFileSync(INDEX_PATH, 'utf8');
const { pages, totalPages } = JSON.parse(raw);

console.log(`Loaded ${pages.length} pages (index reports ${totalPages} total).`);

// ---------------------------------------------------------------------------
// 3. Upsert into Supabase
// ---------------------------------------------------------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const BATCH_SIZE = 20; // stay well within Supabase request limits

async function run() {
  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < pages.length; i += BATCH_SIZE) {
    const batch = pages.slice(i, i + BATCH_SIZE).map((p) => ({
      url: p.url,
      title: p.title ?? null,
      summary: p.summary ?? null,
      keywords: Array.isArray(p.keywords) ? p.keywords : [],
      content: p.content ?? null, // index.json doesn't include content; leave null
    }));

    const { data, error } = await supabase
      .from('pages')
      .upsert(batch, { onConflict: 'url', ignoreDuplicates: false })
      .select('url');

    if (error) {
      console.error(`  Batch ${i / BATCH_SIZE + 1} error:`, error.message);
      failed += batch.length;
    } else {
      inserted += data.length;
      const batchEnd = Math.min(i + BATCH_SIZE, pages.length);
      console.log(`  Batch ${i / BATCH_SIZE + 1}: upserted ${data.length} rows (pages ${i + 1}–${batchEnd})`);
    }
  }

  console.log('\n--- Import complete ---');
  console.log(`  Upserted : ${inserted}`);
  console.log(`  Failed   : ${failed}`);
}

run().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
