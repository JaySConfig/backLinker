'use client';

import { useState } from 'react';
import Link from 'next/link';

function highlight(sentence, keyword) {
  if (!keyword) return sentence;
  const idx = sentence.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx === -1) return sentence;
  return (
    <>
      {sentence.slice(0, idx)}
      <mark className="anchor-highlight">{sentence.slice(idx, idx + keyword.length)}</mark>
      {sentence.slice(idx + keyword.length)}
    </>
  );
}

export default function SearchPage() {
  const [targetUrl, setTargetUrl] = useState('');
  const [targetTitle, setTargetTitle] = useState('');
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState(null); // null = not searched yet
  const [searching, setSearching] = useState(false);
  const [anchorTexts, setAnchorTexts] = useState({});
  const [saved, setSaved] = useState({});
  const [saveErrors, setSaveErrors] = useState({});

  async function search() {
    const q = keyword.trim();
    if (!q) return;
    setSearching(true);
    setSaved({});
    setSaveErrors({});
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      const rows = data.results ?? [];
      setResults(rows);
      const initial = {};
      rows.forEach((_, i) => { initial[i] = q; });
      setAnchorTexts(initial);
    } finally {
      setSearching(false);
    }
  }

  async function addSuggestion(result, index) {
    const url = targetUrl.trim();
    if (!url) return;
    setSaveErrors((prev) => ({ ...prev, [index]: null }));
    try {
      const res = await fetch('/api/suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: url,
          targetTitle: targetTitle.trim() || url,
          sourceUrl: result.page_url,
          sourceTitle: result.page_title,
          suggestedAnchorText: anchorTexts[index] ?? keyword,
          context: result.sentence,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setSaveErrors((prev) => ({ ...prev, [index]: data.error ?? 'Failed to save' }));
      } else {
        setSaved((prev) => ({ ...prev, [index]: true }));
      }
    } catch {
      setSaveErrors((prev) => ({ ...prev, [index]: 'Network error' }));
    }
  }

  return (
    <main className="container">
      <Link href="/" className="back-link">← Dashboard</Link>

      <h1>Search Sentences</h1>
      <p className="subtitle">
        Find sentences across all indexed pages and manually create linking suggestions.
      </p>

      {/* Target page */}
      <div className="search-target-fields">
        <div className="search-field">
          <label className="search-label">Target URL <span className="search-label-hint">(the page you want to link to)</span></label>
          <input
            className="search-input"
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
            placeholder="https://lipedemaandme.com/your-page/"
          />
        </div>
        <div className="search-field">
          <label className="search-label">Target title <span className="search-label-hint">(optional)</span></label>
          <input
            className="search-input"
            value={targetTitle}
            onChange={(e) => setTargetTitle(e.target.value)}
            placeholder="Page title…"
          />
        </div>
      </div>

      {/* Keyword search */}
      <div className="search-row">
        <input
          className="search-input"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder="Search keyword or phrase…"
        />
        <button
          className="search-btn"
          onClick={search}
          disabled={searching || !keyword.trim()}
        >
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>

      {/* Results */}
      {results !== null && (
        <div className="search-results">
          {results.length === 0 ? (
            <div className="no-suggestions">No sentences found for "{keyword}".</div>
          ) : (
            <>
              <p className="results-count">{results.length} result(s) for "{keyword}"</p>
              {results.map((r, i) => (
                <div key={i} className="search-result-card">
                  <p className="result-sentence">{highlight(r.sentence, keyword)}</p>
                  <div className="result-source">
                    <span className="result-source-title">{r.page_title}</span>
                    <a
                      href={r.page_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="result-source-url"
                    >
                      {r.page_url}
                    </a>
                  </div>
                  <div className="result-actions">
                    <input
                      className="anchor-input"
                      value={anchorTexts[i] ?? keyword}
                      onChange={(e) =>
                        setAnchorTexts((prev) => ({ ...prev, [i]: e.target.value }))
                      }
                      placeholder="Anchor text"
                      disabled={saved[i]}
                    />
                    <button
                      className={`add-suggestion-btn ${saved[i] ? 'btn-saved' : ''}`}
                      onClick={() => addSuggestion(r, i)}
                      disabled={!targetUrl.trim() || saved[i]}
                    >
                      {saved[i] ? 'Saved ✓' : 'Add Suggestion'}
                    </button>
                  </div>
                  {saveErrors[i] && (
                    <p className="result-error">{saveErrors[i]}</p>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </main>
  );
}
