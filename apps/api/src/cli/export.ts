/**
 * Export the current database to JSON + CSV under data/.
 *
 * This is deliverable #5: the output of a successful run, committed so a
 * reviewer can inspect results without re-running the pipeline.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeCompanyStatus, quarterStart } from '@ourcrowd/core';
import type { CompanyStatus, Mention } from '@ourcrowd/core';
import { config } from '../config.ts';
import { log } from '../lib/logger.ts';
import { getClassifiedMentions, getCompanies, getStats } from '../store/db.ts';

/** RFC 4180 quoting: wrap in quotes and double any embedded quote. */
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n') + '\n';
}

export async function runExport(now: Date = new Date()) {
  const companies = getCompanies();
  const mentions = getClassifiedMentions();
  const stats = getStats();

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
      positive: relevant.filter((m) => m.sentiment === 'positive').length,
      negative: relevant.filter((m) => m.sentiment === 'negative').length,
      neutral: relevant.filter((m) => m.sentiment === 'neutral').length,
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

  log.step('Exported to data/');
  log.info(`  mentions.json / .csv       ${mentions.length} rows`);
  log.info(`  company-status.json / .csv ${statuses.length} rows`);
  log.info(`  run-summary.json`);

  return summary;
}

if (import.meta.filename === process.argv[1]) {
  runExport().catch((error) => {
    log.error(String(error));
    process.exit(1);
  });
}
