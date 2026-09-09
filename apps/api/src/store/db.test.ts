import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RawMention } from '@ourcrowd/core';
import {
  useInMemoryDb,
  upsertCompanies,
  getCompanies,
  insertMentions,
  getUnclassifiedMentions,
  saveClassification,
  getClassifiedMentions,
  getUnalertedMentions,
  markAlerted,
  getStats,
} from './db.ts';

const NOW = '2026-09-09T12:00:00Z';

function mention(id: string, overrides: Partial<RawMention> = {}): RawMention {
  return {
    id,
    companyId: 'acme',
    title: `Story ${id}`,
    snippet: 'snippet',
    url: `https://example.com/${id}`,
    source: 'Example',
    publishedAt: '2026-09-08T00:00:00Z',
    collectedAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  useInMemoryDb();
  upsertCompanies([{ id: 'acme', name: 'Acme' }]);
});

test('re-inserting the same mention does not create a duplicate', () => {
  assert.equal(insertMentions([mention('a'), mention('b')]), 2);
  assert.equal(insertMentions([mention('a'), mention('b')]), 0);
  assert.equal(getStats().mentions, 2);
});

test('a mixed batch inserts only the genuinely new rows', () => {
  insertMentions([mention('a')]);
  assert.equal(insertMentions([mention('a'), mention('c')]), 1);
});

test('classified mentions leave the unclassified queue', () => {
  insertMentions([mention('a'), mention('b')]);
  assert.equal(getUnclassifiedMentions().length, 2);

  saveClassification('a', {
    sentiment: 'positive',
    relevance: 'relevant',
    confidence: 0.9,
    reasoning: 'funding round',
    model: 'test',
    classifiedAt: NOW,
  });

  assert.equal(getUnclassifiedMentions().length, 1);
  assert.equal(getClassifiedMentions().length, 1);
  assert.equal(getStats().classified, 1);
});

test('the unclassified window excludes older mentions', () => {
  insertMentions([
    mention('recent', { publishedAt: new Date(Date.now() - 5 * 864e5).toISOString() }),
    mention('old', { publishedAt: new Date(Date.now() - 60 * 864e5).toISOString() }),
  ]);
  const pending = getUnclassifiedMentions({ sinceDays: 30 });
  assert.deepEqual(pending.map((m) => m.id), ['recent']);
});

function classify(id: string, relevance: 'relevant' | 'irrelevant' = 'relevant') {
  saveClassification(id, {
    sentiment: 'neutral',
    relevance,
    confidence: 0.8,
    reasoning: 'r',
    model: 'test',
    classifiedAt: NOW,
  });
}

test('only classified, relevant mentions are eligible for alerting', () => {
  insertMentions([mention('a'), mention('b'), mention('c')]);
  classify('a');
  classify('b', 'irrelevant');
  // 'c' stays unclassified.

  assert.deepEqual(getUnalertedMentions().map((m) => m.id), ['a']);
});

test('a mention is never alerted on twice', () => {
  insertMentions([mention('a')]);
  classify('a');
  assert.equal(getUnalertedMentions().length, 1);

  markAlerted(['a'], NOW);
  assert.equal(getUnalertedMentions().length, 0);
});

test('upserting a company updates it rather than duplicating it', () => {
  upsertCompanies([{ id: 'acme', name: 'Acme Corporation', aliases: ['Acme Inc'] }]);
  assert.equal(getStats().companies, 1);
});

test('classification can be scoped to specific companies', () => {
  upsertCompanies([
    { id: 'acme', name: 'Acme' },
    { id: 'globex', name: 'Globex' },
  ]);
  insertMentions([mention('a'), mention('g', { companyId: 'globex' })]);

  const scoped = getUnclassifiedMentions({ companyIds: ['globex'] });
  assert.deepEqual(scoped.map((m) => m.id), ['g']);
});

test('an empty company scope matches nothing rather than everything', () => {
  insertMentions([mention('a')]);
  assert.deepEqual(getUnclassifiedMentions({ companyIds: [] }), []);
});

test('a ticker survives a round trip through storage', () => {
  upsertCompanies([{ id: 'alpha-tau', name: 'Alpha Tau', ticker: 'DRTS' }]);
  const stored = getCompanies().find((c) => c.id === 'alpha-tau');
  assert.equal(stored?.ticker, 'DRTS');
});
