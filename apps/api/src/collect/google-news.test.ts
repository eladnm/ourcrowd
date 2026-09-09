import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, feedUrl, parseFeed } from './google-news.ts';
import type { Company } from '@ourcrowd/core';

const NOW = new Date('2026-09-09T12:00:00Z');
const acme: Company = { id: 'acme', name: 'Acme Corp' };

function feed(items: string): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items}</channel></rss>`;
}

const ITEM = `<item>
  <title>Acme raises $50M Series B - TechCrunch</title>
  <link>https://news.google.com/rss/articles/abc123</link>
  <pubDate>Mon, 08 Sep 2026 09:30:00 GMT</pubDate>
  <description>&lt;a href="x"&gt;Acme&lt;/a&gt; closed a $50M round led by &amp;amp; Partners.</description>
  <source url="https://techcrunch.com">TechCrunch</source>
</item>`;

test('quotes a plain name and applies the time window', () => {
  assert.equal(buildQuery(acme, 90), '"Acme Corp" when:90d');
});

test('searchQuery overrides the default phrase query', () => {
  const shield: Company = { id: 'shield', name: 'Shield', searchQuery: 'Shield fintech compliance' };
  assert.equal(buildQuery(shield, 30), 'Shield fintech compliance when:30d');
});

test('distinctive aliases are OR-ed into the query', () => {
  const ssi: Company = { id: 'ssi', name: 'SSI', aliases: ['Safe Superintelligence'] };
  assert.equal(buildQuery(ssi, 90), '("SSI" OR "Safe Superintelligence") when:90d');
});

test('short aliases like Edge are not searched — they would drown the feed', () => {
  const ludeo: Company = { id: 'ludeo', name: 'Ludeo', aliases: ['Edge'] };
  assert.equal(buildQuery(ludeo, 90), '"Ludeo" when:90d');
});

test('a domain hint is appended so generic names stay anchored', () => {
  const lambda: Company = { id: 'lambda', name: 'Lambda', domain: 'lambda.ai' };
  assert.equal(buildQuery(lambda, 90), '"Lambda" lambda.ai when:90d');
});

test('feed url encodes the query', () => {
  const url = feedUrl(acme, 90);
  assert.match(url, /^https:\/\/news\.google\.com\/rss\/search\?q=/);
  assert.match(url, /%22Acme%20Corp%22/);
});

test('parses a well-formed item into a mention', () => {
  const [mention] = parseFeed(feed(ITEM), acme, NOW);
  assert.ok(mention);
  assert.equal(mention.companyId, 'acme');
  assert.equal(mention.source, 'TechCrunch');
  assert.equal(mention.publishedAt, '2026-09-08T09:30:00.000Z');
  assert.equal(mention.collectedAt, NOW.toISOString());
});

test('strips the trailing publisher from the headline', () => {
  const [mention] = parseFeed(feed(ITEM), acme, NOW);
  assert.equal(mention?.title, 'Acme raises $50M Series B');
});

test('decodes html entities and tags out of the snippet', () => {
  const [mention] = parseFeed(feed(ITEM), acme, NOW);
  assert.equal(mention?.snippet, 'Acme closed a $50M round led by & Partners.');
});

test('a single-item feed parses as one mention, not zero', () => {
  assert.equal(parseFeed(feed(ITEM), acme, NOW).length, 1);
});

test('an empty channel yields no mentions', () => {
  assert.deepEqual(parseFeed(feed(''), acme, NOW), []);
});

test('items with unparseable dates are skipped, not crashed on', () => {
  const bad = `<item><title>T</title><link>https://e.com/1</link><pubDate>not a date</pubDate></item>`;
  assert.deepEqual(parseFeed(feed(bad), acme, NOW), []);
});

test('items missing a link are skipped', () => {
  const bad = `<item><title>T</title><pubDate>Mon, 08 Sep 2026 09:30:00 GMT</pubDate></item>`;
  assert.deepEqual(parseFeed(feed(bad), acme, NOW), []);
});

test('the same article yields a stable id across runs', () => {
  const first = parseFeed(feed(ITEM), acme, NOW);
  const later = parseFeed(feed(ITEM), acme, new Date('2026-09-10T00:00:00Z'));
  assert.equal(first[0]?.id, later[0]?.id);
});
