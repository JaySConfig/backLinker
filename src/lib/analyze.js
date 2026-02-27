import { getSupabase } from './supabase';
import { extractKeywordsExpanded } from './groq';

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Canonicalises a URL for reliable equality checks.
 * Uses the URL constructor to strip query strings and fragments, then
 * normalises scheme (http→https), www prefix, and trailing slash.
 */
export function normalizeUrl(u) {
  try {
    const parsed = new URL(u);
    return (parsed.origin + parsed.pathname)
      .toLowerCase()
      .replace(/^http:\/\//, 'https://')
      .replace(/^https:\/\/www\./, 'https://')
      .replace(/\/$/, '');
  } catch {
    return u
      .toLowerCase()
      .replace(/[?#].*$/, '')
      .replace(/^http:\/\//, 'https://')
      .replace(/^https:\/\/www\./, 'https://')
      .replace(/\/$/, '');
  }
}

// URLs matching these patterns are excluded from both source and target roles in suggestions.
const SKIP_PATTERNS = [
  '/sitemap',
  '/category/',
  '/author/',
  '/tag/',
  '/blog/',
  '/page/',
  '/contributors/',
  '/privacy-policy',
  '/terms-and-conditions',
  '/newsletter-sign-up',
  '/lipedema-quiz',
  '/homeold',
  '/advertise-with-us',
  '/lipedema-photos',
  '/lipedema-before-and-after',
];
export const isContentPage = (url) => !SKIP_PATTERNS.some((p) => url.includes(p));

// ---------------------------------------------------------------------------
// Page fetching
// ---------------------------------------------------------------------------

/**
 * Fetches a page and returns { title, content } as clean plain text.
 */
async function fetchPageContent(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BacklinkerBot/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
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

/**
 * Fetches a source page and returns the Set of normalised URLs it already
 * links to. Exported so it can be used by the process-suggestions route.
 */
export async function fetchSourceHrefs(sourceUrl) {
  const res = await fetch(sourceUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BacklinkerBot/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();

  const rawHrefs = [...html.matchAll(/href=["']([^"'\s]+)["']/gi)].map((m) => m[1]);
  return new Set(
    rawHrefs.flatMap((href) => {
      try {
        const parsed = new URL(href, sourceUrl);
        return [normalizeUrl(parsed.origin + parsed.pathname)];
      } catch {
        return [];
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Sentence helpers
// ---------------------------------------------------------------------------

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && s.split(' ').length >= 7);
}

/**
 * Splits a page's content into sentences and stores them in the sentences
 * table. Deletes existing rows for the page first so re-indexing is safe.
 */
export async function populateSentences(pageUrl, pageTitle, content) {
  if (!content) return;
  const sentences = splitSentences(content);
  if (!sentences.length) return;

  // Replace any existing sentences for this page.
  await getSupabase().from('sentences').delete().eq('page_url', pageUrl);

  const rows = sentences.map((sentence) => ({ page_url: pageUrl, page_title: pageTitle, sentence }));
  const { error } = await getSupabase().from('sentences').insert(rows);
  if (error) console.error(`[populateSentences] Insert failed for ${pageUrl}:`, error.message);
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

/**
 * Runs the full backlink analysis pipeline for a URL.
 *
 * If preloaded is provided ({ title, content }), the page is not re-fetched —
 * useful when the cron already has the content in memory.
 *
 * Returns: { newPostTitle, keywords, suggestions }
 *   suggestions: Array of { sourceUrl, sourceTitle, suggestedAnchorText,
 *                           anchorSource, context, reason }
 */
export async function analyzeUrl(url, preloaded = null) {
  const { title: newPostTitle, content: newPostContent } = preloaded ?? await fetchPageContent(url);

  // Step 1: Get or generate keyword variations for this target page.
  // Keywords are stored in the pages table so Groq is only called once per page ever.
  let keywords;
  const { data: pageRow } = await getSupabase()
    .from('pages')
    .select('keywords')
    .eq('url', url)
    .single();

  if (pageRow?.keywords?.length) {
    keywords = pageRow.keywords;
    console.log(`[analyzeUrl] Using ${keywords.length} cached keywords for ${url}`);
  } else {
    keywords = await extractKeywordsExpanded(newPostTitle);
    const { error: kwErr } = await getSupabase()
      .from('pages')
      .update({ keywords })
      .eq('url', url);
    if (kwErr) console.error(`[analyzeUrl] Failed to cache keywords: ${kwErr.message}`);
    console.log(`[analyzeUrl] Generated and cached ${keywords.length} keywords for ${url}`);
  }

  // Step 2: Search the sentences table for keyword matches across all other pages.
  const ilikeFilters = keywords.map((kw) => `sentence.ilike.%${kw}%`).join(',');

  const { data: matchingSentences, error: dbError } = await getSupabase()
    .from('sentences')
    .select('page_url, page_title, sentence, existing_links')
    .or(ilikeFilters)
    .neq('page_url', url)
    .limit(200);

  if (dbError) throw new Error(`Supabase query failed: ${dbError.message}`);
  if (!matchingSentences?.length) return { newPostTitle, keywords, suggestions: [] };

  // Step 3: Filter non-content pages and pick one sentence per source page.
  // Anchor text is the first keyphrase that appears in the sentence (longest first).
  // Keywords are already specific title-derived phrases — no extra filtering needed.
  const lowerKeywords = keywords
    .map((kw) => kw.toLowerCase().trim())
    .sort((a, b) => b.length - a.length); // longest first for anchor text priority

  const targetNormalized = normalizeUrl(url);
  const seenSources = new Set();
  const suggestions = [];

  for (const s of matchingSentences) {
    if (!isContentPage(s.page_url)) continue;
    if (seenSources.has(s.page_url)) continue;

    // Skip if the target URL is already linked within this sentence.
    if (s.existing_links?.includes(targetNormalized)) continue;

    const lowerSentence = s.sentence.toLowerCase();
    const anchorText = lowerKeywords.find((kw) => lowerSentence.includes(kw));

    // Skip this sentence entirely if no valid multi-word anchor text found.
    if (!anchorText) continue;

    seenSources.add(s.page_url);
    suggestions.push({
      sourceUrl: s.page_url,
      sourceTitle: s.page_title || s.page_url,
      suggestedAnchorText: anchorText,
      anchorSource: 'keyword',
      context: s.sentence,
      reason: 'Keyword match in existing sentence.',
    });

    if (suggestions.length >= 30) break;
  }

  return { newPostTitle, keywords, suggestions };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Upserts a list of suggestions into the Supabase suggestions table.
 * Re-analyzing the same URL updates existing rows rather than duplicating.
 * link_checked defaults to false so processLinkChecks() will pick them up.
 */
export async function saveSuggestions(targetUrl, targetTitle, suggestions) {
  if (!suggestions.length) return;

  // Deduplicate by source_url — the upsert constraint is (target_url, source_url)
  // and Postgres will error if the same pair appears twice in one batch.
  const seenSources = new Set();
  const unique = suggestions.filter((s) => {
    if (seenSources.has(s.sourceUrl)) return false;
    seenSources.add(s.sourceUrl);
    return true;
  });

  const rows = unique.map((s) => ({
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

  const { error } = await getSupabase()
    .from('suggestions')
    .upsert(rows, { onConflict: 'target_url,source_url' });

  if (error) console.error('[saveSuggestions] Supabase upsert failed:', error.message);
}

// ---------------------------------------------------------------------------
// Deferred link-check filtering
// ---------------------------------------------------------------------------

/**
 * Processes a batch of pending, unchecked suggestions.
 * For each one, fetches the source page and checks whether it already links
 * to the target. Already-linked suggestions are deleted; clean ones have
 * link_checked set to true so they won't be processed again.
 *
 * Returns: { processed, filtered }
 */
export async function processLinkChecks(batchSize = 3) {
  const { data: pending, error } = await getSupabase()
    .from('suggestions')
    .select('id, source_url, target_url')
    .eq('status', 'pending')
    .eq('link_checked', false)
    .order('created_at', { ascending: true })
    .limit(batchSize);

  if (error) throw new Error(`Supabase query failed: ${error.message}`);
  if (!pending?.length) {
    console.log('[processLinkChecks] No unchecked pending suggestions.');
    return { processed: 0, filtered: 0 };
  }

  console.log(`[processLinkChecks] Checking ${pending.length} suggestion(s)…`);
  let filtered = 0;

  for (const s of pending) {
    const targetNormalized = normalizeUrl(s.target_url);
    try {
      const sourceHrefs = await fetchSourceHrefs(s.source_url);
      if (sourceHrefs.has(targetNormalized)) {
        await getSupabase().from('suggestions').delete().eq('id', s.id);
        console.log(`  ✗ DELETED (already linked): ${s.source_url}`);
        filtered++;
      } else {
        await getSupabase().from('suggestions').update({ link_checked: true }).eq('id', s.id);
        console.log(`  ✓ kept: ${s.source_url}`);
      }
    } catch (err) {
      // Source page unreachable — mark checked so we don't retry indefinitely.
      await getSupabase().from('suggestions').update({ link_checked: true }).eq('id', s.id);
      console.log(`  ? kept (fetch failed): ${s.source_url} — ${err.message}`);
    }
  }

  console.log(`[processLinkChecks] Done: ${pending.length} checked, ${filtered} filtered.`);
  return { processed: pending.length, filtered };
}
