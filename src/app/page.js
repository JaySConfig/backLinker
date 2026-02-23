'use client';

import { useState } from 'react';

const STEPS = [
  'Fetching page content…',
  'Extracting keywords with Groq…',
  'Searching indexed pages in Supabase…',
  'Confirming suggestions with Groq…',
];

export default function Home() {
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

    // Cycle through step labels every ~2 s while waiting
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
    } catch (err) {
      setError(err.message);
    } finally {
      clearInterval(interval);
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <h1>BackLinker</h1>
      <p className="subtitle">
        Paste the URL of a newly published blog post to find the best internal linking opportunities.
      </p>

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
        <>
          {/* Keywords */}
          <div className="keywords-section">
            <h2>Detected Keywords — {result.newPostTitle}</h2>
            <span className="keyword-primary">{result.primary}</span>
            {result.variations?.map((v) => (
              <span key={v} className="keyword-variation">
                {v}
              </span>
            ))}
          </div>

          {/* Suggestions */}
          <div className="suggestions-header">
            {result.suggestions?.length > 0
              ? `${result.suggestions.length} Backlink Suggestion${result.suggestions.length !== 1 ? 's' : ''}`
              : 'Backlink Suggestions'}
          </div>

          {result.message && !result.suggestions?.length && (
            <div className="no-suggestions">{result.message}</div>
          )}

          {result.suggestions?.length === 0 && !result.message && (
            <div className="no-suggestions">
              No strong backlink opportunities found in the current index.
            </div>
          )}

          {result.suggestions?.map((s, i) => (
            <div key={i} className="suggestion-card">
              <div className="source-title">{s.sourceTitle}</div>
              <div className="source-url">
                <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer">
                  {s.sourceUrl}
                </a>
              </div>
              <div className="anchor-label">Suggested anchor text</div>
              <div className="anchor-text">"{s.suggestedAnchorText}"</div>
              <div className="context-sentence">{s.context}</div>
              <div className="reason">{s.reason}</div>
            </div>
          ))}
        </>
      )}
    </main>
  );
}
