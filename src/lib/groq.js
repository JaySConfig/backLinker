import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * Generates a summary and keyword array for a scraped page.
 * Used by the daily cron indexer.
 *
 * Returns: { summary: string, keywords: string[] }
 */
export async function generatePageMetadata(title, content) {
  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content:
          'You are an SEO content analyst. Respond only with valid JSON — no markdown fences, no explanation.',
      },
      {
        role: 'user',
        content: `Analyse the page below and return a JSON object with two keys:
- "summary": a 2-3 sentence plain English summary of what the page is about (max 300 characters).
- "keywords": an array of 8-12 relevant keywords or short phrases (each 1-4 words).

Page title: "${title}"
Page content:
---
${content.slice(0, 8000)}
---`,
      },
    ],
  });

  const raw = response.choices[0].message.content.trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Failed to parse metadata JSON from Groq: ${raw}`);
  }
}

/**
 * Generates 2-3 exact keyphrases for a page based on its title alone.
 * These are the most specific phrases someone would naturally use when
 * referencing this page's topic in another article.
 * Results are cached in pages.keywords so Groq is called at most once per page.
 *
 * Returns: string[] (lowercase)
 */
export async function extractKeywordsExpanded(pageTitle) {
  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content:
          'You are an SEO expert. Respond only with valid JSON — no markdown fences, no explanation.',
      },
      {
        role: 'user',
        content: `Given this page title, return exactly 2-3 keyphrases that someone would naturally use when referencing this specific topic in another article. Extract them directly from the title — do not invent new phrases. All lowercase.

Rules:
- Use the most specific phrase from the title as the first entry
- For "X vs Y" or "X and Y" titles, also include a version with "and" instead of "vs" (or vice versa), and the secondary term alone if it stands on its own
- Never include generic single words like "lipedema" alone unless it is part of a longer phrase
- Return a JSON array of strings only

Examples:
- "Lipedema vs Lymphedema" → ["lipedema vs lymphedema", "lipedema and lymphedema", "lymphedema"]
- "Best Diet for Lipedema" → ["diet for lipedema", "lipedema diet"]
- "Can You Lose Weight With Lipedema" → ["lose weight with lipedema", "weight loss with lipedema"]
- "HRT and Lipedema" → ["hrt and lipedema", "hormone therapy and lipedema", "hrt"]

Page title: "${pageTitle}"`,
      },
    ],
  });

  const raw = response.choices[0].message.content.trim();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed.keywords ?? parsed;
  } catch {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Failed to parse keywords JSON from Groq: ${raw}`);
  }
}

/**
 * Given the plain-text content of a blog post, asks Groq to extract the
 * primary keyword and 5 natural variations.
 *
 * Returns: { primary: string, variations: string[] }
 */
export async function extractKeywords(pageContent) {
  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content:
          'You are an SEO expert. Respond only with valid JSON — no markdown fences, no explanation.',
      },
      {
        role: 'user',
        content: `Analyse the blog post below and return a JSON object with two keys:
- "primary": the single most important keyword or short phrase (2-4 words) that the post is about.
- "variations": an array of exactly 5 natural language variations of that keyword (different phrasings, synonyms, related terms someone might search for).

Blog post content:
---
${pageContent}
---`,
      },
    ],
  });

  const raw = response.choices[0].message.content.trim();
  try {
    return JSON.parse(raw);
  } catch {
    // Attempt to extract JSON substring if the model added surrounding text
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Failed to parse keyword JSON from Groq: ${raw}`);
  }
}

/**
 * Given the new post URL/title and a list of candidate backlink suggestions,
 * asks Groq to filter and polish them.
 *
 * candidates: Array of { sourceUrl, sourceTitle, sentence }
 * Returns: Array of { sourceUrl, sourceTitle, suggestedAnchorText, context, reason }
 */
export async function confirmSuggestions(newPostTitle, newPostSummary, candidates) {
  if (candidates.length === 0) return [];

  const candidateText = candidates
    .map(
      (c, i) =>
        `${i + 1}. Source: "${c.sourceTitle}" (${c.sourceUrl})\n   Sentence: "${c.sentence}"`,
    )
    .join('\n\n');

  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    temperature: 0.4,
    messages: [
      {
        role: 'system',
        content:
          'You are an internal linking specialist. Respond only with valid JSON — no markdown fences, no explanation.',
      },
      {
        role: 'user',
        content: `We have a newly published blog post:
Title: "${newPostTitle}"
Summary: "${newPostSummary}"

Below are candidate sentences from existing pages that might be good places to add an internal link back to the new post. For each candidate:
1. Decide if it is genuinely a good backlink opportunity (contextually relevant, natural placement).
2. If yes, choose anchor text following these rules:
   IMPORTANT — if the post title "${newPostTitle}" follows an "X vs Y" or "X and Y" pattern (e.g. "Lipedema vs Cellulite", "Diet and Exercise"), do NOT use the title or any title-like phrase as anchor text. Instead:
   - Use just the secondary term (the Y part) if it fits naturally in the sentence, OR
   - Use a descriptive prose phrase such as "the difference between X and Y" or "how X relates to Y".
   For all other titles, choose anchor text in this priority order:
   a. FIRST CHOICE — extract the most specific and descriptive phrase directly from the post title. Prefer a sub-phrase over the full title if a shorter excerpt fits more naturally.
   b. FALLBACK ONLY — if no phrase from the title can be woven in naturally, use a relevant keyword variation instead.
   The anchor text must always read like natural prose within the candidate sentence — never like a page title or heading.
3. If no, exclude it from the output.

Return a JSON array where each item has:
- "sourceUrl": string
- "sourceTitle": string
- "suggestedAnchorText": string  (the chosen anchor text, following the priority above)
- "anchorSource": either "title" or "variation"  (which option was used)
- "context": the original sentence (lightly tidied if needed)
- "reason": one sentence explaining the relevance

Candidates:
${candidateText}`,
      },
    ],
  });

  const raw = response.choices[0].message.content.trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Failed to parse suggestions JSON from Groq: ${raw}`);
  }
}
