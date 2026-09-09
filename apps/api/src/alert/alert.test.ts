import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Company, Mention } from '@ourcrowd/core';
import { formatConsoleAlert, formatWebhookPayload } from './index.ts';

const companiesById = new Map<string, Company>([
  ['acme', { id: 'acme', name: 'Acme' }],
  ['globex', { id: 'globex', name: 'Globex' }],
]);

function mention(overrides: Partial<Mention> = {}): Mention {
  return {
    id: 'm1',
    companyId: 'acme',
    title: 'Acme raises $50M',
    snippet: 's',
    url: 'https://example.com/a',
    source: 'TechCrunch',
    publishedAt: '2026-09-08T00:00:00Z',
    collectedAt: '2026-09-09T00:00:00Z',
    sentiment: 'positive',
    relevance: 'relevant',
    confidence: 0.9,
    reasoning: 'funding round',
    model: 'test',
    classifiedAt: '2026-09-09T00:00:00Z',
    ...overrides,
  };
}

const payload = (mentions: Mention[]) => ({
  generatedAt: '2026-09-09T08:00:00Z',
  mentions,
  companiesById,
});

test('an empty alert says so plainly', () => {
  assert.match(formatConsoleAlert(payload([])), /No new press mentions/);
});

test('the console alert includes the title, url and company', () => {
  const output = formatConsoleAlert(payload([mention()]));
  assert.match(output, /Acme/);
  assert.match(output, /Acme raises \$50M/);
  assert.match(output, /https:\/\/example\.com\/a/);
});

test('the headline count is singular for one mention', () => {
  assert.match(formatConsoleAlert(payload([mention()])), /1 new mention across 1 company/);
});

test('companies with negative coverage are listed first', () => {
  const output = formatConsoleAlert(
    payload([
      mention({ id: 'a', companyId: 'acme', sentiment: 'positive' }),
      mention({ id: 'b', companyId: 'globex', sentiment: 'negative' }),
    ]),
  );
  assert.ok(output.indexOf('Globex') < output.indexOf('Acme'));
});

test('negative coverage is called out in the header', () => {
  const output = formatConsoleAlert(payload([mention({ sentiment: 'negative' })]));
  assert.match(output, /1 negative mention/);
});

test('the webhook payload carries a summary and blocks', () => {
  const body = formatWebhookPayload(payload([mention()]));
  assert.match(String(body.text), /1 new mention/);
  assert.ok(Array.isArray(body.blocks));
});

test('slack control characters in titles are escaped', () => {
  const body = formatWebhookPayload(payload([mention({ title: 'Acme <b> & "Co"' })]));
  assert.match(JSON.stringify(body.blocks), /&lt;b&gt; &amp;/);
});

/** Build N mentions spread across M companies, for the capping tests. */
function bulk(companyCount: number, perCompany: number): Mention[] {
  const out: Mention[] = [];
  for (let c = 0; c < companyCount; c++) {
    const companyId = `co-${c}`;
    companiesById.set(companyId, { id: companyId, name: `Company ${c}` });
    for (let m = 0; m < perCompany; m++) {
      out.push(mention({ id: `${companyId}-${m}`, companyId, sentiment: 'neutral' }));
    }
  }
  return out;
}

test('a large console alert stays readable instead of dumping everything', () => {
  const output = formatConsoleAlert(payload(bulk(60, 8)));
  const lines = output.split('\n').length;
  assert.ok(lines < 500, `expected a capped alert, got ${lines} lines`);
});

test('the console alert says how much it withheld', () => {
  const output = formatConsoleAlert(payload(bulk(60, 8)));
  assert.match(output, /more mentions across 40 further companies/);
  assert.match(output, /more for this company/);
});

test('the header still reports the true totals, not the capped ones', () => {
  const output = formatConsoleAlert(payload(bulk(60, 8)));
  assert.match(output, /480 new mentions across 60 companies/);
});

test('a small alert is not truncated at all', () => {
  const output = formatConsoleAlert(payload(bulk(2, 2)));
  assert.doesNotMatch(output, /and \d+ more/);
});
