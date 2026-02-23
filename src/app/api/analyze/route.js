import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { extractKeywords, confirmSuggestions } from '@/lib/groq';

/**
 * Fetches a URL and returns its plain-text body content.
 * Strips HTML tags to give Groq clean text.
 */
async function fetchPageContent(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BackLinker/1.0 (internal tool)' },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();

  // Extract <title>
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;

  // Strip scripts, styles, nav, header, footer to reduce noise
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return { title, content: stripped.slice(0, 15000) }; // cap at 15k chars for Groq
}

/**
 * Splits a block of text into individual sentences.
 */
function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30); // ignore very short fragments
}

/**
 * POST /api/analyze
 * Body: { url: string }
 *
 * Flow:
 *  1. Fetch the new post and extract keywords via Groq.
 *  2. Query Supabase pages for rows whose content matches any keyword.
 *  3. Find the exact sentences containing the keywords.
 *  4. Ask Groq to confirm and tidy the suggestions.
 *  5. Return the final list.
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const { url } = body;

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'A valid URL is required.' }, { status: 400 });
    }

    // --- Step 1: Fetch the new post and extract keywords ---
    const { title: newPostTitle, content: newPostContent } = await fetchPageContent(url);

    const { primary, variations } = await extractKeywords(newPostContent);
    const allKeywords = [primary, ...variations].map((k) => k.toLowerCase());

    // --- Step 2: Search Supabase for pages containing any of the keywords ---
    // We build an OR filter: content ilike '%keyword%' for each keyword.
    // Supabase JS uses .or() with comma-separated filter strings.
    const ilikeFilters = allKeywords
      .map((kw) => `content.ilike.%${kw}%`)
      .join(',');

    const { data: matchingPages, error: dbError } = await supabase
      .from('pages')
      .select('url, title, summary, content')
      .or(ilikeFilters)
      .neq('url', url) // exclude the new post itself if it's already indexed
      .limit(20);

    if (dbError) {
      throw new Error(`Supabase query failed: ${dbError.message}`);
    }

    if (!matchingPages || matchingPages.length === 0) {
      return NextResponse.json({
        newPostTitle,
        primary,
        variations,
        suggestions: [],
        message: 'No matching pages found in the index.',
      });
    }

    // --- Step 3: Extract the specific sentences containing the keywords ---
    const candidates = [];

    for (const page of matchingPages) {
      if (!page.content) continue;
      const sentences = splitSentences(page.content);

      for (const sentence of sentences) {
        const lowerSentence = sentence.toLowerCase();
        const matched = allKeywords.some((kw) => lowerSentence.includes(kw));
        if (matched) {
          candidates.push({
            sourceUrl: page.url,
            sourceTitle: page.title || page.url,
            sentence,
          });
        }
      }
    }

    // Cap candidates to avoid enormous Groq prompts
    const cappedCandidates = candidates.slice(0, 15);

    // --- Step 4: Ask Groq to confirm and polish the suggestions ---
    const newPostSummary = newPostContent.slice(0, 500);
    const suggestions = await confirmSuggestions(newPostTitle, newPostSummary, cappedCandidates);

    return NextResponse.json({
      newPostTitle,
      primary,
      variations,
      suggestions,
    });
  } catch (err) {
    console.error('[/api/analyze]', err);
    return NextResponse.json({ error: err.message || 'Internal server error.' }, { status: 500 });
  }
}
