import { useEffect, useMemo, useState } from 'react';
import type { CompanyStatus, MentionStatusLevel } from '@ourcrowd/core';
import { api, type CompaniesResponse, type SummaryResponse } from './lib/api';
import { CompanyDrawer } from './components/CompanyDrawer';

const STATUS_FILTERS: { key: MentionStatusLevel | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active (≤7d)' },
  { key: 'recent', label: 'Recent (≤30d)' },
  { key: 'stale', label: 'Stale (≤90d)' },
  { key: 'dormant', label: 'Dormant (>90d)' },
  { key: 'none', label: 'No coverage' },
];

type SortKey = 'name' | 'recency' | 'mentions' | 'negative';

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function SentimentBar({ sentiment }: { sentiment: SummaryResponse['sentiment'] }) {
  const total = sentiment.positive + sentiment.negative + sentiment.neutral;
  if (total === 0) return <p className="muted">No classified mentions in this quarter yet.</p>;

  const pct = (n: number) => (n / total) * 100;
  return (
    <>
      <div className="bar">
        {sentiment.positive > 0 && (
          <span className="pos" style={{ width: `${pct(sentiment.positive)}%` }}>
            {pct(sentiment.positive) > 8 ? sentiment.positive : ''}
          </span>
        )}
        {sentiment.neutral > 0 && (
          <span className="neu" style={{ width: `${pct(sentiment.neutral)}%` }}>
            {pct(sentiment.neutral) > 8 ? sentiment.neutral : ''}
          </span>
        )}
        {sentiment.negative > 0 && (
          <span className="neg" style={{ width: `${pct(sentiment.negative)}%` }}>
            {pct(sentiment.negative) > 8 ? sentiment.negative : ''}
          </span>
        )}
      </div>
      <div className="legend">
        <span><i style={{ background: 'var(--positive)' }} />Positive {sentiment.positive}</span>
        <span><i style={{ background: 'var(--neutral)' }} />Neutral {sentiment.neutral}</span>
        <span><i style={{ background: 'var(--negative)' }} />Negative {sentiment.negative}</span>
      </div>
    </>
  );
}

/** Stacked weekly columns across the quarter, scaled to the busiest week. */
function TrendChart({ weeks }: { weeks: SummaryResponse['weeks'] }) {
  const peak = Math.max(...weeks.map((w) => w.positive + w.negative + w.neutral), 1);
  const first = weeks[0]?.weekStart;
  const last = weeks[weeks.length - 1]?.weekStart;

  return (
    <>
      <div className="trend">
        {weeks.map((week) => {
          const total = week.positive + week.negative + week.neutral;
          const height = (total / peak) * 100;
          const title = `Week of ${week.weekStart}: ${total} mention${total === 1 ? '' : 's'} (${week.positive} positive, ${week.neutral} neutral, ${week.negative} negative)`;
          if (total === 0) return <div key={week.weekStart} className="week empty" title={title} />;
          return (
            <div key={week.weekStart} className="week" style={{ height: `${height}%` }} title={title}>
              {week.positive > 0 && <div className="seg pos" style={{ height: `${(week.positive / total) * 100}%` }} />}
              {week.neutral > 0 && <div className="seg neu" style={{ height: `${(week.neutral / total) * 100}%` }} />}
              {week.negative > 0 && <div className="seg neg" style={{ height: `${(week.negative / total) * 100}%` }} />}
            </div>
          );
        })}
      </div>
      <div className="trend-axis">
        <span>{first}</span>
        <span>{last}</span>
      </div>
    </>
  );
}

function StatusPill({ status }: { status: CompanyStatus }) {
  return (
    <span className={`status-pill status-${status.status}`}>
      <i />
      {status.label}
    </span>
  );
}

function MiniBar({ breakdown }: { breakdown: CompanyStatus['sentimentBreakdown'] }) {
  const total = breakdown.positive + breakdown.negative + breakdown.neutral;
  if (total === 0) return <span className="muted">—</span>;

  const width = (n: number) => `${Math.max((n / total) * 90, n > 0 ? 12 : 0)}px`;
  return (
    <div className="mini-bar" title={`${breakdown.positive} positive, ${breakdown.neutral} neutral, ${breakdown.negative} negative`}>
      {breakdown.positive > 0 && <span className="pos" style={{ width: width(breakdown.positive) }}>{breakdown.positive}</span>}
      {breakdown.neutral > 0 && <span className="neu" style={{ width: width(breakdown.neutral) }}>{breakdown.neutral}</span>}
      {breakdown.negative > 0 && <span className="neg" style={{ width: width(breakdown.negative) }}>{breakdown.negative}</span>}
    </div>
  );
}

export default function App() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [companies, setCompanies] = useState<CompaniesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<MentionStatusLevel | 'all'>('all');
  const [sort, setSort] = useState<SortKey>('recency');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.summary(), api.companies()])
      .then(([summaryData, companiesData]) => {
        setSummary(summaryData);
        setCompanies(companiesData);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const rows = useMemo(() => {
    if (!companies) return [];
    const needle = search.trim().toLowerCase();

    const filtered = companies.companies.filter((row) => {
      if (statusFilter !== 'all' && row.status !== statusFilter) return false;
      if (needle) {
        const inName = row.companyName.toLowerCase().includes(needle);
        const inAlias = row.aliases?.some((alias) => alias.toLowerCase().includes(needle));
        const inTicker = row.ticker?.toLowerCase() === needle;
        if (!inName && !inAlias && !inTicker) return false;
      }
      return true;
    });

    return [...filtered].sort((a, b) => {
      switch (sort) {
        case 'name':
          return a.companyName.localeCompare(b.companyName);
        case 'mentions':
          return b.quarterMentionCount - a.quarterMentionCount || a.companyName.localeCompare(b.companyName);
        case 'negative':
          return b.sentimentBreakdown.negative - a.sentimentBreakdown.negative || a.companyName.localeCompare(b.companyName);
        case 'recency':
        default: {
          // Companies with no coverage sort last rather than first.
          const aDays = a.daysSinceLastMention ?? Number.MAX_SAFE_INTEGER;
          const bDays = b.daysSinceLastMention ?? Number.MAX_SAFE_INTEGER;
          return aDays - bDays || a.companyName.localeCompare(b.companyName);
        }
      }
    });
  }, [companies, search, statusFilter, sort]);

  if (error) {
    return (
      <div className="app">
        <div className="state error">
          <p>Could not reach the API: {error}</p>
          <p className="muted">Start it with <code>pnpm api</code>, then reload.</p>
        </div>
      </div>
    );
  }

  if (!summary || !companies) {
    return <div className="app"><div className="state">Loading…</div></div>;
  }

  const { totals } = summary;
  const quarterFrom = new Date(summary.quarterStart).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1>OurCrowd Press Monitor</h1>
          <div className="meta">
            Quarter to date, since {quarterFrom} · classified locally with {summary.model}
          </div>
        </div>
        <div className="meta">Updated {new Date(summary.generatedAt).toLocaleString()}</div>
      </header>

      <div className="stats">
        <Stat label="Companies tracked" value={totals.companies} sub={`${totals.withCoverage} with coverage`} />
        <Stat label="Mentions this quarter" value={totals.quarterMentions} />
        <Stat
          label="Negative coverage"
          value={summary.sentiment.negative}
          sub={summary.sentiment.negative > 0 ? 'needs review' : 'none flagged'}
        />
        <Stat label="Active (≤7 days)" value={summary.statusBreakdown.active} />
        <Stat label="No coverage found" value={summary.statusBreakdown.none} />
      </div>

      <div className="panel">
        <h2>Sentiment mix this quarter</h2>
        <SentimentBar sentiment={summary.sentiment} />
      </div>

      <div className="panel">
        <h2>Coverage by week</h2>
        <TrendChart weeks={summary.weeks} />
      </div>

      <div className="controls">
        <input
          type="search"
          placeholder={`Search ${totals.companies} companies…`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search companies"
        />
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.key}
            className="chip"
            aria-pressed={statusFilter === filter.key}
            onClick={() => setStatusFilter(filter.key)}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="sortable" onClick={() => setSort('name')}>Company</th>
              <th className="sortable" onClick={() => setSort('recency')}>Mention status</th>
              <th className="sortable num" onClick={() => setSort('mentions')}>Quarter</th>
              <th className="sortable" onClick={() => setSort('negative')}>Sentiment</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.companyId} className="clickable" onClick={() => setSelected(row.companyId)}>
                <td className="company-name">{row.companyName}</td>
                <td><StatusPill status={row} /></td>
                <td className="num">{row.quarterMentionCount || <span className="muted">—</span>}</td>
                <td><MiniBar breakdown={row.sentimentBreakdown} /></td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="state">No companies match this filter.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="footnote">
        Showing {rows.length} of {totals.companies} companies. Click a row for its full coverage.
        {totals.filteredIrrelevant > 0 && (
          <>
            {' '}
            {totals.filteredIrrelevant} collected
            {totals.filteredIrrelevant === 1 ? ' item was' : ' items were'} filtered out by the model as not
            being about the tracked company.
          </>
        )}
      </p>

      {selected && <CompanyDrawer companyId={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
