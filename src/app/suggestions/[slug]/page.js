export const revalidate = 0;

import Link from 'next/link';
import { getSupabase } from '@/lib/supabase';
import SuggestionsDetail from './SuggestionsDetail';

async function getSuggestions(targetUrl) {
  const { data, error } = await getSupabase()
    .from('suggestions')
    .select('*')
    .eq('target_url', targetUrl)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[suggestions page] Failed to fetch:', error.message);
    return [];
  }

  return data;
}

export default async function SuggestionsPage({ params }) {
  const { slug } = await params;
  const targetUrl = decodeURIComponent(slug);
  const suggestions = await getSuggestions(targetUrl);
  const targetTitle = suggestions[0]?.target_title || targetUrl;
  const pendingCount = suggestions.filter((s) => s.status === 'pending').length;

  return (
    <main className="container">
      <Link href="/" className="back-link">← All pages</Link>

      <div className="target-header">
        <div className="target-header-top">
          <h1 className="target-title">{targetTitle}</h1>
          {pendingCount > 0 && (
            <span className="pending-badge">{pendingCount} pending</span>
          )}
        </div>
        <a
          href={targetUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="target-url"
        >
          {targetUrl}
        </a>
      </div>

      {suggestions.length === 0 ? (
        <div className="no-suggestions">No suggestions for this page yet.</div>
      ) : (
        <SuggestionsDetail
          suggestions={suggestions}
          targetUrl={targetUrl}
          targetTitle={targetTitle}
        />
      )}
    </main>
  );
}
