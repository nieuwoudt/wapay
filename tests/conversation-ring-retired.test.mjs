/**
 * The legacy conversation ring is gone (2026-09-18, C14 of
 * docs/AGENT_ARCHITECTURE_V2.md).
 *
 * `Account.conversationData.history` held the last ten messages of each chat.
 * It was written at 63 call sites in the processor and read at none: memory is
 * the append-only `conversation_turns` table, recorded by construction on
 * every send through `lib/say.js`. Each ring write was also a read-modify-write
 * of the whole `conversationData` column, which carries live flow state and
 * the inbound dedupe list, so every one of them was a chance to clobber them.
 *
 * What this locks is that it does not come back, and that an erasure covers
 * the residue an older account may still carry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function sourceFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.next', '.git', 'dist', '.pnpm-store'].includes(entry)) continue;
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(js|mjs|ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

test('nothing writes or reads the ring any more, anywhere', () => {
  const offenders = [];
  for (const file of sourceFiles(root)) {
    if (file.includes('/tests/')) continue; // this file names the helpers to forbid them
    const src = readFileSync(file, 'utf8');
    if (/addToConversationHistory|getConversationHistory/.test(src)) offenders.push(file.replace(root, ''));
  }
  assert.deepEqual(offenders, [], 'the ring helpers are gone and nothing calls them');
});

test('the helpers themselves are deleted, with a note saying what replaced them', () => {
  const userManager = read('../pages/api/webhooks/user-manager.js');
  assert.ok(!/export async function addToConversationHistory/.test(userManager));
  assert.ok(!/export async function getConversationHistory/.test(userManager));
  assert.match(userManager, /conversation_turns/, 'the replacement is named where the helpers used to be');
});

test('memory still has both sides: the customer through recordInbound, the reply through say.js', () => {
  const processor = read('../pages/api/webhooks/message-processor-v2.js');
  assert.match(processor, /import \{ sendWhatsAppText, recordInbound \} from '\.\.\/\.\.\/\.\.\/lib\/say\.js';/);
  assert.match(processor, /recordInbound\(/);
  assert.match(read('../lib/say.js'), /recordTurn/, 'every send records the assistant side by construction');
});

test('an erasure clears the residue an older account may still carry, and only that key', () => {
  const processor = read('../pages/api/webhooks/message-processor-v2.js');
  const fn = processor.slice(processor.indexOf('async function handleForgetMe('), processor.indexOf('/** The home card\'s Transactions line'));
  assert.match(fn, /"conversationData" - 'history'/, 'the ring key is dropped');
  assert.match(fn, /WHERE id = \$\{account\.id\}/, 'only this customer');
  assert.ok(!/SET "conversationData" = '\{\}'/.test(fn), 'flow state and the dedupe list are not wiped with it');
  assert.match(fn, /eraseTurns\(/, 'the real memory is still erased too');
});

test('the migration that cleans existing rows is idempotent and key-scoped', () => {
  const sql = read('../packages/domain/prisma/migrations/20260918_drop_conversation_ring/migration.sql');
  assert.match(sql, /"conversationData" - 'history'/);
  assert.match(sql, /WHERE "conversationData" \? 'history'/, 'rows without the key are untouched, so a re-run is free');
  assert.ok(!/DROP COLUMN/.test(sql), 'the column still holds live flow state; only the key goes');
});
