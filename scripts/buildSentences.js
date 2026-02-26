/**
 * scripts/buildSentences.js
 *
 * Clears the sentences table and repopulates it by fetching each page live,
 * parsing only <p>, <h2>, <h3> tags via cheerio, and applying strict filters.
 *
 *   node scripts/buildSentences.js
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
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

const SKIP_PATTERNS = [
  '/sitemap', '/category/', '/author/', '/tag/', '/blog/', '/page/',
  '/contributors/', '/privacy-policy', '/terms-and-conditions',
  '/newsletter-sign-up', '/lipedema-quiz', '/homeold',
  '/advertise-with-us', '/lipedema-photos', '/lipedema-before-and-after',
];
const isContentPage = (url) => !SKIP_PATTERNS.some((p) => url.includes(p));

// Site name fragments to reject
const SITE_NAME_FRAGMENTS = ['lipedema and me', 'lipedemaandme'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fetch raw HTML for a URL
// ---------------------------------------------------------------------------
async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BacklinkerBot/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// Extract clean text blocks from raw HTML — only <p>, <h2>, <h3>
// ---------------------------------------------------------------------------
function extractTextBlocks(html) {
  const $ = cheerio.load(html);
  const blocks = [];

  $('p, h2, h3').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text) blocks.push(text);
  });

  return blocks;
}

// ---------------------------------------------------------------------------
// Sentence quality filter
// ---------------------------------------------------------------------------
function isUsableSentence(sentence) {
  const words = sentence.trim().split(/\s+/);

  // Minimum 15 words
  if (words.length < 15) return false;

  const lower = sentence.toLowerCase();

  // Reject sentences containing a pipe character
  if (sentence.includes('|')) return false;

  // Reject navigation / meta copy
  if (lower.includes('skip to content')) return false;

  // Reject sentences containing the site name
  if (SITE_NAME_FRAGMENTS.some((f) => lower.includes(f))) return false;

  // Reject sentences that look like a list of links:
  // heuristic — more than 40% of words start with a capital letter
  const capitalizedWords = words.filter((w) => /^[A-Z]/.test(w)).length;
  if (capitalizedWords / words.length > 0.4) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Split text blocks into filtered sentences
// ---------------------------------------------------------------------------
function extractSentences(html) {
  const blocks = extractTextBlocks(html);
  const sentences = [];

  for (const block of blocks) {
    const parts = block.split(/(?<=[.!?])\s+/);
    for (const part of parts) {
      const s = part.trim();
      if (isUsableSentence(s)) sentences.push(s);
    }
  }

  return sentences;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Step 1: Wipe the sentences table
  console.log('Clearing sentences table…');
  const { error: truncErr } = await supabase
    .from('sentences')
    .delete()
    .neq('id', 0);

  if (truncErr) {
    console.error('Failed to clear sentences table:', truncErr.message);
    process.exit(1);
  }
  console.log('Sentences table cleared.\n');

  // Step 2: Load all page URLs
  console.log('Loading pages from Supabase…');
  const { data: pages, error: fetchErr } = await supabase
    .from('pages')
    .select('url, title');

  if (fetchErr) {
    console.error('Failed to load pages:', fetchErr.message);
    process.exit(1);
  }

  const contentPages = pages.filter((p) => isContentPage(p.url));
  console.log(`${contentPages.length} content page(s) to process (${pages.length - contentPages.length} skipped by URL pattern).\n`);

  let populated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < contentPages.length; i++) {
    const page = contentPages[i];
    process.stdout.write(`[${i + 1}/${contentPages.length}] ${page.url}\n`);

    let html;
    try {
      html = await fetchHtml(page.url);
    } catch (err) {
      console.log(`  Fetch failed: ${err.message}`);
      failed++;
      await sleep(500);
      continue;
    }

    const sentences = extractSentences(html);

    if (!sentences.length) {
      console.log('  No usable sentences — skipping.');
      skipped++;
      await sleep(500);
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
      populated++;
    }

    await sleep(800); // polite delay between requests
  }

  console.log('\n── Done ──');
  console.log(`  Populated : ${populated}`);
  console.log(`  Skipped   : ${skipped}`);
  console.log(`  Failed    : ${failed}`);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
