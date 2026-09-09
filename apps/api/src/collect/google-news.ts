import { XMLParser } from 'fast-xml-parser';
import { mentionId } from '@ourcrowd/core/node';
import type { Company, RawMention } from '@ourcrowd/core';
import { config } from '../config.ts';
import { log } from '../lib/logger.ts';

/**
 * News collection via Google News RSS.
 *
 * Why RSS and not a news API: it needs no key and no signup, so a reviewer can
 * clone the repo and run the pipeline immediately. The trade-offs are real and
 * documented in the README — headline + short snippet only (no article body),
 * Google-wrapped redirect URLs, and roughly 100 items per query.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

interface RssItem {
  title?: string;
  link?: string;
  pubDate?: string;
  description?: string;
  source?: string | { '#text'?: string };
}

/**
 * Former names shorter than this are classification hints only. OR-ing
 * "Edge" into Ludeo's query would drown the feed; "Safe Superintelligence"
 * or "ReWalk" are distinctive enough to search.
 */
const MIN_SEARCHABLE_ALIAS_LENGTH = 5;

/**
 * Build the query for a company. `searchQuery` wins when set (common-word
 * names). Otherwise the name is quoted as a phrase, distinctive aliases are
 * OR'd in, and a domain hint (e.g. lambda.ai) is appended so "Lambda" is not
 * just AWS Lambda / Lambda Legal. `when:{n}d` bounds the window server-side.
 */
export function buildQuery(company: Company, windowDays: number): string {
  if (company.searchQuery) return `${company.searchQuery} when:${windowDays}d`;

  const terms = [`"${company.name}"`];
  for (const alias of company.aliases ?? []) {
    if (alias.length >= MIN_SEARCHABLE_ALIAS_LENGTH) terms.push(`"${alias}"`);
  }
  const nameClause = terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`;
  const withDomain = company.domain ? `${nameClause} ${company.domain}` : nameClause;
  return `${withDomain} when:${windowDays}d`;
}

export function feedUrl(company: Company, windowDays: number): string {
  const query = encodeURIComponent(buildQuery(company, windowDays));
  return `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
}

/** Google wraps the publisher name in a <source> element with a url attribute. */
function extractSource(item: RssItem): string {
  if (typeof item.source === 'string') return item.source;
  if (item.source && typeof item.source === 'object') return item.source['#text'] ?? '';
  return '';
}

/** Feed descriptions are HTML fragments; the dashboard wants plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Some feed items are shaped `Headline - Publisher`. Trim the trailing
 * publisher so titles read cleanly in the dashboard.
 */
function cleanTitle(title: string, source: string): string {
  if (!source) return title.trim();
  const suffix = ` - ${source}`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title.trim();
}

export function parseFeed(xml: string, company: Company, now: Date): RawMention[] {
  const parsed = parser.parse(xml) as { rss?: { channel?: { item?: RssItem | RssItem[] } } };
  const rawItems = parsed.rss?.channel?.item;
  if (!rawItems) return [];

  // A single-item feed parses to an object rather than an array.
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  const collectedAt = now.toISOString();

  const mentions: RawMention[] = [];
  for (const item of items) {
    if (!item.title || !item.link) continue;

    const published = item.pubDate ? new Date(item.pubDate) : null;
    if (!published || Number.isNaN(published.getTime())) {
      log.warn(`${company.name}: skipping item with unparseable date: ${item.title}`);
      continue;
    }

    const source = extractSource(item);
    mentions.push({
      id: mentionId(company.id, item.link),
      companyId: company.id,
      title: cleanTitle(item.title, source),
      snippet: item.description ? stripHtml(item.description) : '',
      url: item.link,
      source,
      publishedAt: published.toISOString(),
      collectedAt,
    });
  }
  return mentions;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch one company's feed, retrying on transient failures with a backoff.
 * Throws only once retries are exhausted; the caller isolates per company.
 */
async function fetchWithRetry(url: string, attempts = 3): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          // Google News returns an error page to an unidentified client.
          'User-Agent':
            'Mozilla/5.0 (compatible; OurCrowdPressMonitor/1.0; +https://ourcrowd.com)',
          Accept: 'application/rss+xml, application/xml, text/xml',
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 429) throw new Error('rate limited (429)');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const backoff = config.collection.fetchDelayMs * 2 ** attempt;
        log.warn(
          `fetch attempt ${attempt}/${attempts} failed (${String(error)}), retrying in ${backoff}ms`,
        );
        await sleep(backoff);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export interface CollectionResult {
  mentions: RawMention[];
  errors: { companyId: string; message: string }[];
}

/**
 * Collect mentions for every company, sequentially and politely.
 *
 * Sequential on purpose: Google News throttles aggressively, and a run that
 * finishes slowly beats one that gets rate-limited into gaps. One company's
 * failure is recorded and the run continues.
 */
export async function collectAll(
  companies: Company[],
  options: { windowDays?: number; now?: Date; onProgress?: (done: number, total: number) => void } = {},
): Promise<CollectionResult> {
  const windowDays = options.windowDays ?? config.collection.windowDays;
  const now = options.now ?? new Date();
  const mentions: RawMention[] = [];
  const errors: CollectionResult['errors'] = [];

  for (const [index, company] of companies.entries()) {
    try {
      const xml = await fetchWithRetry(feedUrl(company, windowDays));
      const found = parseFeed(xml, company, now);
      mentions.push(...found);
      log.info(`${String(index + 1).padStart(3)}/${companies.length} ${company.name}: ${found.length} items`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ companyId: company.id, message });
      log.error(`${company.name}: ${message}`);
    }

    options.onProgress?.(index + 1, companies.length);
    if (index < companies.length - 1) await sleep(config.collection.fetchDelayMs);
  }

  return { mentions, errors };
}
