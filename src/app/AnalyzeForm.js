'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const STEPS = [
  'Fetching page content…',
  'Extracting keywords with Groq…',
  'Searching indexed pages in Supabase…',
  'Confirming suggestions with Groq…',
];

export default function AnalyzeForm() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function handleAnalyze(e) {
    e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    setError('');
    setResult(null);
    setStepIndex(0);

    const interval = setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
    }, 2000);

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unknown error');
      setResult(data);
      // Refresh server component data so the dashboard shows the new suggestions.
      router.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      clearInterval(interval);
      setLoading(false);
    }
  }

  return (
    <section className="analyze-section">
      <form className="input-row" onSubmit={handleAnalyze}>
        <input
          type="url"
          placeholder="https://yourblog.com/new-post"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
          disabled={loading}
        />
        <button type="submit" disabled={loading || !url.trim()}>
          {loading ? 'Analysing…' : 'Find Backlinks'}
        </button>
      </form>

      {error && <div className="error-banner">{error}</div>}

      {loading && (
        <div className="loader">
          <div className="spinner" />
          <span className="step-label">{STEPS[stepIndex]}</span>
        </div>
      )}

      {result && !loading && (
        <div className="inline-results">
          <div className="keywords-section">
            <h2>Detected Keywords — {result.newPostTitle}</h2>
            <span className="keyword-primary">{result.primary}</span>
            {result.variations?.map((v) => (
              <span key={v} className="keyword-variation">{v}</span>
            ))}
          </div>

          <div className="suggestions-header">
            {result.suggestions?.length > 0
              ? `${result.suggestions.length} Backlink Suggestion${result.suggestions.length !== 1 ? 's' : ''} — saved to dashboard`
              : 'No backlink suggestions found'}
          </div>

          {result.suggestions?.map((s, i) => (
            <div key={i} className="suggestion-card">
              <div className="source-title">{s.sourceTitle}</div>
              <div className="source-url">
                <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer">
                  {s.sourceUrl}
                </a>
              </div>
              <div className="anchor-label">
                Suggested anchor text
                {s.anchorSource === 'variation' && (
                  <span className="anchor-badge">variation</span>
                )}
              </div>
              <div className="anchor-text">"{s.suggestedAnchorText}"</div>
              <div className="context-sentence">{s.context}</div>
              <div className="reason">{s.reason}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
