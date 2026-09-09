import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Company, RawMention } from '@ourcrowd/core';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.ts';

function mention(overrides: Partial<RawMention> = {}): RawMention {
  return {
    id: 'm1',
    companyId: 'acme',
    title: 'Acme raises $50M',
    snippet: 'The round was led by existing investors.',
    url: 'https://example.com/a',
    source: 'TechCrunch',
    publishedAt: '2026-09-08T00:00:00Z',
    collectedAt: '2026-09-09T00:00:00Z',
    ...overrides,
  };
}

test('the system prompt pins sentiment to the company, not the article tone', () => {
  assert.match(SYSTEM_PROMPT, /FOR THIS COMPANY'S business/);
  assert.match(SYSTEM_PROMPT, /competitor wins that directly threaten/i);
});

test('the system prompt covers fiction-name collisions', () => {
  assert.match(SYSTEM_PROMPT, /work of fiction/i);
});

test('the system prompt states the exact output schema', () => {
  assert.match(SYSTEM_PROMPT, /"relevance"/);
  assert.match(SYSTEM_PROMPT, /"sentiment"/);
  assert.match(SYSTEM_PROMPT, /"confidence"/);
  assert.match(SYSTEM_PROMPT, /"reasoning"/);
});

test('the user prompt carries the headline, source and snippet', () => {
  const prompt = buildUserPrompt({ id: 'acme', name: 'Acme' }, mention());
  assert.match(prompt, /Company: Acme/);
  assert.match(prompt, /Headline: Acme raises \$50M/);
  assert.match(prompt, /Publication: TechCrunch/);
  assert.match(prompt, /Snippet: The round was led/);
});

test('sector leads the context, since it drives disambiguation', () => {
  const company: Company = { id: 'silo', name: 'Silo', sector: 'produce technology' };
  const prompt = buildUserPrompt(company, mention());
  assert.ok(prompt.indexOf('Sector: produce technology') < prompt.indexOf('Headline:'));
});

test('aliases are passed so former names still match', () => {
  const company: Company = { id: 'lifeward', name: 'Lifeward', aliases: ['ReWalk'] };
  assert.match(buildUserPrompt(company, mention()), /Also known as: ReWalk/);
});

test('optional fields are omitted rather than sent empty', () => {
  const prompt = buildUserPrompt({ id: 'acme', name: 'Acme' }, mention({ snippet: '', source: '' }));
  assert.doesNotMatch(prompt, /Sector:/);
  assert.doesNotMatch(prompt, /Snippet:/);
  assert.doesNotMatch(prompt, /Publication:/);
});

test('a stock ticker is passed so symbol-only coverage is recognised', () => {
  // Regression: an audit found "Why Did DRTS Stock Surge?" filtered out as
  // unrelated to Alpha Tau, when DRTS is exactly its NASDAQ ticker.
  const company: Company = { id: 'alpha-tau', name: 'Alpha Tau', ticker: 'DRTS' };
  assert.match(buildUserPrompt(company, mention()), /Stock ticker: DRTS/);
});

test('the prompt tells the model that ticker-only coverage is relevant', () => {
  assert.match(SYSTEM_PROMPT, /stock ticker is given/i);
});
