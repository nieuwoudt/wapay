/**
 * The dead code Phase 3 retires (docs/AGENT_ARCHITECTURE_V2.md section 8,
 * docs/HANDOVER_V1.5.md section 4 item 4), removed 2026-09-18.
 *
 * Three things, each dangerous in the same way: a second implementation of
 * something the product already does once, sitting in the tree waiting to be
 * picked up by someone who does not know which one is real.
 *
 *  1. A second WhatsApp client (`WhatsAppClient`, `Templates`,
 *     `formatCurrencyCents` in the package barrel, and an orphaned
 *     `templates.ts`). A second way to send is a way to send that lib/say.js
 *     does not record, so a customer could be told something the agent's
 *     memory never sees.
 *  2. `postBluDeposit` in `packages/domain/src/ledger.ts`: a ledger writer
 *     that set no idemKey (so it could double-post), incremented wallet
 *     balances directly instead of deriving them from the journal, and used
 *     account codes no reader in this product knows. It bypassed every money
 *     rule in CLAUDE.md.
 *  3. The `UserSavedAccount` Prisma model: a table no migration ever created
 *     and no code ever read.
 *
 * Their only importer was `apps/*`, which is outside `build:packages` and
 * does not compile.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function appSources(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.next', '.git', 'dist', '.pnpm-store', 'apps'].includes(entry)) continue;
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) appSources(full, acc);
    else if (/\.(js|mjs|ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

test('there is one WhatsApp sender, and the second client cannot come back', () => {
  // Definitions, not mentions: the file's own header explains what was
  // removed and why, and should go on saying so.
  const barrel = read('../packages/whatsapp/src/index.ts').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/class WhatsAppClient/.test(barrel), 'the class is gone');
  assert.ok(!/export const Templates/.test(barrel), 'the parallel template builder is gone');
  assert.ok(!/function formatCurrencyCents/.test(barrel));
  assert.ok(!existsSync(`${root}packages/whatsapp/src/templates.ts`), 'the orphaned template file is gone');
  assert.match(barrel, /from '\.\/send\.js'/, 'send.ts is the one sender');
});

test('no bypassing ledger writer exists in the tree', () => {
  assert.ok(!existsSync(`${root}packages/domain/src/ledger.ts`), 'postBluDeposit is deleted, not merely unused');
  assert.ok(!/ledger\.js/.test(read('../packages/domain/src/index.ts')), 'and is not re-exported');
  const offenders = appSources(root)
    .filter((f) => !f.includes('/tests/'))
    .filter((f) => /postBluDeposit/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => f.replace(root, '')), []);
});

test('the schema carries no model nothing reads', () => {
  const schema = read('../packages/domain/prisma/schema.prisma');
  assert.ok(!/UserSavedAccount|user_saved_accounts/.test(schema));
});
