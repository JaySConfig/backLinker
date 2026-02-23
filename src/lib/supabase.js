import { createClient } from '@supabase/supabase-js';

let _client = null;

/**
 * Returns the shared Supabase client, creating it on first call.
 * Lazy initialisation ensures env vars are only read at request time,
 * not during the Next.js build when they are unavailable.
 */
export function getSupabase() {
  if (!_client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.');
    }
    _client = createClient(url, key);
  }
  return _client;
}
