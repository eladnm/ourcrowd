import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCompanyStatus, daysBetween, statusFromDays, statusLabel, isWithinQuarter } from './status.ts';
import type { Company, Mention } from './types.ts';

const NOW = new Date('2026-09-09T12:00:00Z');
const company: Company = { id: 'acme', name: 'Acme' };

function mention(overrides: Partial<Mention> = {}): Mention {
  return {
    id: 'm1', companyId: 'acme', title: 't', snippet: 's',
    url: 'https://example.com/a', source: 'Example', publishedAt: '2026-09-08T00:00:00Z',
    collectedAt: NOW.toISOString(), sentiment: 'neutral', relevance: 'relevant',
    confidence: 0.9, reasoning: 'r', model: 'test', classifiedAt: NOW.toISOString(),
    ...overrides,
  };
}

test('daysBetween floors to whole days and clamps negatives', () => {
  assert.equal(daysBetween(new Date('2026-09-08T23:00:00Z'), NOW), 0);
  assert.equal(daysBetween(new Date('2026-09-08T11:00:00Z'), NOW), 1);
  assert.equal(daysBetween(new Date('2026-12-01T00:00:00Z'), NOW), 0);
});

test('status buckets fall on the documented boundaries', () => {
  assert.equal(statusFromDays(null), 'none');
  assert.equal(statusFromDays(0), 'active');
  assert.equal(statusFromDays(7), 'active');
  assert.equal(statusFromDays(8), 'recent');
  assert.equal(statusFromDays(30), 'recent');
  assert.equal(statusFromDays(31), 'stale');
  assert.equal(statusFromDays(90), 'stale');
  assert.equal(statusFromDays(91), 'dormant');
});

test('labels read naturally for today and yesterday', () => {
  assert.equal(statusLabel(null), 'no coverage found');
  assert.equal(statusLabel(0), 'last mentioned today');
  assert.equal(statusLabel(1), 'last mentioned yesterday');
  assert.equal(statusLabel(45), 'last mentioned 45 days ago');
});

test('a company with no mentions reports no coverage', () => {
  const status = computeCompanyStatus(company, [], NOW);
  assert.equal(status.status, 'none');
  assert.equal(status.lastMentionedAt, null);
  assert.equal(status.quarterMentionCount, 0);
});

test('irrelevant mentions never drive recency or counts', () => {
  const status = computeCompanyStatus(company, [
    mention({ id: 'a', relevance: 'irrelevant', publishedAt: '2026-09-09T00:00:00Z' }),
    mention({ id: 'b', publishedAt: '2026-07-01T00:00:00Z' }),
  ], NOW);
  assert.equal(status.lastMentionedAt, '2026-07-01T00:00:00Z');
  assert.equal(status.quarterMentionCount, 1);
});

test('other companies\' mentions are ignored', () => {
  const status = computeCompanyStatus(company, [
    mention({ id: 'x', companyId: 'other', publishedAt: '2026-09-09T00:00:00Z' }),
  ], NOW);
  assert.equal(status.status, 'none');
});

test('sentiment breakdown counts only the quarter window', () => {
  const status = computeCompanyStatus(company, [
    mention({ id: '1', sentiment: 'positive', publishedAt: '2026-09-01T00:00:00Z' }),
    mention({ id: '2', sentiment: 'positive', publishedAt: '2026-08-01T00:00:00Z' }),
    mention({ id: '3', sentiment: 'negative', publishedAt: '2026-07-01T00:00:00Z' }),
    // Outside the 90-day window: counted for recency, not for the quarter.
    mention({ id: '4', sentiment: 'neutral', publishedAt: '2026-01-01T00:00:00Z' }),
  ], NOW);
  assert.deepEqual(status.sentimentBreakdown, { positive: 2, negative: 1, neutral: 0 });
  assert.equal(status.quarterMentionCount, 3);
});

test('future-dated feed items do not become the last mention', () => {
  const status = computeCompanyStatus(company, [
    mention({ id: 'future', publishedAt: '2027-01-01T00:00:00Z' }),
    mention({ id: 'real', publishedAt: '2026-09-05T00:00:00Z' }),
  ], NOW);
  assert.equal(status.lastMentionedAt, '2026-09-05T00:00:00Z');
});

test('quarter window excludes items older than 90 days', () => {
  assert.equal(isWithinQuarter({ publishedAt: '2026-08-01T00:00:00Z' }, NOW), true);
  assert.equal(isWithinQuarter({ publishedAt: '2026-01-01T00:00:00Z' }, NOW), false);
});
