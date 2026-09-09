/** Domain types shared by the collector, classifier, API and dashboard. */

export type Sentiment = 'positive' | 'negative' | 'neutral';

/** Why a mention was excluded from the dashboard, if it was. */
export type RelevanceVerdict = 'relevant' | 'irrelevant';

export interface Company {
  id: string;
  name: string;
  /** Former names / trading names. Also searched, and used to match text. */
  aliases?: string[];
  domain?: string;
  sector?: string;
  /**
   * Overrides the default `"<name>"` news query. Set for companies whose name
   * is a common English word (Shield, Peak, Wave, Silo...) where the bare name
   * returns mostly unrelated coverage.
   */
  searchQuery?: string;
}

/** A news item as collected, before the LLM has looked at it. */
export interface RawMention {
  /** Stable hash of company + resolved URL: the dedupe key across runs. */
  id: string;
  companyId: string;
  title: string;
  /** Feed summary. Google News gives a short HTML snippet, not full text. */
  snippet: string;
  url: string;
  source: string;
  /** ISO-8601. Publication date as reported by the feed. */
  publishedAt: string;
  /** ISO-8601. When our collector first saw it. */
  collectedAt: string;
}

/** The LLM's verdict on a single mention. */
export interface Classification {
  sentiment: Sentiment;
  relevance: RelevanceVerdict;
  /** Model's self-reported confidence, 0-1. Used to flag items for review. */
  confidence: number;
  /** One-line justification, shown in the dashboard on hover. */
  reasoning: string;
  model: string;
  classifiedAt: string;
}

/** A fully processed mention: collected, then classified. */
export interface Mention extends RawMention {
  sentiment: Sentiment;
  relevance: RelevanceVerdict;
  confidence: number;
  reasoning: string;
  model: string;
  classifiedAt: string;
}

/** How recently a company has appeared in the news. */
export type MentionStatusLevel =
  | 'active' // <= 7 days
  | 'recent' // <= 30 days
  | 'stale' // <= 90 days
  | 'dormant' // > 90 days
  | 'none'; // never seen

export interface CompanyStatus {
  companyId: string;
  companyName: string;
  lastMentionedAt: string | null;
  daysSinceLastMention: number | null;
  status: MentionStatusLevel;
  /** Human-readable, e.g. "last mentioned 3 days ago" / "no coverage found". */
  label: string;
  quarterMentionCount: number;
  sentimentBreakdown: Record<Sentiment, number>;
}
