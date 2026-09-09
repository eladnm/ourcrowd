import type {
  Company,
  Mention,
  CompanyStatus,
  MentionStatusLevel,
  Sentiment,
} from './types.ts';

/** Day thresholds separating the mention-status buckets. */
export const STATUS_THRESHOLDS = {
  active: 7,
  recent: 30,
  stale: 90,
} as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days between two instants, floored — "yesterday" is 1 regardless of
 * clock time. Negative gaps (a feed post-dated into the future) clamp to 0.
 */
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY));
}

export function statusFromDays(days: number | null): MentionStatusLevel {
  if (days === null) return 'none';
  if (days <= STATUS_THRESHOLDS.active) return 'active';
  if (days <= STATUS_THRESHOLDS.recent) return 'recent';
  if (days <= STATUS_THRESHOLDS.stale) return 'stale';
  return 'dormant';
}

export function statusLabel(days: number | null): string {
  if (days === null) return 'no coverage found';
  if (days === 0) return 'last mentioned today';
  if (days === 1) return 'last mentioned yesterday';
  return `last mentioned ${days} days ago`;
}

/** Start of the trailing 90-day window ("last quarter") ending at `now`. */
export function quarterStart(now: Date): Date {
  return new Date(now.getTime() - STATUS_THRESHOLDS.stale * MS_PER_DAY);
}

export function isWithinQuarter(mention: { publishedAt: string }, now: Date): boolean {
  const published = new Date(mention.publishedAt);
  return published >= quarterStart(now) && published <= now;
}

/**
 * Roll a company's mentions up into its dashboard status row.
 *
 * Only mentions the classifier judged relevant are counted: an irrelevant hit
 * (a different company sharing the name) must not make a dormant company look
 * active. `mentions` may cover any time range; the quarter filter is applied
 * here so callers can pass everything they have.
 */
export function computeCompanyStatus(
  company: Company,
  mentions: Mention[],
  now: Date = new Date(),
): CompanyStatus {
  const relevant = mentions.filter(
    (m) => m.companyId === company.id && m.relevance === 'relevant',
  );

  const lastMentionedAt = relevant.reduce<string | null>((latest, m) => {
    if (new Date(m.publishedAt) > now) return latest; // ignore future-dated
    if (!latest || new Date(m.publishedAt) > new Date(latest)) return m.publishedAt;
    return latest;
  }, null);

  const daysSinceLastMention = lastMentionedAt
    ? daysBetween(new Date(lastMentionedAt), now)
    : null;

  const inQuarter = relevant.filter((m) => isWithinQuarter(m, now));
  const sentimentBreakdown: Record<Sentiment, number> = {
    positive: 0,
    negative: 0,
    neutral: 0,
  };
  for (const mention of inQuarter) sentimentBreakdown[mention.sentiment]++;

  return {
    companyId: company.id,
    companyName: company.name,
    lastMentionedAt,
    daysSinceLastMention,
    status: statusFromDays(daysSinceLastMention),
    label: statusLabel(daysSinceLastMention),
    quarterMentionCount: inQuarter.length,
    sentimentBreakdown,
  };
}
