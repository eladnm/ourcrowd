import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, mentionId } from './mention-id.ts';

test('tracking params and trailing slashes collapse to one identity', () => {
  const a = normalizeUrl('https://www.example.com/story?utm_source=x&id=7');
  const b = normalizeUrl('http://example.com/story?id=7&utm_campaign=y/');
  assert.equal(a, b);
});

test('different articles keep different identities', () => {
  assert.notEqual(normalizeUrl('https://example.com/a'), normalizeUrl('https://example.com/b'));
});

test('malformed urls pass through instead of throwing', () => {
  assert.equal(normalizeUrl('not a url'), 'not a url');
});

test('the same article is a separate mention per company', () => {
  const url = 'https://example.com/joint-venture';
  assert.notEqual(mentionId('acme', url), mentionId('globex', url));
});

test('mention ids are stable across equivalent urls', () => {
  assert.equal(
    mentionId('acme', 'https://www.example.com/x?utm_medium=rss'),
    mentionId('acme', 'https://example.com/x'),
  );
});
