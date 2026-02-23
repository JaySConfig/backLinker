import { NextResponse } from 'next/server';
import { analyzeUrl, saveSuggestions } from '@/lib/analyze';

export async function POST(request) {
  try {
    const { url } = await request.json();

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'A valid URL is required.' }, { status: 400 });
    }

    const { newPostTitle, primary, variations, suggestions } = await analyzeUrl(url);

    // Persist to the dashboard; upserts so re-analyzing a URL refreshes existing rows.
    await saveSuggestions(url, newPostTitle, suggestions);

    return NextResponse.json({ newPostTitle, primary, variations, suggestions });
  } catch (err) {
    console.error('[/api/analyze]', err);
    return NextResponse.json({ error: err.message || 'Internal server error.' }, { status: 500 });
  }
}
