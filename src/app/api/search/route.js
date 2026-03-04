import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q')?.trim();

  if (!q || q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  const { data, error } = await getSupabase()
    .from('sentences')
    .select('page_url, page_title, sentence')
    .ilike('sentence', `%${q}%`)
    .order('page_url')
    .limit(100);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ results: data ?? [] });
}
