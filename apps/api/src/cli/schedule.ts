/**
 * In-process daily scheduler — an alternative to an OS cron entry for anyone
 * who would rather leave one long-running process up.
 *
 *   pnpm --filter @ourcrowd/api schedule
 *
 * Runs the daily alert every 24h, starting immediately. For production you
 * would use cron or a workflow runner instead; the README documents both.
 */
import { log } from '../lib/logger.ts';
import { runDailyAlert } from './alert.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

let running = false;

async function tick() {
  if (running) {
    log.warn('previous daily run still in progress — skipping this tick');
    return;
  }
  running = true;
  try {
    await runDailyAlert();
  } catch (error) {
    // Never let one bad day kill the scheduler.
    log.error(`daily run failed: ${String(error)}`);
  } finally {
    running = false;
  }
}

log.info('Scheduler started — running the daily alert now, then every 24h.');
log.info('Ctrl+C to stop.');
void tick();
setInterval(() => void tick(), DAY_MS);
