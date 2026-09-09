import type { Classification, Company, RawMention, Sentiment } from '@ourcrowd/core';
import { config } from '../config.ts';
import { log } from '../lib/logger.ts';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.ts';

/** Raised when Ollama is unreachable, so the CLI can print install guidance. */
export class OllamaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaUnavailableError';
  }
}

const SENTIMENTS = new Set<string>(['positive', 'negative', 'neutral']);
const RELEVANCES = new Set<string>(['relevant', 'irrelevant']);

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

/** Confirm the daemon is up and the configured model is pulled. */
export async function checkOllama(): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch(`${config.ollama.host}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { ok: false, message: `Ollama responded with HTTP ${response.status}` };
    }
    const body = (await response.json()) as { models?: { name: string }[] };
    const available = (body.models ?? []).map((m) => m.name);

    // Ollama reports "llama3.1:8b"; tolerate a configured bare "llama3.1".
    const wanted = config.ollama.model;
    const present = available.some((name) => name === wanted || name.split(':')[0] === wanted.split(':')[0]);
    if (!present) {
      return {
        ok: false,
        message:
          `Model "${wanted}" is not available. Pull it with:\n  ollama pull ${wanted}\n` +
          (available.length ? `Installed models: ${available.join(', ')}` : 'No models installed.'),
      };
    }
    return { ok: true, message: `Ollama ready at ${config.ollama.host} with ${wanted}` };
  } catch (error) {
    return {
      ok: false,
      message:
        `Cannot reach Ollama at ${config.ollama.host} (${String(error)}).\n` +
        'Install it from https://ollama.com/download, then run:\n' +
        `  ollama serve\n  ollama pull ${config.ollama.model}`,
    };
  }
}

/**
 * Models sometimes wrap JSON in prose or a code fence even under `format: json`.
 * Take the first balanced object rather than trusting the whole string.
 *
 * Exported for tests: this and `validate` are the guard between model output
 * and the database, so they are worth testing without a live daemon.
 */
export function extractJson(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error(`no JSON object in model output: ${trimmed.slice(0, 120)}`);
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

/**
 * Coerce the model's object into a Classification, rejecting anything that
 * does not match the schema. A hallucinated label must not reach the database.
 */
export function validate(raw: unknown, model: string): Classification {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('model output was not an object');
  }
  const obj = raw as Record<string, unknown>;

  const sentiment = String(obj.sentiment ?? '').toLowerCase().trim();
  if (!SENTIMENTS.has(sentiment)) {
    throw new Error(`invalid sentiment: ${JSON.stringify(obj.sentiment)}`);
  }

  const relevance = String(obj.relevance ?? '').toLowerCase().trim();
  if (!RELEVANCES.has(relevance)) {
    throw new Error(`invalid relevance: ${JSON.stringify(obj.relevance)}`);
  }

  const parsedConfidence = Number(obj.confidence);
  const confidence = Number.isFinite(parsedConfidence)
    ? Math.min(1, Math.max(0, parsedConfidence))
    : 0.5;

  const reasoning = String(obj.reasoning ?? '').trim().slice(0, 300);

  return {
    sentiment: sentiment as Sentiment,
    relevance: relevance as Classification['relevance'],
    confidence,
    reasoning,
    model,
    classifiedAt: new Date().toISOString(),
  };
}

/**
 * Classify one mention. Retries once on a malformed response — small local
 * models occasionally emit a stray token, and a single retry recovers most of
 * those without meaningfully slowing the run.
 */
export async function classifyMention(
  company: Company,
  mention: RawMention,
  attempts = 2,
): Promise<Classification> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${config.ollama.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.ollama.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(company, mention) },
          ],
          stream: false,
          format: 'json',
          options: {
            // Deterministic: the same article should classify the same way on
            // a re-run, which also makes the spot-check reproducible.
            temperature: 0,
            num_predict: 200,
          },
        }),
        signal: AbortSignal.timeout(config.ollama.timeoutMs),
      });
    } catch (error) {
      // Distinguish "this request took too long" from "the daemon is gone".
      // A timeout is usually one slow generation under load and should cost us
      // a single mention, not the whole run; a refused connection means the
      // daemon died, and continuing would just replay the same failure
      // thousands of times.
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      if (!timedOut) {
        throw new OllamaUnavailableError(
          `Lost connection to Ollama at ${config.ollama.host}: ${String(error)}`,
        );
      }
      lastError = error;
      if (attempt < attempts) {
        log.warn(`classify timed out for "${mention.title.slice(0, 60)}", retrying`);
      }
      continue;
    }

    try {
      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
      const body = (await response.json()) as OllamaChatResponse;
      if (body.error) throw new Error(body.error);
      const content = body.message?.content;
      if (!content) throw new Error('empty response from model');
      return validate(extractJson(content), config.ollama.model);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        log.warn(`classify retry for "${mention.title.slice(0, 60)}": ${String(error)}`);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
