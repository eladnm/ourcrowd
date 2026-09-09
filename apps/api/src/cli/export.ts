/**
 * Export the current database to JSON + CSV under data/.
 *
 * This is deliverable #5: the output of a successful run, committed so a
 * reviewer can inspect results without re-running the pipeline.
 *
 *   pnpm export             # write data/*.json and data/*.csv
 *   pnpm export -- --force  # allow replacing a populated export with an empty one
 *
 * Set EXPORT_DIR to write somewhere other than data/ — useful when running
 * against a scratch DATABASE_PATH.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { computeCompanyStatus, isWithinQuarter, quarterStart } from '@ourcrowd/core';
import type { CompanyStatus, Mention } from '@ourcrowd/core';
import { config, ROOT } from '../config.ts';
import { log } from '../lib/logger.ts';
import { AlreadyReportedError } from '../lib/errors.ts';
import { getClassifiedMentions, getCompanies, getStats } from '../store/db.ts';

/** RFC 4180 quoting: wrap in quotes and double any embedded quote. */
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n') + '\n';
}

/**
 * Refuse to replace a populated export with an empty one unless asked.
 *
 * Easy to trip over: point DATABASE_PATH at a scratch database, run export,
 * and the committed data/ deliverable is silently replaced with zero rows.
 * Overwriting real results should be a deliberate act.
 */
export function checkEmptyOverwrite(
  exportDir: string,
  mentionCount: number,
  force: boolean,
): number | null {
  if (mentionCount > 0 || force) return null;

  const existing = join(exportDir, 'mentions.json');
  if (!existsSync(existing)) return null;

  let previous: number;
  try {
    const parsed = JSON.parse(readFileSync(existing, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return null;
    previous = parsed.length;
  } catch {
    return null; // Unreadable or not JSON: nothing worth protecting.
  }

  return previous > 0 ? previous : null;
}

function guardEmptyOverwrite(mentionCount: number, force: boolean): void {
  const atRisk = checkEmptyOverwrite(config.exportDir, mentionCount, force);
  if (atRisk === null) return;

  log.error(
    `Refusing to overwrite ${atRisk} exported mentions with an empty export.\n` +
      `  The database at ${config.databasePath} has no classified mentions.\n` +
      '  Run `pnpm classify` first, or pass --force to export anyway,\n' +
      '  or set EXPORT_DIR to write somewhere other than data/.',
  );
  throw new AlreadyReportedError('refused to write an empty export');
}

export async function runExport(now: Date = new Date(), options: { force?: boolean } = {}) {
  const companies = getCompanies();
  const mentions = getClassifiedMentions();
  const stats = getStats();

  guardEmptyOverwrite(mentions.length, options.force ?? false);

  const mentionsByCompany = new Map<string, Mention[]>();
  for (const mention of mentions) {
    const existing = mentionsByCompany.get(mention.companyId);
    if (existing) existing.push(mention);
    else mentionsByCompany.set(mention.companyId, [mention]);
  }

  const statuses: CompanyStatus[] = companies.map((company) =>
    computeCompanyStatus(company, mentionsByCompany.get(company.id) ?? [], now),
  );

  const relevant = mentions.filter((m) => m.relevance === 'relevant');
  const inQuarter = relevant.filter((m) => isWithinQuarter(m, now));
  const summary = {
    generatedAt: now.toISOString(),
    quarterStart: quarterStart(now).toISOString(),
    model: config.ollama.model,
    totals: {
      companies: companies.length,
      companiesWithCoverage: statuses.filter((s) => s.lastMentionedAt !== null).length,
      mentionsCollected: stats.mentions,
      mentionsClassified: stats.classified,
      mentionsRelevant: relevant.length,
      mentionsIrrelevant: mentions.length - relevant.length,
    },
    sentiment: {
      positive: inQuarter.filter((m) => m.sentiment === 'positive').length,
      negative: inQuarter.filter((m) => m.sentiment === 'negative').length,
      neutral: inQuarter.filter((m) => m.sentiment === 'neutral').length,
    },
    statusBreakdown: {
      active: statuses.filter((s) => s.status === 'active').length,
      recent: statuses.filter((s) => s.status === 'recent').length,
      stale: statuses.filter((s) => s.status === 'stale').length,
      dormant: statuses.filter((s) => s.status === 'dormant').length,
      none: statuses.filter((s) => s.status === 'none').length,
    },
  };

  const out = (name: string) => join(config.exportDir, name);

  writeFileSync(out('mentions.json'), JSON.stringify(mentions, null, 2) + '\n');
  writeFileSync(out('company-status.json'), JSON.stringify(statuses, null, 2) + '\n');
  writeFileSync(out('run-summary.json'), JSON.stringify(summary, null, 2) + '\n');

  writeFileSync(
    out('mentions.csv'),
    toCsv(
      ['company', 'title', 'sentiment', 'relevance', 'confidence', 'published_at', 'source', 'url', 'reasoning'],
      mentions.map((m) => [
        companies.find((c) => c.id === m.companyId)?.name ?? m.companyId,
        m.title,
        m.sentiment,
        m.relevance,
        m.confidence.toFixed(2),
        m.publishedAt,
        m.source,
        m.url,
        m.reasoning,
      ]),
    ),
  );

  writeFileSync(
    out('company-status.csv'),
    toCsv(
      ['company', 'status', 'label', 'last_mentioned_at', 'days_since', 'quarter_mentions', 'positive', 'negative', 'neutral'],
      statuses.map((s) => [
        s.companyName,
        s.status,
        s.label,
        s.lastMentionedAt ?? '',
        s.daysSinceLastMention ?? '',
        s.quarterMentionCount,
        s.sentimentBreakdown.positive,
        s.sentimentBreakdown.negative,
        s.sentimentBreakdown.neutral,
      ]),
    ),
  );

  log.step(`Exported to ${relative(ROOT, config.exportDir) || '.'}/`);
  log.info(`  mentions.json / .csv       ${mentions.length} rows`);
  log.info(`  company-status.json / .csv ${statuses.length} rows`);
  log.info(`  run-summary.json`);

  return summary;
}

if (import.meta.filename === process.argv[1]) {
  const force = process.argv.slice(2).includes('--force');
  runExport(new Date(), { force }).catch((error) => {
    if (!(error instanceof AlreadyReportedError)) log.error(String(error));
    process.exit(1);
  });
}
