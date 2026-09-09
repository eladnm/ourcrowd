import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.ts';
import type { Company, Mention, RawMention, Classification } from '@ourcrowd/core';

/**
 * Storage is SQLite through `node:sqlite`, the driver built into Node 22+.
 *
 * Chosen over Postgres so a reviewer needs no service running, and over
 * better-sqlite3 so there is no native compilation step — that package needs a
 * C++ toolchain on Windows, which is exactly the kind of setup friction the
 * README is supposed to avoid. The access pattern here (one writer, batch
 * reads) is what embedded SQLite handles well.
 */
let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(config.databasePath), { recursive: true });
  db = new DatabaseSync(config.databasePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** For tests: point the module at an in-memory database. */
export function useInMemoryDb(): DatabaseSync {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

export function runMigrations(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      aliases TEXT,
      domain TEXT,
      sector TEXT,
      ticker TEXT,
      search_query TEXT
    );

    CREATE TABLE IF NOT EXISTS mentions (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      snippet TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      published_at TEXT NOT NULL,
      collected_at TEXT NOT NULL,
      -- Classification columns stay NULL until the classifier has run, which
      -- is what lets collect and classify be separate, resumable steps.
      sentiment TEXT,
      relevance TEXT,
      confidence REAL,
      reasoning TEXT,
      model TEXT,
      classified_at TEXT,
      -- Set once the mention has been included in an alert, so a story is
      -- never alerted on twice.
      alerted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_mentions_company ON mentions(company_id);
    CREATE INDEX IF NOT EXISTS idx_mentions_published ON mentions(published_at);

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      companies_processed INTEGER DEFAULT 0,
      mentions_found INTEGER DEFAULT 0,
      mentions_new INTEGER DEFAULT 0,
      mentions_classified INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      notes TEXT
    );
  `);

  addMissingColumns(database);
}

/**
 * Columns added after the first release.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against a database that already
 * exists, so a new column in the schema above would never reach anyone's
 * existing `press.db` — they would just get "no such column" at query time.
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so check the live schema instead.
 */
function addMissingColumns(database: DatabaseSync): void {
  const expected: Record<string, Record<string, string>> = {
    companies: { ticker: 'TEXT' },
  };

  for (const [table, columns] of Object.entries(expected)) {
    const existing = new Set(
      (database.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    for (const [column, type] of Object.entries(columns)) {
      if (!existing.has(column)) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }
  }
}

/**
 * Run `fn` inside a transaction. `node:sqlite` has no transaction helper of
 * its own, so batched writes go through here to stay atomic and fast.
 */
function transaction<T>(database: DatabaseSync, fn: () => T): T {
  database.exec('BEGIN');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/** Load the seed list from data/companies.json and upsert it into the db. */
export function loadCompanies(): Company[] {
  const parsed = JSON.parse(readFileSync(config.companiesPath, 'utf8')) as {
    companies: Company[];
  };
  return upsertCompanies(parsed.companies);
}

export function upsertCompanies(companies: Company[]): Company[] {
  const database = getDb();
  const upsert = database.prepare(`
    INSERT INTO companies (id, name, aliases, domain, sector, ticker, search_query)
    VALUES (:id, :name, :aliases, :domain, :sector, :ticker, :search_query)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, aliases = excluded.aliases,
      domain = excluded.domain, sector = excluded.sector,
      ticker = excluded.ticker, search_query = excluded.search_query
  `);
  transaction(database, () => {
    for (const c of companies) {
      upsert.run({
        id: c.id,
        name: c.name,
        aliases: c.aliases ? JSON.stringify(c.aliases) : null,
        domain: c.domain ?? null,
        sector: c.sector ?? null,
        ticker: c.ticker ?? null,
        search_query: c.searchQuery ?? null,
      });
    }
  });
  return companies;
}

/**
 * Load the seed list, and if this database has no classified mentions yet,
 * import the committed `data/mentions.json` snapshot.
 *
 * That is what lets a reviewer run `pnpm api` against a fresh clone and see
 * the dashboard populated — `press.db` is gitignored, the JSON export is the
 * reviewable artefact.
 */
export function prepareStore(): { companies: number; hydrated: number } {
  const companies = loadCompanies();
  const hydrated = hydrateFromExportIfEmpty();
  return { companies: companies.length, hydrated };
}

function hydrateFromExportIfEmpty(): number {
  if (getStats().mentions > 0) return 0;

  const mentionsPath = join(config.exportDir, 'mentions.json');
  if (!existsSync(mentionsPath)) return 0;

  let mentions: Mention[];
  try {
    const parsed: unknown = JSON.parse(readFileSync(mentionsPath, 'utf8'));
    if (!Array.isArray(parsed) || parsed.length === 0) return 0;
    mentions = parsed as Mention[];
  } catch {
    return 0;
  }

  insertMentions(
    mentions.map((m) => ({
      id: m.id,
      companyId: m.companyId,
      title: m.title,
      snippet: m.snippet,
      url: m.url,
      source: m.source,
      publishedAt: m.publishedAt,
      collectedAt: m.collectedAt,
    })),
  );
  for (const mention of mentions) {
    saveClassification(mention.id, {
      sentiment: mention.sentiment,
      relevance: mention.relevance,
      confidence: mention.confidence,
      reasoning: mention.reasoning,
      model: mention.model,
      classifiedAt: mention.classifiedAt,
    });
  }
  return mentions.length;
}

interface CompanyRow {
  id: string;
  name: string;
  aliases: string | null;
  domain: string | null;
  sector: string | null;
  ticker: string | null;
  search_query: string | null;
}

function toCompany(row: CompanyRow): Company {
  return {
    id: row.id,
    name: row.name,
    ...(row.aliases ? { aliases: JSON.parse(row.aliases) as string[] } : {}),
    ...(row.domain ? { domain: row.domain } : {}),
    ...(row.sector ? { sector: row.sector } : {}),
    ...(row.ticker ? { ticker: row.ticker } : {}),
    ...(row.search_query ? { searchQuery: row.search_query } : {}),
  };
}

export function getCompanies(): Company[] {
  const rows = getDb()
    .prepare('SELECT * FROM companies ORDER BY name')
    .all() as unknown as CompanyRow[];
  return rows.map(toCompany);
}

/**
 * Insert newly collected mentions, ignoring ones already stored.
 * Returns how many were actually new — the number the alert job cares about.
 */
export function insertMentions(mentions: RawMention[]): number {
  const database = getDb();
  const insert = database.prepare(`
    INSERT OR IGNORE INTO mentions
      (id, company_id, title, snippet, url, source, published_at, collected_at)
    VALUES (:id, :companyId, :title, :snippet, :url, :source, :publishedAt, :collectedAt)
  `);
  return transaction(database, () => {
    let inserted = 0;
    for (const row of mentions) {
      inserted += Number(insert.run({ ...row }).changes);
    }
    return inserted;
  });
}

interface MentionRow {
  id: string;
  company_id: string;
  title: string;
  snippet: string;
  url: string;
  source: string;
  published_at: string;
  collected_at: string;
  sentiment: string | null;
  relevance: string | null;
  confidence: number | null;
  reasoning: string | null;
  model: string | null;
  classified_at: string | null;
  alerted_at: string | null;
}

function toMention(row: MentionRow): Mention {
  return {
    id: row.id,
    companyId: row.company_id,
    title: row.title,
    snippet: row.snippet,
    url: row.url,
    source: row.source,
    publishedAt: row.published_at,
    collectedAt: row.collected_at,
    sentiment: (row.sentiment ?? 'neutral') as Mention['sentiment'],
    relevance: (row.relevance ?? 'relevant') as Mention['relevance'],
    confidence: row.confidence ?? 0,
    reasoning: row.reasoning ?? '',
    model: row.model ?? '',
    classifiedAt: row.classified_at ?? '',
  };
}

function toRawMention(row: MentionRow): RawMention {
  return {
    id: row.id,
    companyId: row.company_id,
    title: row.title,
    snippet: row.snippet,
    url: row.url,
    source: row.source,
    publishedAt: row.published_at,
    collectedAt: row.collected_at,
  };
}

/**
 * Mentions still awaiting a label, newest first.
 *
 * `sinceDays` bounds the work to recent coverage — classifying an entire
 * quarterly backfill on a local model takes hours, so the daily job and a
 * time-boxed first run both narrow the window here rather than in the caller.
 */
export function getUnclassifiedMentions(
  options: {
    limit?: number;
    sinceDays?: number;
    companyIds?: string[];
    mentionIds?: string[];
  } = {},
): RawMention[] {
  const clauses = ['sentiment IS NULL'];
  const params: unknown[] = [];

  if (options.sinceDays !== undefined) {
    clauses.push('published_at >= ?');
    params.push(new Date(Date.now() - options.sinceDays * 86_400_000).toISOString());
  }

  // Scoping to explicit ids is what makes `--relabel` mean "redo these",
  // rather than "redo these and also everything else still pending".
  if (options.mentionIds !== undefined) {
    if (options.mentionIds.length === 0) return [];
    clauses.push(`id IN (${options.mentionIds.map(() => '?').join(', ')})`);
    params.push(...options.mentionIds);
  }

  // Scoping to companies keeps `pipeline --limit N` honest: without it a
  // limited collection would still classify the entire stored backlog.
  if (options.companyIds !== undefined) {
    if (options.companyIds.length === 0) return [];
    clauses.push(`company_id IN (${options.companyIds.map(() => '?').join(', ')})`);
    params.push(...options.companyIds);
  }

  let sql = `SELECT * FROM mentions WHERE ${clauses.join(' AND ')} ORDER BY published_at DESC`;
  if (options.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const rows = getDb().prepare(sql).all(...(params as never[])) as unknown as MentionRow[];
  return rows.map(toRawMention);
}

export function saveClassification(mentionId: string, result: Classification): void {
  getDb()
    .prepare(
      `UPDATE mentions SET sentiment = ?, relevance = ?, confidence = ?,
         reasoning = ?, model = ?, classified_at = ?
       WHERE id = ?`,
    )
    .run(
      result.sentiment,
      result.relevance,
      result.confidence,
      result.reasoning,
      result.model,
      result.classifiedAt,
      mentionId,
    );
}

/** All classified mentions, newest first. */
export function getClassifiedMentions(): Mention[] {
  const rows = getDb()
    .prepare('SELECT * FROM mentions WHERE sentiment IS NOT NULL ORDER BY published_at DESC')
    .all() as unknown as MentionRow[];
  return rows.map(toMention);
}

export function getMentionsForCompany(companyId: string): Mention[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM mentions WHERE company_id = ? AND sentiment IS NOT NULL
       ORDER BY published_at DESC`,
    )
    .all(companyId) as unknown as MentionRow[];
  return rows.map(toMention);
}

/**
 * Classified, relevant mentions that have never been alerted on. This — rather
 * than "published today" — is what makes the daily alert correct: an article
 * published last week but first seen today is genuinely new to us, and one
 * already alerted on yesterday must not fire again.
 */
export function getUnalertedMentions(): Mention[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM mentions
       WHERE alerted_at IS NULL AND sentiment IS NOT NULL AND relevance = 'relevant'
       ORDER BY published_at DESC`,
    )
    .all() as unknown as MentionRow[];
  return rows.map(toMention);
}

export function markAlerted(ids: string[], at: string): void {
  const database = getDb();
  const stmt = database.prepare('UPDATE mentions SET alerted_at = ? WHERE id = ?');
  transaction(database, () => {
    for (const id of ids) stmt.run(at, id);
  });
}

/**
 * Clear classification labels so the next `classify` run reconsiders them.
 *
 * Needed when the prompt or a company's context changes: a label produced by
 * an older prompt is not wrong exactly, but it was decided on less
 * information. `onlyWithContext` narrows this to companies that have since
 * gained a sector or ticker — the cases where re-asking can actually change
 * the answer — so a prompt tweak does not force a full re-run.
 *
 * Returns the ids that were unlabelled, so the caller can re-classify exactly
 * those instead of sweeping up the entire pending backlog.
 */
export function clearClassifications(
  options: { before?: string; onlyWithContext?: boolean } = {},
): string[] {
  const clauses = ['sentiment IS NOT NULL'];
  const params: unknown[] = [];

  if (options.before) {
    clauses.push('classified_at < ?');
    params.push(options.before);
  }
  if (options.onlyWithContext) {
    clauses.push(
      'company_id IN (SELECT id FROM companies WHERE ticker IS NOT NULL OR sector IS NOT NULL)',
    );
  }

  const database = getDb();
  const where = clauses.join(' AND ');

  // Capture the ids first: once the labels are gone the predicate no longer
  // identifies them.
  const ids = (
    database.prepare(`SELECT id FROM mentions WHERE ${where}`).all(...(params as never[])) as unknown as {
      id: string;
    }[]
  ).map((row) => row.id);

  database
    .prepare(
      `UPDATE mentions
       SET sentiment = NULL, relevance = NULL, confidence = NULL,
           reasoning = NULL, model = NULL, classified_at = NULL
       WHERE ${where}`,
    )
    .run(...(params as never[]));

  return ids;
}

export function startRun(kind: string): number {
  const result = getDb()
    .prepare('INSERT INTO runs (kind, started_at) VALUES (?, ?)')
    .run(kind, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function finishRun(id: number, stats: Record<string, number | string>): void {
  getDb()
    .prepare(
      `UPDATE runs SET finished_at = ?, companies_processed = ?, mentions_found = ?,
         mentions_new = ?, mentions_classified = ?, errors = ?, notes = ?
       WHERE id = ?`,
    )
    .run(
      new Date().toISOString(),
      Number(stats.companiesProcessed ?? 0),
      Number(stats.mentionsFound ?? 0),
      Number(stats.mentionsNew ?? 0),
      Number(stats.mentionsClassified ?? 0),
      Number(stats.errors ?? 0),
      String(stats.notes ?? ''),
      id,
    );
}

export interface RunRow {
  id: number;
  kind: string;
  started_at: string;
  finished_at: string | null;
  companies_processed: number;
  mentions_found: number;
  mentions_new: number;
  mentions_classified: number;
  errors: number;
  notes: string | null;
}

export function getStats() {
  const database = getDb();
  const count = (sql: string) => Number((database.prepare(sql).get() as { n: number }).n);
  return {
    companies: count('SELECT COUNT(*) n FROM companies'),
    mentions: count('SELECT COUNT(*) n FROM mentions'),
    classified: count('SELECT COUNT(*) n FROM mentions WHERE sentiment IS NOT NULL'),
    unclassified: count('SELECT COUNT(*) n FROM mentions WHERE sentiment IS NULL'),
    lastRun:
      (database.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() as
        | RunRow
        | undefined) ?? null,
  };
}
