/**
 * Browser-safe surface: types plus the pure status calculations, so the
 * dashboard and the backend agree on how a "mention status" is derived.
 *
 * Node-only helpers (mention-id, which needs node:crypto) live behind the
 * "@ourcrowd/core/node" entry point instead.
 */
export * from './types.ts';
export * from './status.ts';
