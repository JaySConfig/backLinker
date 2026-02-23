export const revalidate = 0;

import { getSupabase } from '@/lib/supabase';
import AnalyzeForm from './AnalyzeForm';
import SuggestionsList from './SuggestionsList';

async function getSuggestionGroups() {
  const { data, error } = await getSupabase()
    .from('suggestions')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[dashboard] Failed to fetch suggestions:', error.message);
    return [];
  }

  // Group by target_url, preserving the created_at order of first occurrence.
  const map = new Map();
  for (const row of data) {
    if (!map.has(row.target_url)) {
      map.set(row.target_url, {
        targetUrl: row.target_url,
        targetTitle: row.target_title,
        suggestions: [],
      });
    }
    map.get(row.target_url).suggestions.push(row);
  }

  return [...map.values()];
}

export default async function Home() {
  const groups = await getSuggestionGroups();

  const totalPending = groups.reduce(
    (n, g) => n + g.suggestions.filter((s) => s.status === 'pending').length,
    0,
  );

  return (
    <main className="container">
      <h1>BackLinker</h1>
      <p className="subtitle">
        Paste a newly published post URL to find internal linking opportunities across your site.
      </p>

      <AnalyzeForm />

      <div className="dashboard-section">
        <div className="dashboard-header">
          <span className="dashboard-title">Saved Suggestions</span>
          {totalPending > 0 && (
            <span className="pending-badge">{totalPending} pending</span>
          )}
        </div>

        <SuggestionsList groups={groups} />
      </div>
    </main>
  );
}
