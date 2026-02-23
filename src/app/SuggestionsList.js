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

function SuggestionCard({ suggestion: initial }) {
  const [status, setStatus] = useState(initial.status);
  const [busy, setBusy] = useState(false);

  async function handle(newStatus) {
    setBusy(true);
    try {
      await updateStatus(initial.id, newStatus);
      setStatus(newStatus);
    } catch {
      // silently keep existing status on error
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`suggestion-card ${status !== 'pending' ? `card-${status}` : ''}`}>
      <div className="source-title">{initial.source_title}</div>
      <div className="source-url">
        <a href={initial.source_url} target="_blank" rel="noopener noreferrer">
          {initial.source_url}
        </a>
      </div>
      <div className="anchor-label">
        Suggested anchor text
        {initial.anchor_source === 'variation' && (
          <span className="anchor-badge">variation</span>
        )}
      </div>
      <div className="anchor-text">"{initial.suggested_anchor_text}"</div>
      <div className="context-sentence">{initial.context}</div>
      <div className="reason">{initial.reason}</div>

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

export default function SuggestionsList({ groups }) {
  if (groups.length === 0) {
    return (
      <div className="no-suggestions">
        No suggestions yet. Paste a URL above to find backlink opportunities.
      </div>
    );
  }

  return (
    <div className="dashboard-groups">
      {groups.map((group) => (
        <div key={group.targetUrl} className="target-group">
          <div className="target-header">
            <div className="target-title">{group.targetTitle || group.targetUrl}</div>
            <a
              className="target-url"
              href={group.targetUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {group.targetUrl}
            </a>
            <span className="suggestion-count">
              {group.suggestions.length} suggestion{group.suggestions.length !== 1 ? 's' : ''}
            </span>
          </div>
          {group.suggestions.map((s) => (
            <SuggestionCard key={s.id} suggestion={s} />
          ))}
        </div>
      ))}
    </div>
  );
}
