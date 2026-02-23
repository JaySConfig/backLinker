export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { generatePageMetadata } from '@/lib/groq';
import { analyzeUrl, saveSuggestions, processLinkChecks } from '@/lib/analyze';

// Total pages to process per cron run across both backfill and new URLs.
// Backfills are prioritised first; any remaining slots go to new URLs.
// Keeping this low (3) stays comfortably within Groq's free-tier rate limits.
const MAX_PER_RUN = 3;

// Polite delay between HTTP scrapes (ms)
const SCRAPE_DELAY_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Sitemap helpers
// ---------------------------------------------------------------------------

/**
 * Extracts all <loc> values from a sitemap or sitemap-index XML string.
 * Handles both standard sitemaps and sitemap index files transparently.
 */
async function fetchSitemapUrls(sitemapUrl) {
  const res = await fetch(sitemapUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BacklinkerBot/1.0)' },
  });
  if (!res.ok) throw new Error(`Sitemap fetch failed: ${res.status} ${res.statusText}`);
  const xml = await res.text();

  // Sitemap index — contains <sitemap><loc>…</loc></sitemap> entries pointing to child sitemaps
  if (xml.includes('<sitemapindex')) {
    const childUrls = [...xml.matchAll(/<sitemap>[\s\S]*?<loc>(.*?)<\/loc>[\s\S]*?<\/sitemap>/gi)].map(
      (m) => m[1].trim(),
    );
    const nested = await Promise.all(childUrls.map(fetchSitemapUrls));
    return nested.flat();
  }

  // Standard sitemap — contains <url><loc>…</loc></url> entries
  return [...xml.matchAll(/<url>[\s\S]*?<loc>(.*?)<\/loc>[\s\S]*?<\/url>/gi)].map((m) =>
    m[1].trim(),
  );
}

// ---------------------------------------------------------------------------
// Page scraper
// ---------------------------------------------------------------------------

/**
 * Fetches a URL and returns { title, content } as clean plain text.
 */
async function scrapePage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BackLinker-Cron/1.0 (internal tool)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
// GET /api/cron
// Vercel calls this on schedule; it also sends Authorization: Bearer <CRON_SECRET>
// ---------------------------------------------------------------------------
export async function GET(request) {
  // Auth guard — skip in local dev where CRON_SECRET may not be set
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const sitemapUrl = process.env.SITEMAP_URL;
  if (!sitemapUrl) {
    return NextResponse.json({ error: 'SITEMAP_URL environment variable is not set.' }, { status: 500 });
  }

  const log = []; // collects a human-readable run summary
  const stats = { newInserted: 0, backfilled: 0, errors: 0 };

  try {
    // ----- 1. Fetch all URLs from the sitemap --------------------------------
    log.push('Fetching sitemap…');
    const sitemapUrls = await fetchSitemapUrls(sitemapUrl);
    log.push(`Sitemap contains ${sitemapUrls.length} URL(s).`);

    // ----- 2. Load all existing URLs from Supabase ---------------------------
    const { data: existingRows, error: fetchErr } = await getSupabase()
      .from('pages')
      .select('url, content');
    if (fetchErr) throw new Error(`Supabase select failed: ${fetchErr.message}`);

    const existingUrlSet = new Set(existingRows.map((r) => r.url));

    // Backfills fill the budget first; remaining slots go to new URLs.
    const nullContentUrls = existingRows
      .filter((r) => !r.content)
      .map((r) => r.url)
      .slice(0, MAX_PER_RUN);

    // ----- 3. Determine which URLs are brand new -----------------------------
    const SKIP_PATTERNS = ['/category/', '/author/', '/tag/', '/page/', '/contributors/'];
    const isContentPage = (u) => !SKIP_PATTERNS.some((p) => u.includes(p));

    const remainingSlots = MAX_PER_RUN - nullContentUrls.length;
    const newUrls = sitemapUrls
      .filter((u) => !existingUrlSet.has(u) && isContentPage(u))
      .slice(0, remainingSlots);
    log.push(`Backfill queue: ${nullContentUrls.length}, new URLs: ${newUrls.length} (budget: ${MAX_PER_RUN}/run).`);

    // ----- 4. Scrape and insert new pages ------------------------------------
    for (const url of newUrls) {
      try {
        log.push(`  [NEW] Scraping ${url}`);
        const { title, content } = await scrapePage(url);
        const { summary, keywords } = await generatePageMetadata(title, content);

        const { error: insertErr } = await getSupabase().from('pages').upsert(
          { url, title, summary, keywords, content },
          { onConflict: 'url' },
        );
        if (insertErr) throw new Error(insertErr.message);

        stats.newInserted++;
        log.push(`    Inserted: "${title}"`);

        // Run backlink analysis for the newly indexed page and persist suggestions.
        try {
          const analysis = await analyzeUrl(url);
          await saveSuggestions(url, title, analysis.suggestions);
          log.push(`    Saved ${analysis.suggestions.length} backlink suggestion(s).`);
        } catch (analysisErr) {
          log.push(`    Analysis skipped: ${analysisErr.message}`);
        }
      } catch (err) {
        stats.errors++;
        log.push(`    ERROR: ${err.message}`);
      }
      await sleep(SCRAPE_DELAY_MS);
    }

    // ----- 5. Backfill content for existing rows that have none --------------
    for (const url of nullContentUrls) {
      try {
        log.push(`  [BACKFILL] Scraping ${url}`);
        const { title, content } = await scrapePage(url);

        // Only call Groq if we also need to generate summary/keywords
        const { data: existingMeta } = await getSupabase()
          .from('pages')
          .select('summary, keywords')
          .eq('url', url)
          .single();

        const needsMeta = !existingMeta?.summary || !existingMeta?.keywords?.length;
        let update = { content };

        if (needsMeta) {
          const { summary, keywords } = await generatePageMetadata(title, content);
          update = { content, summary, keywords };
        }

        const { error: updateErr } = await getSupabase().from('pages').update(update).eq('url', url);
        if (updateErr) throw new Error(updateErr.message);

        stats.backfilled++;
        log.push(`    Backfilled${needsMeta ? ' (+ metadata)' : ''}: ${url}`);
      } catch (err) {
        stats.errors++;
        log.push(`    ERROR: ${err.message}`);
      }
      await sleep(SCRAPE_DELAY_MS);
    }
    // ----- 6. Process deferred link checks on pending suggestions -----------
    try {
      const linkCheck = await processLinkChecks(3);
      log.push(`Link check: ${linkCheck.processed} checked, ${linkCheck.filtered} filtered.`);
    } catch (err) {
      log.push(`Link check skipped: ${err.message}`);
    }
  } catch (err) {
    log.push(`FATAL: ${err.message}`);
    console.error('[/api/cron] Fatal error:', err);
    return NextResponse.json({ ok: false, log, stats }, { status: 500 });
  }

  console.log('[/api/cron] Run complete:', stats);
  return NextResponse.json({ ok: true, stats, log });
}
