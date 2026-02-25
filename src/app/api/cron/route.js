export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { generatePageMetadata } from '@/lib/groq';
import {
  analyzeUrl,
  saveSuggestions,
  populateSentences,
  processLinkChecks,
  isContentPage,
} from '@/lib/analyze';

// Pages to scrape/backfill per run (shared budget for indexing + backfill).
const MAX_INDEXING_PER_RUN = 2;
// Pages to run backlink analysis on per run.
const MAX_ANALYSIS_PER_RUN = 10;

// Polite delay between HTTP scrapes (ms).
const SCRAPE_DELAY_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Sitemap helpers
// ---------------------------------------------------------------------------

async function fetchSitemapUrls(sitemapUrl) {
  const res = await fetch(sitemapUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BacklinkerBot/1.0)' },
  });
  if (!res.ok) throw new Error(`Sitemap fetch failed: ${res.status} ${res.statusText}`);
  const xml = await res.text();

  if (xml.includes('<sitemapindex')) {
    const childUrls = [...xml.matchAll(/<sitemap>[\s\S]*?<loc>(.*?)<\/loc>[\s\S]*?<\/sitemap>/gi)].map(
      (m) => m[1].trim(),
    );
    const nested = await Promise.all(childUrls.map(fetchSitemapUrls));
    return nested.flat();
  }

  return [...xml.matchAll(/<url>[\s\S]*?<loc>(.*?)<\/loc>[\s\S]*?<\/url>/gi)].map((m) =>
    m[1].trim(),
  );
}

// ---------------------------------------------------------------------------
// Page scraper
// ---------------------------------------------------------------------------

async function scrapePage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BacklinkerBot/1.0)' },
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
// ---------------------------------------------------------------------------

export async function GET(request) {
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

  const log = [];
  const stats = { newInserted: 0, backfilled: 0, analyzed: 0, errors: 0 };

  try {
    // ----- 1. Fetch all URLs from the sitemap --------------------------------
    log.push('Fetching sitemap…');
    const sitemapUrls = await fetchSitemapUrls(sitemapUrl);
    log.push(`Sitemap contains ${sitemapUrls.length} URL(s).`);

    // ----- 2. Load all existing pages from Supabase --------------------------
    const { data: existingRows, error: fetchErr } = await getSupabase()
      .from('pages')
      .select('url, content');
    if (fetchErr) throw new Error(`Supabase select failed: ${fetchErr.message}`);

    const existingUrlSet = new Set(existingRows.map((r) => r.url));

    // Backfills fill the indexing budget first; remaining slots go to new URLs.
    const nullContentUrls = existingRows
      .filter((r) => !r.content)
      .map((r) => r.url)
      .slice(0, MAX_INDEXING_PER_RUN);

    // ----- 3. Determine which URLs are new -----------------------------------
    const remainingSlots = MAX_INDEXING_PER_RUN - nullContentUrls.length;
    const newUrls = sitemapUrls
      .filter((u) => !existingUrlSet.has(u) && isContentPage(u))
      .slice(0, remainingSlots);

    log.push(`Backfill queue: ${nullContentUrls.length}, new URLs: ${newUrls.length} (budget: ${MAX_INDEXING_PER_RUN}/run).`);

    // ----- 4. Scrape and insert new pages + populate sentences ---------------
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

        await populateSentences(url, title, content);
        log.push(`    Sentences populated.`);
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

        await populateSentences(url, title, content);
        log.push(`    Sentences populated.`);
      } catch (err) {
        stats.errors++;
        log.push(`    ERROR: ${err.message}`);
      }
      await sleep(SCRAPE_DELAY_MS);
    }

    // ----- 6. Auto-analyze pages that haven't been analyzed yet --------------
    // Fetch a large pool so the JS skip-pattern filter has enough to work with.
    const { data: unanalyzed, error: analyzeErr } = await getSupabase()
      .from('pages')
      .select('url, title, content')
      .is('analyzed_at', null)
      .not('content', 'is', null)
      .order('created_at', { ascending: false })
      .limit(100);

    if (analyzeErr) {
      log.push(`  Auto-analyze skipped: ${analyzeErr.message}`);
    } else {
      log.push(`  Auto-analyze: query returned ${(unanalyzed || []).length} unanalyzed page(s) with content.`);

      const toAnalyze = (unanalyzed || [])
        .filter((p) => isContentPage(p.url))
        .slice(0, MAX_ANALYSIS_PER_RUN);

      log.push(`  After skip-pattern filter: ${toAnalyze.length} queued, ${(unanalyzed || []).filter(p => !isContentPage(p.url)).length} excluded by URL pattern.`);
      if (toAnalyze.length > 0) {
        log.push(`  First candidate: ${toAnalyze[0].url}`);
      } else {
        log.push(`  Sample unanalyzed URLs: ${(unanalyzed || []).slice(0, 5).map(p => p.url).join(', ')}`);
      }

      for (const page of toAnalyze) {
        try {
          log.push(`  [ANALYZE] ${page.url}`);
          const analysis = await analyzeUrl(page.url, { title: page.title, content: page.content });
          await saveSuggestions(page.url, page.title, analysis.suggestions);

          const { error: markErr } = await getSupabase()
            .from('pages')
            .update({ analyzed_at: new Date().toISOString() })
            .eq('url', page.url);

          if (markErr) {
            log.push(`    WARNING: analyzed_at update failed for ${page.url}: ${markErr.message}`);
          } else {
            log.push(`    Marked analyzed: ${page.url}`);
          }

          stats.analyzed++;
          log.push(`    Saved ${analysis.suggestions.length} suggestion(s).`);
        } catch (err) {
          stats.errors++;
          log.push(`    ERROR: ${err.message}`);
        }
      }
    }

    // ----- 7. Process deferred link checks on pending suggestions ------------
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
