'use client';

import { useState } from 'react';

async function updateStatus(id, status) {
  const res = await fetch(`/api/suggestions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error('Failed to update status');
}

function HighlightedSentence({ sentence, anchorText }) {
  if (!sentence) return null;
  if (!anchorText) return <span>{sentence}</span>;

  const idx = sentence.toLowerCase().indexOf(anchorText.toLowerCase());
  if (idx === -1) return <span>{sentence}</span>;

  return (
    <span>
      {sentence.slice(0, idx)}
      <mark className="anchor-highlight">{sentence.slice(idx, idx + anchorText.length)}</mark>
      {sentence.slice(idx + anchorText.length)}
    </span>
  );
}

function SuggestionCard({ suggestion: initial, targetUrl, targetTitle }) {
  const [status, setStatus] = useState(initial.status);
  const [busy, setBusy] = useState(false);

  async function handle(newStatus) {
    setBusy(true);
    try {
      await updateStatus(initial.id, newStatus);
      setStatus(newStatus);
    } catch {
      // keep existing status on error
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`suggestion-card ${status !== 'pending' ? `card-${status}` : ''}`}>

      {/* TOP: source page where the link will be added */}
      <div className="card-endpoint card-source">
        <span className="endpoint-label">Add a link in</span>
        <span className="endpoint-title">{initial.source_title}</span>
        <a
          className="endpoint-url"
          href={initial.source_url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {initial.source_url}
        </a>
      </div>

      {/* MIDDLE: context sentence with anchor text highlighted */}
      <div className="card-sentence">
        <HighlightedSentence
          sentence={initial.context}
          anchorText={initial.suggested_anchor_text}
        />
      </div>

      {/* CONNECTOR */}
      <div className="card-connector">
        <span className="connector-line" />
        <span className="connector-arrow">↓</span>
        <span className="connector-line" />
      </div>

      {/* BOTTOM: target page being linked to */}
      <div className="card-endpoint card-target">
        <span className="endpoint-label">Linking to</span>
        <span className="endpoint-title">{targetTitle}</span>
        <a
          className="endpoint-url"
          href={targetUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {targetUrl}
        </a>
      </div>

      <div className="card-actions">
        {status === 'pending' && (
          <>
            <button
              className="action-btn btn-accept"
              onClick={() => handle('accepted')}
              disabled={busy}
            >
              Accept
            </button>
            <button
              className="action-btn btn-dismiss"
              onClick={() => handle('dismissed')}
              disabled={busy}
            >
              Dismiss
            </button>
          </>
        )}
        {status === 'accepted' && (
          <span className="status-badge status-accepted">Accepted</span>
        )}
        {status === 'dismissed' && (
          <button
            className="action-btn btn-restore"
            onClick={() => handle('pending')}
            disabled={busy}
          >
            Restore
          </button>
        )}
      </div>
    </div>
  );
}

export default function SuggestionsDetail({ suggestions, targetUrl, targetTitle }) {
  return (
    <div className="suggestions-list">
      {suggestions.map((s) => (
        <SuggestionCard
          key={s.id}
          suggestion={s}
          targetUrl={targetUrl}
          targetTitle={targetTitle}
        />
      ))}
    </div>
  );
}
