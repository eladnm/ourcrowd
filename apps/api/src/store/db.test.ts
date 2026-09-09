import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RawMention } from '@ourcrowd/core';
import {
  useInMemoryDb,
  runMigrations,
  upsertCompanies,
  getCompanies,
  insertMentions,
  getUnclassifiedMentions,
  saveClassification,
  getClassifiedMentions,
  clearClassifications,
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

test('a database created before a column was added gets migrated, not broken', () => {
  // Reproduces a real bug: `CREATE TABLE IF NOT EXISTS` is a no-op against an
  // existing database, so adding `ticker` to the schema left older press.db
  // files throwing "no such column" at query time.
  const db = useInMemoryDb();
  db.exec('DROP TABLE companies');
  db.exec(`CREATE TABLE companies (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, aliases TEXT,
    domain TEXT, sector TEXT, search_query TEXT
  )`);
  db.exec("INSERT INTO companies (id, name) VALUES ('legacy', 'Legacy Co')");

  // Re-opening runs the migration, which must add the column in place.
  runMigrations(db);

  const columns = (db.prepare('PRAGMA table_info(companies)').all() as unknown as {
    name: string;
  }[]).map((r) => r.name);
  assert.ok(columns.includes('ticker'), 'ticker column should have been added');

  // And the existing row must survive.
  const row = db.prepare("SELECT name FROM companies WHERE id = 'legacy'").get() as {
    name: string;
  };
  assert.equal(row.name, 'Legacy Co');
});

test('relabelling clears only the labels, keeping the collected mention', () => {
  insertMentions([mention('a')]);
  classify('a');
  assert.equal(getClassifiedMentions().length, 1);

  const cleared = clearClassifications();
  assert.deepEqual(cleared, ['a']);
  assert.equal(getClassifiedMentions().length, 0);
  assert.equal(getUnclassifiedMentions().length, 1, 'the mention itself must survive');
});

test('relabelling can be narrowed to companies carrying context', () => {
  upsertCompanies([
    { id: 'acme', name: 'Acme' },
    { id: 'globex', name: 'Globex', ticker: 'GLBX' },
  ]);
  insertMentions([mention('a'), mention('g', { companyId: 'globex' })]);
  classify('a');
  classify('g');

  assert.deepEqual(clearClassifications({ onlyWithContext: true }), ['g']);
  assert.deepEqual(getUnclassifiedMentions().map((m) => m.id), ['g']);
});

test('relabelling classifies only what it cleared, not the whole backlog', () => {
  upsertCompanies([{ id: 'acme', name: 'Acme', ticker: 'ACME' }]);
  insertMentions([mention('labelled'), mention('never-labelled')]);
  classify('labelled');

  const cleared = clearClassifications({ onlyWithContext: true });
  assert.deepEqual(cleared, ['labelled']);

  // Both are unlabelled now, but a relabel run must target only the cleared one.
  assert.equal(getUnclassifiedMentions().length, 2);
  assert.deepEqual(
    getUnclassifiedMentions({ mentionIds: cleared }).map((m) => m.id),
    ['labelled'],
  );
});

test('the daily window can bound by collection time, not publication date', () => {
  // Regression: Google News `when:2d` is an indexing window, so a daily
  // collect returns older articles. Bounding the daily classify on
  // published_at skipped those on every run — the cutoff only moves forward —
  // leaving them permanently unlabelled and never alerted on.
  const longAgo = new Date(Date.now() - 40 * 864e5).toISOString();
  insertMentions([
    mention('old-but-new-to-us', { publishedAt: longAgo, collectedAt: new Date().toISOString() }),
  ]);

  assert.equal(getUnclassifiedMentions({ sinceDays: 2 }).length, 0, 'pubDate window misses it');
  assert.deepEqual(
    getUnclassifiedMentions({ collectedSinceDays: 2 }).map((m) => m.id),
    ['old-but-new-to-us'],
    'collection window catches it',
  );
});

test('relabelling never clears wider than the window it re-classifies', () => {
  // Regression: --relabel with --since cleared labels across the whole
  // database but only re-classified those inside the window, destroying the
  // rest with nothing to restore from.
  upsertCompanies([{ id: 'acme', name: 'Acme', ticker: 'ACME' }]);
  const longAgo = new Date(Date.now() - 200 * 864e5).toISOString();
  insertMentions([mention('recent'), mention('ancient', { publishedAt: longAgo })]);
  classify('recent');
  classify('ancient');

  const cleared = clearClassifications({ onlyWithContext: true, sinceDays: 30 });
  assert.deepEqual(cleared, ['recent']);
  assert.equal(
    getClassifiedMentions().some((m) => m.id === 'ancient'),
    true,
    'a label outside the window must survive',
  );
});
