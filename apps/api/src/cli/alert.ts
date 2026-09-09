/**
 * The daily job: collect a narrow window, classify what is new, alert on it.
 *
 *   pnpm alert                # collect 2 days, classify, alert
 *   pnpm alert -- --dry-run   # show what would be sent, mark nothing
 *
 * A 2-day collection window is deliberate: feeds can lag, and re-seeing an
 * article we already stored is free thanks to the mention-id dedupe.
 *
 * Classification is scoped by *collection* time, not publication time. Google
 * News `when:2d` is an indexing window, so a daily collect routinely returns
 * articles published weeks earlier; filtering the classify step on pubDate
 * would skip those today and on every later run — the cutoff only moves
 * forward — leaving them permanently unlabelled and never alerted on. Bounding
 * by collected_at still keeps a leftover quarterly backlog out of the daily
 * job. What makes an alert "new" is alerted_at being NULL.
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
    // Label whatever this run just collected — regardless of how old the
    // article itself is — while leaving any older backlog alone.
    await runClassify({ collectedSinceDays: DAILY_WINDOW_DAYS });
  }

  const pending = getUnalertedMentions();
  const companiesById = new Map(getCompanies().map((c) => [c.id, c]));
  const generatedAt = new Date().toISOString();

  if (pending.length === 0) {
    log.info('No new mentions since the last alert — nothing to send.');
    return { sent: 0 };
  }

  log.step(`Alerting on ${pending.length} new mentions`);
  const delivered = await sendAlert({ generatedAt, mentions: pending, companiesById });

  if (!delivered) {
    // Marking them now would drop these stories permanently: they would never
    // appear in getUnalertedMentions() again. Leave them for the next run.
    log.error('No channel accepted the alert — leaving mentions unalerted so the next run retries.');
    return { sent: 0, failed: pending.length };
  }

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
