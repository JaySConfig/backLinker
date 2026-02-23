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
 * Runs the keyword extraction and candidate-finding pipeline for a URL.
 * Saves all Groq-confirmed suggestions immediately as pending WITHOUT
 * checking whether the source page already links to the target — that
 * slower per-page check is deferred to processLinkChecks().
 *
 * Returns: { newPostTitle, primary, variations, suggestions }
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

  const suggestions = await confirmSuggestions(
    newPostTitle,
    newPostContent.slice(0, 500),
    candidates.slice(0, 15),
  );

  return { newPostTitle, primary, variations, suggestions };
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
      // Source page unreachable — mark checked so we don't retry indefinitely
      await getSupabase().from('suggestions').update({ link_checked: true }).eq('id', s.id);
      console.log(`  ? kept (fetch failed): ${s.source_url} — ${err.message}`);
    }
  }

  console.log(`[processLinkChecks] Done: ${pending.length} checked, ${filtered} filtered.`);
  return { processed: pending.length, filtered };
}
