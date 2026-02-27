/**
 * scripts/buildSentences.js
 *
 * Clears the sentences table and repopulates it by fetching each page live,
 * parsing only <p>, <h2>, <h3> tags via cheerio, and applying strict filters.
 * Stores existing_links (normalised hrefs found within each sentence element)
 * so the analyzer can skip sentences that already link to the target.
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

const SITE_NAME_FRAGMENTS = ['lipedema and me', 'lipedemaandme'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// URL normalisation (mirrors analyze.js)
// ---------------------------------------------------------------------------
function normalizeUrl(href, baseUrl) {
  try {
    const parsed = new URL(href, baseUrl);
    return (parsed.origin + parsed.pathname)
      .toLowerCase()
      .replace(/^http:\/\//, 'https://')
      .replace(/^https:\/\/www\./, 'https://')
      .replace(/\/$/, '');
  } catch {
    return null;
  }
}

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
// Extract { text, links } blocks from raw HTML — only <p>, <h2>, <h3>
// links = normalised hrefs of any <a> tags found within that element
// ---------------------------------------------------------------------------
function extractBlocks(html, pageUrl) {
  const $ = cheerio.load(html);
  const blocks = [];

  $('p, h2, h3').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text) return;

    const links = [];
    $(el).find('a[href]').each((_, a) => {
      const href = $(a).attr('href');
      const normalized = href ? normalizeUrl(href, pageUrl) : null;
      if (normalized) links.push(normalized);
    });

    blocks.push({ text, links });
  });

  return blocks;
}

// ---------------------------------------------------------------------------
// Sentence quality filter
// ---------------------------------------------------------------------------
function isUsableSentence(sentence) {
  const words = sentence.trim().split(/\s+/);
  if (words.length < 15) return false;

  const lower = sentence.toLowerCase();
  if (sentence.includes('|')) return false;
  if (lower.includes('skip to content')) return false;
  if (SITE_NAME_FRAGMENTS.some((f) => lower.includes(f))) return false;

  // Reject link-list sentences: >40% of words start with a capital
  const capitalizedWords = words.filter((w) => /^[A-Z]/.test(w)).length;
  if (capitalizedWords / words.length > 0.4) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Split blocks into filtered sentence rows, carrying the block's links
// ---------------------------------------------------------------------------
function extractSentences(html, pageUrl) {
  const blocks = extractBlocks(html, pageUrl);
  const rows = [];

  for (const { text, links } of blocks) {
    const parts = text.split(/(?<=[.!?])\s+/);
    for (const part of parts) {
      const s = part.trim();
      if (isUsableSentence(s)) {
        rows.push({ sentence: s, existing_links: links });
      }
    }
  }

  return rows;
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
  console.log(
    `${contentPages.length} content page(s) to process (${pages.length - contentPages.length} skipped by URL pattern).\n`,
  );

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

    const sentences = extractSentences(html, page.url);

    if (!sentences.length) {
      console.log('  No usable sentences — skipping.');
      skipped++;
      await sleep(500);
      continue;
    }

    const rows = sentences.map(({ sentence, existing_links }) => ({
      page_url: page.url,
      page_title: page.title,
      sentence,
      existing_links,
    }));

    const { error: insErr } = await supabase.from('sentences').insert(rows);

    if (insErr) {
      console.log(`  Insert failed: ${insErr.message}`);
      failed++;
    } else {
      const linked = rows.filter((r) => r.existing_links.length > 0).length;
      console.log(`  ${sentences.length} sentence(s) stored (${linked} with existing links).`);
      populated++;
    }

    await sleep(800);
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
