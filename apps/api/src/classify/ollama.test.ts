import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, validate, modelIsAvailable } from './ollama.ts';

/**
 * These two functions are the guard between whatever a local model emits and
 * what reaches the database. A hallucinated label must never be stored, so the
 * failure cases matter more than the happy path.
 */

const GOOD = {
  relevance: 'relevant',
  sentiment: 'positive',
  confidence: 0.9,
  reasoning: 'funding round',
};

test('parses a clean JSON object', () => {
  assert.deepEqual(extractJson(JSON.stringify(GOOD)), GOOD);
});

test('recovers JSON wrapped in prose', () => {
  const wrapped = `Here is my answer:\n${JSON.stringify(GOOD)}\nHope that helps.`;
  assert.deepEqual(extractJson(wrapped), GOOD);
});

test('recovers JSON inside a code fence', () => {
  assert.deepEqual(extractJson('```json\n' + JSON.stringify(GOOD) + '\n```'), GOOD);
});

test('throws when there is no JSON object at all', () => {
  assert.throws(() => extractJson('I am not sure about this one.'), /no JSON object/);
});

test('a valid response becomes a Classification', () => {
  const result = validate(GOOD, 'test-model');
  assert.equal(result.sentiment, 'positive');
  assert.equal(result.relevance, 'relevant');
  assert.equal(result.confidence, 0.9);
  assert.equal(result.model, 'test-model');
  assert.ok(result.classifiedAt);
});

test('labels are accepted case-insensitively', () => {
  const result = validate({ ...GOOD, sentiment: 'POSITIVE', relevance: 'Relevant' }, 'm');
  assert.equal(result.sentiment, 'positive');
  assert.equal(result.relevance, 'relevant');
});

test('an invented sentiment label is rejected', () => {
  assert.throws(() => validate({ ...GOOD, sentiment: 'very positive' }, 'm'), /invalid sentiment/);
});

test('an invented relevance label is rejected', () => {
  assert.throws(() => validate({ ...GOOD, relevance: 'maybe' }, 'm'), /invalid relevance/);
});

test('a missing sentiment is rejected rather than defaulted', () => {
  assert.throws(() => validate({ relevance: 'relevant' }, 'm'), /invalid sentiment/);
});

test('non-object output is rejected', () => {
  assert.throws(() => validate('positive', 'm'), /not an object/);
  assert.throws(() => validate(null, 'm'), /not an object/);
});

test('out-of-range confidence is clamped, not rejected', () => {
  assert.equal(validate({ ...GOOD, confidence: 5 }, 'm').confidence, 1);
  assert.equal(validate({ ...GOOD, confidence: -2 }, 'm').confidence, 0);
});

test('unparseable confidence falls back to 0.5', () => {
  assert.equal(validate({ ...GOOD, confidence: 'high' }, 'm').confidence, 0.5);
});

test('runaway reasoning is truncated', () => {
  const result = validate({ ...GOOD, reasoning: 'x'.repeat(1000) }, 'm');
  assert.equal(result.reasoning.length, 300);
});

test('missing reasoning is tolerated as empty', () => {
  assert.equal(validate({ relevance: 'relevant', sentiment: 'neutral' }, 'm').reasoning, '');
});

test('a tagged model name does not match a different tag of the same family', () => {
  assert.equal(modelIsAvailable(['llama3.1:70b'], 'llama3.1:8b'), false);
  assert.equal(modelIsAvailable(['llama3.1:8b'], 'llama3.1:8b'), true);
});

test('a bare model name matches any pulled tag of that model', () => {
  assert.equal(modelIsAvailable(['llama3.1:8b'], 'llama3.1'), true);
  assert.equal(modelIsAvailable(['mistral:7b'], 'llama3.1'), false);
});
