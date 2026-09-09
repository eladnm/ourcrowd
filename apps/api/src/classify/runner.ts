import type { Company, RawMention } from '@ourcrowd/core';
import { config } from '../config.ts';
import { log } from '../lib/logger.ts';
import { saveClassification } from '../store/db.ts';
import { OllamaUnavailableError, classifyMention } from './ollama.ts';

export interface ClassifyStats {
  classified: number;
  failed: number;
  irrelevant: number;
}

/**
 * Classify a batch of mentions against a bounded worker pool.
 *
 * Concurrency is low by default (2): Ollama serves requests from one local
 * model, so pushing more parallel requests mostly queues them while raising
 * the chance of a timeout. Each result is written as it lands, so an
 * interrupted run keeps the work it already did and resumes cleanly.
 */
export async function classifyBatch(
  mentions: RawMention[],
  companiesById: Map<string, Company>,
  onProgress?: (done: number, total: number) => void,
): Promise<ClassifyStats> {
  const stats: ClassifyStats = { classified: 0, failed: 0, irrelevant: 0 };
  if (mentions.length === 0) return stats;

  const queue = [...mentions];
  const total = mentions.length;
  let done = 0;
  let aborted: Error | null = null;

  const worker = async (): Promise<void> => {
    while (queue.length > 0 && !aborted) {
      const mention = queue.shift();
      if (!mention) break;

      const company = companiesById.get(mention.companyId);
      if (!company) {
        log.warn(`no company for mention ${mention.id} (${mention.companyId}), skipping`);
        stats.failed++;
        done++;
        onProgress?.(done, total);
        continue;
      }

      try {
        const result = await classifyMention(company, mention);
        saveClassification(mention.id, result);
        stats.classified++;
        if (result.relevance === 'irrelevant') stats.irrelevant++;
      } catch (error) {
        if (error instanceof OllamaUnavailableError) {
          aborted = error;
          break;
        }
        // A single unparseable response shouldn't sink the run; leave the row
        // unclassified so the next run picks it up again.
        stats.failed++;
        log.error(`failed to classify "${mention.title.slice(0, 60)}": ${String(error)}`);
      }

      done++;
      onProgress?.(done, total);
    }
  };

  const workers = Array.from(
    { length: Math.min(config.collection.classifyConcurrency, mentions.length) },
    worker,
  );
  await Promise.all(workers);

  if (aborted) throw aborted;
  return stats;
}
