export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { processLinkChecks } from '@/lib/analyze';

/**
 * POST /api/process-suggestions
 *
 * Fetches a batch of pending, unchecked suggestions and runs the existing-link
 * check on each one. Already-linked suggestions are deleted; clean ones are
 * marked link_checked=true. Call this from the cron job or trigger it manually.
 *
 * Protected by CRON_SECRET when set.
 */
export async function POST(request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const result = await processLinkChecks(3);
    console.log(`[/api/process-suggestions] processed=${result.processed} filtered=${result.filtered}`);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error('[/api/process-suggestions] Error:', err.message);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
