import { supabase } from './supabase';
import { extractKeywords, confirmSuggestions } from './groq';

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Canonicalises a URL for reliable equality checks.
 * Normalises scheme (http→https), www prefix, and trailing slash.
 * Query strings and fragments must be stripped before calling this.
 */
export function normalizeUrl(u) {
  return u
    .toLowerCase()
    .replace(/^http:\/\//, 'https://')
    .replace(/^https:\/\/www\./, 'https://')
    .replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// Page fetching
// ---------------------------------------------------------------------------

/**
 * Fetches a URL and returns:
 *   - title: page <title> text
 *   - content: stripped plain-text body (max 15 000 chars)
 *   - existingHrefs: Set of normalised absolute URLs already linked from the page
 */
async function fetchPageContent(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BackLinker/1.0 (internal tool)' },
  });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  const html = await res.text();

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;

  // Capture full href values (including query strings); the URL constructor
  // handles parsing so we can take only origin + pathname.
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

  console.log(`[analyze] ${existingHrefs.size} unique hrefs extracted from <${url}>`);
  console.log('[analyze] Sample extracted hrefs:', [...existingHrefs].slice(0, 15));

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
  const { title: newPostTitle, content: newPostContent, existingHrefs } = await fetchPageContent(url);

  const { primary, variations } = await extractKeywords(newPostContent);
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

  console.log('[analyze] Checking confirmed suggestions against existing hrefs:');
  const suggestions = confirmed.filter((s) => {
    const normalised = normalizeUrl(s.sourceUrl);
    const alreadyLinked = existingHrefs.has(normalised);
    console.log(`  ${alreadyLinked ? '✗ REMOVED' : '✓ kept  '} ${normalised}`);
    return !alreadyLinked;
  });
  console.log(
    `[analyze] ${confirmed.length} confirmed → ${suggestions.length} kept, ${confirmed.length - suggestions.length} removed.`,
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

  const { error } = await supabase
    .from('suggestions')
    .upsert(rows, { onConflict: 'target_url,source_url' });

  if (error) console.error('[saveSuggestions] Supabase upsert failed:', error.message);
}
