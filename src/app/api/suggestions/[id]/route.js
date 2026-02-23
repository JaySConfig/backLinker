import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

const VALID_STATUSES = ['pending', 'accepted', 'dismissed'];

export async function PATCH(request, { params }) {
  const { id } = await params;
  const { status } = await request.json();

  if (!VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` }, { status: 400 });
  }

  const { error } = await getSupabase()
    .from('suggestions')
    .update({ status })
    .eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
