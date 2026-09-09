/**
 * The daily job: collect a narrow window, classify what is new, alert on it.
 *
 *   pnpm alert                # collect 2 days, classify, alert
 *   pnpm alert -- --dry-run   # show what would be sent, mark nothing
 *
 * A 2-day collection window is deliberate: feeds can lag, and re-seeing an
 * article we already stored is free thanks to the mention-id dedupe. What
 * makes an alert "new" is alerted_at being NULL, not the publication date.
 */
import { log } from '../lib/logger.ts';
import { AlreadyReportedError } from '../lib/errors.ts';
import { parseArgs } from '../lib/args.ts';
import { sendAlert } from '../alert/index.ts';
import { runCollect } from './collect.ts';
import { runClassify } from './classify.ts';
import { getCompanies, getUnalertedMentions, markAlerted } from '../store/db.ts';

const DAILY_WINDOW_DAYS = 2;

export async function runDailyAlert(options: { dryRun?: boolean; skipCollect?: boolean } = {}) {
  if (!options.skipCollect) {
    await runCollect({ days: DAILY_WINDOW_DAYS });
    await runClassify();
  }

  const pending = getUnalertedMentions();
  const companiesById = new Map(getCompanies().map((c) => [c.id, c]));
  const generatedAt = new Date().toISOString();

  if (pending.length === 0) {
    log.info('No new mentions since the last alert — nothing to send.');
    return { sent: 0 };
  }

  log.step(`Alerting on ${pending.length} new mentions`);
  await sendAlert({ generatedAt, mentions: pending, companiesById });

  if (options.dryRun) {
    log.warn('--dry-run: mentions left unmarked, so the next run will alert on them again.');
    return { sent: pending.length, dryRun: true };
  }

  markAlerted(pending.map((m) => m.id), generatedAt);
  return { sent: pending.length };
}

if (import.meta.filename === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  runDailyAlert({ dryRun: args.dryRun }).catch((error) => {
    if (!(error instanceof AlreadyReportedError)) log.error(String(error));
    process.exit(1);
  });
}
