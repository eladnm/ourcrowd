import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkEmptyOverwrite } from './export.ts';

/**
 * The guard exists because it is easy to point DATABASE_PATH at a scratch
 * database, run export, and silently replace the committed data/ deliverable
 * with zero rows. Tested as a pure decision over a temp directory, so no test
 * can reach the real exports.
 */
function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'ourcrowd-export-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('refuses to replace real results with an empty export', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'mentions.json'), JSON.stringify([{ id: 'a' }, { id: 'b' }]));
    assert.equal(checkEmptyOverwrite(dir, 0, false), 2);
  });
});

test('a non-empty export is always allowed through', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'mentions.json'), JSON.stringify([{ id: 'a' }]));
    assert.equal(checkEmptyOverwrite(dir, 5, false), null);
  });
});

test('--force allows deliberately writing an empty export', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'mentions.json'), JSON.stringify([{ id: 'a' }]));
    assert.equal(checkEmptyOverwrite(dir, 0, true), null);
  });
});

test('a first export into an empty directory is not blocked', () => {
  withDir((dir) => assert.equal(checkEmptyOverwrite(dir, 0, false), null));
});

test('overwriting an already-empty export is not blocked', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'mentions.json'), '[]');
    assert.equal(checkEmptyOverwrite(dir, 0, false), null);
  });
});

test('an unreadable existing export does not block the run', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'mentions.json'), 'not json at all');
    assert.equal(checkEmptyOverwrite(dir, 0, false), null);
  });
});
