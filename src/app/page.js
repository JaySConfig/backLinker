export const revalidate = 0;

import Link from 'next/link';
import { getSupabase } from '@/lib/supabase';

async function getPageSummaries() {
  const { data, error } = await getSupabase()
    .from('suggestions')
    .select('target_url, target_title, status')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[dashboard] Failed to fetch suggestions:', error.message);
    return [];
  }

  const map = new Map();
  for (const row of data) {
    if (!map.has(row.target_url)) {
      map.set(row.target_url, {
        targetUrl: row.target_url,
        targetTitle: row.target_title,
        pending: 0,
        total: 0,
      });
    }
    const entry = map.get(row.target_url);
    entry.total++;
    if (row.status === 'pending') entry.pending++;
  }

  // Sort: pages with pending suggestions first, then by total count.
  return [...map.values()].sort((a, b) => b.pending - a.pending || b.total - a.total);
}

export default async function Home() {
  const pages = await getPageSummaries();
  const totalPending = pages.reduce((n, p) => n + p.pending, 0);

  return (
    <main className="container">
      <div className="dashboard-header">
        <h1>BackLinker</h1>
        {totalPending > 0 && (
          <span className="pending-badge">{totalPending} pending</span>
        )}
      </div>
      <p className="subtitle">Internal linking suggestions grouped by target page.</p>

      {pages.length === 0 ? (
        <div className="no-suggestions">
          No suggestions yet. The cron will populate this automatically.
        </div>
      ) : (
        <div className="page-list">
          {pages.map((p) => (
            <Link
              key={p.targetUrl}
              href={`/suggestions/${encodeURIComponent(p.targetUrl)}`}
              className="page-card"
            >
              <div className="page-card-body">
                <span className="page-card-title">{p.targetTitle || p.targetUrl}</span>
                <span className="page-card-url">{p.targetUrl}</span>
              </div>
              <div className="page-card-meta">
                {p.pending > 0 ? (
                  <span className="pending-badge">{p.pending} pending</span>
                ) : (
                  <span className="all-done-badge">done</span>
                )}
                <span className="page-card-arrow">→</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
