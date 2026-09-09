import { useEffect, useState } from 'react';
import type { Mention } from '@ourcrowd/core';
import { api, type CompanyDetailResponse } from '../lib/api';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function MentionRow({ mention }: { mention: Mention }) {
  const irrelevant = mention.relevance === 'irrelevant';
  return (
    <div className={`mention${irrelevant ? ' irrelevant' : ''}`}>
      <div className="mention-head">
        <span className={`tag ${mention.sentiment}`}>{mention.sentiment}</span>
        <a href={mention.url} target="_blank" rel="noreferrer noopener">
          {mention.title}
        </a>
      </div>
      <div className="sub">
        {formatDate(mention.publishedAt)}
        {mention.source ? ` · ${mention.source}` : ''}
        {irrelevant ? ' · filtered as not about this company' : ''}
      </div>
      {mention.reasoning && <div className="reason">{mention.reasoning}</div>}
    </div>
  );
}

/**
 * Detail panel for one company. Relevant mentions come first; the ones the
 * model filtered out are still shown, dimmed, so a reviewer can audit the
 * filter rather than having to trust it.
 */
export function CompanyDrawer({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const [data, setData] = useState<CompanyDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    api
      .company(companyId)
      .then((result) => {
        if (active) setData(result);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [companyId]);

  // Escape closes the drawer — expected for anything modal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const relevant = data?.mentions.filter((m) => m.relevance === 'relevant') ?? [];
  const filtered = data?.mentions.filter((m) => m.relevance === 'irrelevant') ?? [];

  return (
    <div className="drawer-backdrop" onClick={onClose} role="presentation">
      <div
        className="drawer"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={data ? `${data.company.name} press coverage` : 'Company press coverage'}
      >
        <div className="drawer-head">
          <h2>{data?.company.name ?? 'Loading…'}</h2>
          <button className="close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {data && (
          <p className="muted" style={{ marginTop: 0 }}>
            {data.status.label} · {data.status.quarterMentionCount} mention
            {data.status.quarterMentionCount === 1 ? '' : 's'} this quarter
            {data.company.aliases?.length ? ` · formerly ${data.company.aliases.join(', ')}` : ''}
          </p>
        )}

        {error && <div className="state error">Could not load this company: {error}</div>}
        {!data && !error && <div className="state">Loading…</div>}

        {data && relevant.length === 0 && filtered.length === 0 && (
          <div className="state">No press coverage found for this company.</div>
        )}

        {relevant.map((mention) => (
          <MentionRow key={mention.id} mention={mention} />
        ))}

        {filtered.length > 0 && (
          <>
            <h3 style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--muted)', marginTop: 22 }}>
              Filtered out ({filtered.length})
            </h3>
            {filtered.map((mention) => (
              <MentionRow key={mention.id} mention={mention} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
