import 'dotenv/config';
import { resolve } from 'node:path';

/** Repo root, so data paths resolve the same from any working directory. */
export const ROOT = resolve(import.meta.dirname, '../../..');

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  ollama: {
    host: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL ?? 'llama3.1:8b',
    timeoutMs: num(process.env.OLLAMA_TIMEOUT_MS, 180_000),
  },
  collection: {
    windowDays: num(process.env.COLLECTION_WINDOW_DAYS, 90),
    fetchDelayMs: num(process.env.FETCH_DELAY_MS, 1200),
    classifyConcurrency: num(process.env.CLASSIFY_CONCURRENCY, 2),
  },
  databasePath: process.env.DATABASE_PATH
    ? resolve(ROOT, process.env.DATABASE_PATH)
    : resolve(ROOT, 'data/press.db'),
  companiesPath: resolve(ROOT, 'data/companies.json'),
  exportDir: resolve(ROOT, 'data'),
  port: num(process.env.PORT, 4000),
  alert: {
    channel: (process.env.ALERT_CHANNEL ?? 'console') as 'console' | 'webhook' | 'both',
    webhookUrl: process.env.ALERT_WEBHOOK_URL ?? '',
  },
} as const;
