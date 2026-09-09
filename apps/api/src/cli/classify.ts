/**
 * Classify every stored mention that has not been through the model yet.
 *
 *   pnpm classify                 # everything pending
 *   pnpm classify -- --since 30   # only coverage from the last 30 days
 *   pnpm classify -- --limit 20   # a small batch, for a spot-check
 *   pnpm classify -- --relabel    # redo labels decided under an older prompt,
 *                                 # for companies that since gained context
 *
 * Safe to interrupt and re-run: each result is written as it lands, and rows
 * left unclassified are simply picked up next time.
 */
import { classifyBatch } from '../classify/runner.ts';
import { checkOllama } from '../classify/ollama.ts';
import { config } from '../config.ts';
import { log } from '../lib/logger.ts';
import { parseArgs } from '../lib/args.ts';
import { AlreadyReportedError } from '../lib/errors.ts';
import {
  clearClassifications,
  finishRun,
  getCompanies,
  getUnclassifiedMentions,
  startRun,
} from '../store/db.ts';

export async function runClassify(
  options: {
    limit?: number;
    sinceDays?: number;
    companyIds?: string[];
    relabel?: boolean;
    relabelAll?: boolean;
    relabelBefore?: string;
  } = {},
) {
  const health = await checkOllama();
  if (!health.ok) {
    // The message already carries the install/pull guidance, so mark it as
    // reported and let the entry point exit without printing a second line.
    log.error('Ollama is not ready:\n' + health.message);
    throw new AlreadyReportedError('Ollama unavailable');
  }
  log.info(health.message);

  // When relabelling, classify exactly what was cleared. Otherwise a prompt
  // tweak would drag the whole pending backlog along with it.
  let relabelled: string[] | undefined;
  if (options.relabel) {
    relabelled = clearClassifications({
      before: options.relabelBefore,
      onlyWithContext: !options.relabelAll,
    });
    log.info(
      `Cleared ${relabelled.length} existing label${relabelled.length === 1 ? '' : 's'} for re-classification` +
        (options.relabelAll ? '' : ' (companies carrying sector/ticker context)'),
    );
  }

  const pending = getUnclassifiedMentions({
    limit: options.limit,
    sinceDays: options.sinceDays,
    companyIds: options.companyIds,
    mentionIds: relabelled,
  });
  if (pending.length === 0) {
    log.info('Nothing to classify — every stored mention already has a label.');
    return { classified: 0, failed: 0, irrelevant: 0 };
  }

  const companiesById = new Map(getCompanies().map((c) => [c.id, c]));
  const scope = options.sinceDays ? ` published in the last ${options.sinceDays} days` : '';
  log.step(`Classifying ${pending.length} mentions${scope} with ${config.ollama.model}`);

  const runId = startRun('classify');
  const startedAt = Date.now();
  let lastLogged = 0;

  const stats = await classifyBatch(pending, companiesById, (done, total) => {
    // Log every 10 to keep a long run legible without flooding the terminal.
    if (done - lastLogged >= 10 || done === total) {
      lastLogged = done;
      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = done / Math.max(elapsed, 0.001);
      const remaining = Math.round((total - done) / Math.max(rate, 0.001));
      log.info(`  ${done}/${total} (${rate.toFixed(1)}/s, ~${remaining}s left)`);
    }
  });

  finishRun(runId, {
    mentionsClassified: stats.classified,
    errors: stats.failed,
    notes: `model=${config.ollama.model} irrelevant=${stats.irrelevant}`,
  });

  log.step('Classification complete');
  log.info(`  classified: ${stats.classified}`);
  log.info(`  irrelevant: ${stats.irrelevant} (filtered off the dashboard)`);
  if (stats.failed) log.warn(`  failed:     ${stats.failed} (left for the next run)`);

  return stats;
}

if (import.meta.filename === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  runClassify({
    limit: args.limit,
    sinceDays: args.since,
    relabel: args.relabel,
    relabelAll: args.relabelAll,
    relabelBefore: args.relabelBefore,
  }).catch((error) => {
    if (!(error instanceof AlreadyReportedError)) log.error(String(error));
    process.exit(1);
  });
}
