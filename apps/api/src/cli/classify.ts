/**
 * Classify every stored mention that has not been through the model yet.
 *
 *   pnpm classify                 # everything pending
 *   pnpm classify -- --since 30   # only coverage from the last 30 days
 *   pnpm classify -- --limit 20   # a small batch, for a spot-check
 *
 * Safe to interrupt and re-run: each result is written as it lands, and rows
 * left unclassified are simply picked up next time.
 */
import { classifyBatch } from '../classify/runner.ts';
import { checkOllama } from '../classify/ollama.ts';
import { config } from '../config.ts';
import { log } from '../lib/logger.ts';
import { parseArgs } from '../lib/args.ts';
import {
  finishRun,
  getCompanies,
  getUnclassifiedMentions,
  startRun,
} from '../store/db.ts';

export async function runClassify(options: { limit?: number; sinceDays?: number } = {}) {
  const health = await checkOllama();
  if (!health.ok) {
    log.error('Ollama is not ready:\n' + health.message);
    throw new Error('Ollama unavailable');
  }
  log.info(health.message);

  const pending = getUnclassifiedMentions({
    limit: options.limit,
    sinceDays: options.sinceDays,
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
  runClassify({ limit: args.limit, sinceDays: args.since }).catch((error) => {
    log.error(String(error));
    process.exit(1);
  });
}
