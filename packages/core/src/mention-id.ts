import { createHash } from 'node:crypto';

/** Query params that identify a campaign, not an article. */
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'source', 'oc',
];

/**
 * Strip the parts of a URL that vary between sightings of the same article, so
 * the same story collected on two different days yields one mention, not two.
 *
 * Deliberately conservative: it lowercases the host, drops tracking params and
 * a trailing slash, but leaves the path alone. Publishers do encode meaning in
 * path case, and over-normalizing would merge genuinely different articles.
 * Malformed URLs are returned untouched rather than throwing.
 */
export function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.protocol = 'https:';
    for (const param of TRACKING_PARAMS) url.searchParams.delete(param);
    // Sort remaining params so ordering differences don't split a mention.
    url.searchParams.sort();
    let normalized = url.toString();
    if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
    return normalized;
  } catch {
    return rawUrl.trim();
  }
}

/**
 * Stable id for a mention. Company-scoped on purpose: one article covering two
 * portfolio companies is a mention for each, and both should be shown.
 */
export function mentionId(companyId: string, url: string): string {
  return createHash('sha256')
    .update(`${companyId}::${normalizeUrl(url)}`)
    .digest('hex')
    .slice(0, 16);
}
