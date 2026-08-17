import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();

async function fileText(relPath) {
  const abs = path.join(root, relPath);
  return await readFile(abs, 'utf8');
}

const ROUTES = [
  ['airtime', 'pages/api/vas/airtime/execute.js', 'wapay-air-exec-${previewId}', 'wapay-air-spend-${previewId}'],
  ['data', 'pages/api/vas/data/execute.js', 'wapay-data-exec-${previewId}', 'wapay-data-spend-${previewId}'],
  ['electricity', 'pages/api/vas/electricity/execute.js', 'wapay-elec-exec-${previewId}', 'wapay-elec-spend-${previewId}'],
];

test('VAS execute routes use the atomic hold/settle ledger pattern', async () => {
  for (const [name, relPath, holdKey, spendKey] of ROUTES) {
    const text = await fileText(relPath);

    // Prisma singleton only — a per-route client leaks connections and skips
    // the shared middleware.
    assert.ok(!text.includes('new PrismaClient'), `${name}: must use the lib/prisma singleton, not new PrismaClient()`);

    // The safe money path: reserve before the provider call, settle or release after.
    for (const fn of ['ensureWallet', 'reserveHold', 'settleHold', 'releaseHold', 'buildSpend']) {
      assert.ok(text.includes(fn), `${name}: must use ${fn}`);
    }

    // No inline journal writes — settleHold posts the entry atomically.
    assert.ok(!text.includes('journalEntry.create'), `${name}: must not create journal entries inline`);

    // Deterministic idempotency keys, so a retry after a timeout replays the
    // same vend instead of double-spending.
    assert.ok(text.includes(holdKey), `${name}: hold idemKey must be ${holdKey}`);
    assert.ok(text.includes(spendKey), `${name}: spend idemKey must be ${spendKey}`);
  }
});

test('VAS execute routes never put Date.now() in idempotency material', async () => {
  for (const [name, relPath] of ROUTES) {
    const text = await fileText(relPath);
    for (const line of text.split('\n')) {
      if (line.includes('Date.now()') && (line.includes('idemKey') || line.includes('wapay-'))) {
        assert.fail(`${name}: non-deterministic idempotency key (Date.now()): ${line.trim()}`);
      }
    }
  }
});
