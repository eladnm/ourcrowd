/**
 * Full end-to-end run: collect -> classify -> export.
 *
 *   pnpm pipeline                 # 90-day backfill, the reviewable run
 *   pnpm pipeline -- --since 30   # collect the quarter, label the last 30 days
 *   pnpm pipeline -- --days 1    # what the daily job does
 *   pnpm pipeline -- --limit 5   # quick smoke test
 */
import { log } from '../lib/logger.ts';
import { parseArgs } from '../lib/args.ts';
import { runCollect } from './collect.ts';
import { runClassify } from './classify.ts';
import { runExport } from './export.ts';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  await runCollect({ days: args.days, limit: args.limit });
  await runClassify({ sinceDays: args.since });
  await runExport();

  const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
  log.step(`Pipeline finished in ${minutes} min`);
  log.info('Start the dashboard with:  pnpm api   (then open http://localhost:4000)');
}

main().catch((error) => {
  log.error(String(error));
  process.exit(1);
});
