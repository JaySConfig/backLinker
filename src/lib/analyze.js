import { getSupabase } from './supabase';
import { extractKeywords, confirmSuggestions } from './groq';

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
    // Fallback for relative or malformed URLs
    return u
      .toLowerCase()
      .replace(/[?#].*$/, '')
      .replace(/^http:\/\//, 'https://')
      .replace(/^https:\/\/www\./, 'https://')
      .replace(/\/$/, '');
  }
}

// ---------------------------------------------------------------------------
// Page fetching
// ---------------------------------------------------------------------------

/**
 * Fetches a page and returns { title, content } as clean plain text.
 */
async function fetchPageContent(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BackLinker/1.0 (internal tool)' },
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
 * links to. Uses the URL constructor to resolve relative hrefs and strip
 * query strings before normalising.
 */
async function fetchSourceHrefs(sourceUrl) {
  const res = await fetch(sourceUrl, {
    headers: { 'User-Agent': 'BackLinker/1.0 (internal tool)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();

  const rawHrefs = [...html.matchAll(/href=["']([^"'\s]+)["']/gi)].map((m) => m[1]);
  return new Set(
    rawHrefs.flatMap((href) => {
      try {
        const parsed = new URL(href, sourceUrl);
        // origin + pathname strips query strings and fragments
        return [normalizeUrl(parsed.origin + parsed.pathname)];
      } catch {
        return [];
      }
    }),
  );
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30);
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

/**
 * Runs the full backlink analysis pipeline for a given URL.
 *
 * Returns: { newPostTitle, primary, variations, suggestions }
 *   suggestions: Array of { sourceUrl, sourceTitle, suggestedAnchorText,
 *                           anchorSource, context, reason }
 */
export async function analyzeUrl(url) {
  const { title: newPostTitle, content: newPostContent } = await fetchPageContent(url);

  const { primary, variations } = await extractKeywords(newPostContent);
  const allKeywords = [primary, ...variations].map((k) => k.toLowerCase());

  const ilikeFilters = allKeywords.map((kw) => `content.ilike.%${kw}%`).join(',');

  const { data: matchingPages, error: dbError } = await getSupabase()
    .from('pages')
    .select('url, title, summary, content')
    .or(ilikeFilters)
    .neq('url', url)
    .limit(20);

  if (dbError) throw new Error(`Supabase query failed: ${dbError.message}`);

  if (!matchingPages || matchingPages.length === 0) {
    return { newPostTitle, primary, variations, suggestions: [] };
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

  const confirmed = await confirmSuggestions(
    newPostTitle,
    newPostContent.slice(0, 500),
    candidates.slice(0, 15),
  );

  // For each confirmed suggestion, fetch the SOURCE page and check whether it
  // already contains a link to the TARGET (url). This is the correct direction:
  // we want to know "does [sourceUrl] already link to [url]?"
  const targetNormalized = normalizeUrl(url);
  console.log(`[analyze] Target URL normalised: ${targetNormalized}`);
  console.log(`[analyze] Checking ${confirmed.length} confirmed suggestion(s) for existing links…`);

  const suggestions = [];
  let filteredCount = 0;

  for (const s of confirmed) {
    try {
      const sourceHrefs = await fetchSourceHrefs(s.sourceUrl);
      const alreadyLinked = sourceHrefs.has(targetNormalized);
      console.log(
        `  ${alreadyLinked ? '✗ FILTERED' : '✓ kept   '} ${s.sourceUrl}` +
        (alreadyLinked ? ' — already links to target' : ''),
      );
      if (alreadyLinked) {
        filteredCount++;
      } else {
        suggestions.push(s);
      }
    } catch (err) {
      // If the source page can't be fetched, keep the suggestion rather than
      // silently dropping it.
      console.log(`  ? kept    ${s.sourceUrl} — could not fetch source (${err.message})`);
      suggestions.push(s);
    }
  }

  console.log(
    `[analyze] Result: ${confirmed.length} confirmed → ${suggestions.length} kept, ${filteredCount} filtered (already linked).`,
  );

  return { newPostTitle, primary, variations, suggestions };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Upserts a list of suggestions into the Supabase suggestions table.
 * Re-analyzing the same URL will update existing rows rather than duplicate them.
 */
export async function saveSuggestions(targetUrl, targetTitle, suggestions) {
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

  const { error } = await getSupabase()
    .from('suggestions')
    .upsert(rows, { onConflict: 'target_url,source_url' });

  if (error) console.error('[saveSuggestions] Supabase upsert failed:', error.message);
}
