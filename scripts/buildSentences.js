/**
 * scripts/buildSentences.js
 *
 * One-off script: reads all pages with content from Supabase and populates
 * the sentences table. Run this once after the sentences table is created.
 *
 *   node scripts/buildSentences.js
 *
 * Safe to re-run — existing sentences for each page are replaced.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Load env from .env.local
// ---------------------------------------------------------------------------
const envPath = path.join(__dirname, '..', '.env.local');
const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
for (const line of envLines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  process.env[key] = value;
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

// ---------------------------------------------------------------------------
// Sentence splitting (mirrors the logic in src/lib/analyze.js)
// ---------------------------------------------------------------------------
function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && s.split(' ').length >= 7);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('Loading pages from Supabase…');
  const { data: pages, error } = await supabase
    .from('pages')
    .select('url, title, content')
    .not('content', 'is', null);

  if (error) {
    console.error('Failed to load pages:', error.message);
    process.exit(1);
  }

  console.log(`${pages.length} page(s) to process.\n`);

  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const sentences = splitSentences(page.content);

    process.stdout.write(`[${i + 1}/${pages.length}] ${page.url}\n`);

    if (!sentences.length) {
      console.log('  No usable sentences — skipping.');
      skipped++;
      continue;
    }

    // Delete existing sentences for this page first (safe to re-run).
    const { error: delErr } = await supabase
      .from('sentences')
      .delete()
      .eq('page_url', page.url);

    if (delErr) {
      console.log(`  Delete failed: ${delErr.message}`);
      failed++;
      continue;
    }

    const rows = sentences.map((sentence) => ({
      page_url: page.url,
      page_title: page.title,
      sentence,
    }));

    const { error: insErr } = await supabase.from('sentences').insert(rows);

    if (insErr) {
      console.log(`  Insert failed: ${insErr.message}`);
      failed++;
    } else {
      console.log(`  ${sentences.length} sentence(s) stored.`);
      inserted++;
    }
  }

  console.log('\n── Done ──');
  console.log(`  Populated : ${inserted}`);
  console.log(`  Skipped   : ${skipped}`);
  console.log(`  Failed    : ${failed}`);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
