import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export async function POST(request) {
  const { targetUrl, targetTitle, sourceUrl, sourceTitle, suggestedAnchorText, context } =
    await request.json();

  if (!targetUrl || !sourceUrl) {
    return NextResponse.json({ error: 'targetUrl and sourceUrl are required' }, { status: 400 });
  }

  const { error } = await getSupabase()
    .from('suggestions')
    .upsert(
      {
        target_url: targetUrl,
        target_title: targetTitle || targetUrl,
        source_url: sourceUrl,
        source_title: sourceTitle,
        suggested_anchor_text: suggestedAnchorText || null,
        anchor_source: 'manual',
        context: context || null,
        reason: 'Manually added via search.',
        status: 'pending',
      },
      { onConflict: 'target_url,source_url' },
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
