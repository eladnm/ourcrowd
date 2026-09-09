/**
 * Collect news mentions for every tracked company.
 *
 *   pnpm collect                 # default window (90 days)
 *   pnpm collect -- --days 1     # daily incremental
 *   pnpm collect -- --limit 10   # first 10 companies, for a smoke test
 */
import { collectAll } from '../collect/google-news.ts';
import { config } from '../config.ts';
import { log } from '../lib/logger.ts';
import { finishRun, insertMentions, loadCompanies, startRun } from '../store/db.ts';
import { parseArgs } from '../lib/args.ts';

export async function runCollect(options: { days?: number; limit?: number } = {}) {
  const windowDays = options.days ?? config.collection.windowDays;
  const companies = loadCompanies();
  const targets = options.limit ? companies.slice(0, options.limit) : companies;

  log.step(`Collecting news for ${targets.length} companies (last ${windowDays} days)`);
  const runId = startRun('collect');

  const { mentions, errors } = await collectAll(targets, { windowDays });
  const inserted = insertMentions(mentions);

  finishRun(runId, {
    companiesProcessed: targets.length,
    mentionsFound: mentions.length,
    mentionsNew: inserted,
    errors: errors.length,
    notes: `window=${windowDays}d`,
  });

  log.step('Collection complete');
  log.info(`  companies:  ${targets.length}`);
  log.info(`  items seen: ${mentions.length}`);
  log.info(`  new:        ${inserted}`);
  log.info(`  duplicates: ${mentions.length - inserted}`);
  if (errors.length) log.warn(`  failed:     ${errors.length} companies`);

  return { found: mentions.length, inserted, errors: errors.length };
}

if (import.meta.filename === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  runCollect({ days: args.days, limit: args.limit }).catch((error) => {
    log.error(String(error));
    process.exit(1);
  });
}
