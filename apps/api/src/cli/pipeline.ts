/**
 * Full end-to-end run: collect -> classify -> export.
 *
 *   pnpm pipeline                        # 90-day backfill, the reviewable run
 *   pnpm pipeline -- --since 30          # collect the quarter, label 30 days
 *   pnpm pipeline -- --days 1            # what the daily job does
 *   pnpm pipeline -- --limit 5 --since 7 # quick smoke test
 *
 * `--limit` scopes BOTH halves: a limited run classifies only what it just
 * collected, rather than picking up the whole stored backlog.
 */
import { log } from '../lib/logger.ts';
import { AlreadyReportedError } from '../lib/errors.ts';
import { parseArgs } from '../lib/args.ts';
import { runCollect } from './collect.ts';
import { runClassify } from './classify.ts';
import { runExport } from './export.ts';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  // `--since 7` alone should not silently collect 90 days: when no explicit
  // --days is given, collect the same window we intend to label.
  const collected = await runCollect({
    days: args.days ?? args.since,
    limit: args.limit,
  });

  await runClassify({
    sinceDays: args.since,
    // Only narrow to specific companies when the caller asked for a subset;
    // a full run should still sweep up anything left over from before.
    companyIds: args.limit === undefined ? undefined : collected.companyIds,
  });
  await runExport(new Date(), { force: process.argv.includes('--force') });

  const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
  log.step(`Pipeline finished in ${minutes} min`);
  log.info('Start the dashboard with:  pnpm api   (then open http://localhost:4000)');
}

main().catch((error) => {
  if (!(error instanceof AlreadyReportedError)) log.error(String(error));
  process.exit(1);
});
