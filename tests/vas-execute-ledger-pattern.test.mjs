import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();

async function fileText(relPath) {
  const abs = path.join(root, relPath);
  return await readFile(abs, 'utf8');
}

// [name, executePath, holdIdemKey, spendIdemKey, entryBuilder?]
// entryBuilder defaults to buildSpend; the voucher gift route posts its own
// ledger shape via buildVoucherGift.
const ROUTES = [
  ['airtime', 'pages/api/vas/airtime/execute.js', 'wapay-air-exec-${previewId}', 'wapay-air-spend-${previewId}'],
  ['data', 'pages/api/vas/data/execute.js', 'wapay-data-exec-${previewId}', 'wapay-data-spend-${previewId}'],
  ['electricity', 'pages/api/vas/electricity/execute.js', 'wapay-elec-exec-${previewId}', 'wapay-elec-spend-${previewId}'],
  ['voucher', 'pages/api/vas/voucher/execute.js', 'wapay-vgift-exec-${previewId}', 'wapay-vgift-spend-${previewId}', 'buildVoucherGift'],
  // Fuel's settle/build calls live in lib/fuel-settlement.js (shared with
  // the reconciler); the route + module are checked as one unit.
  ['fuel', ['pages/api/vas/fuel/execute.js', 'lib/fuel-settlement.js'], 'wapay-fuel-exec-${previewId}', 'wapay-fuel-spend-${previewId}'],
];

test('VAS execute routes use the atomic hold/settle ledger pattern', async () => {
  for (const [name, relPath, holdKey, spendKey, entryBuilder = 'buildSpend'] of ROUTES) {
    const paths = Array.isArray(relPath) ? relPath : [relPath];
    const text = (await Promise.all(paths.map(fileText))).join('\n');

    // Prisma singleton only — a per-route client leaks connections and skips
    // the shared middleware.
    assert.ok(!text.includes('new PrismaClient'), `${name}: must use the lib/prisma singleton, not new PrismaClient()`);

    // The safe money path: reserve before the provider call, settle or release after.
    for (const fn of ['ensureWallet', 'reserveHold', 'settleHold', 'releaseHold', entryBuilder]) {
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
    const paths = Array.isArray(relPath) ? relPath : [relPath];
    const text = (await Promise.all(paths.map(fileText))).join('\n');
    for (const line of text.split('\n')) {
      if (line.includes('Date.now()') && (line.includes('idemKey') || line.includes('wapay-'))) {
        assert.fail(`${name}: non-deterministic idempotency key (Date.now()): ${line.trim()}`);
      }
    }
  }
});

/**
 * Extract the full argument span of every call to the named functions,
 * scanning with balanced parentheses and skipping parens inside '…', "…" and
 * `…` literals, so a paren in a log message cannot truncate a span.
 *
 * @param {string} text - source code
 * @param {RegExp} callRe - global regex whose match ends at the opening '('
 * @returns {string[]} one string per call, from the function name through the
 *   matching close paren
 */
function callSpans(text, callRe) {
  const spans = [];
  let m;
  while ((m = callRe.exec(text)) !== null) {
    let i = callRe.lastIndex; // first char after the opening '('
    let depth = 1;
    let quote = null;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (quote) {
        if (ch === '\\') i += 1; // skip the escaped char
        else if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
      } else if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
      }
      i += 1;
    }
    spans.push(text.slice(m.index, i));
  }
  return spans;
}

test('voucher gift execute never logs or returns the voucher PIN', async () => {
  const text = await fileText('pages/api/vas/voucher/execute.js');

  // The PIN is a bearer secret with exactly one sink: the pending_gifts store
  // that the claim flow reads.
  assert.ok(text.includes('createPendingGift'), 'voucher: must hand the PIN to createPendingGift');
  assert.ok(text.includes('voucherPin'), 'voucher: expected the voucherPin field on the createPendingGift call');

  // Every logging call and every HTTP response body, with full argument spans.
  const spans = [
    ...callSpans(text, /\b(?:logStructured|logMetric|captureError|console\.(?:log|error|warn|info|debug))\s*\(/g),
    ...callSpans(text, /\.json\s*\(/g),
  ];
  assert.ok(spans.length > 10, `voucher: expected to find logging/response calls to scan, got ${spans.length}`);

  // PIN material: the voucherPin variable/field, or any `.pin` property read
  // (e.g. voucher.pin) — masked or not, the PIN never enters a log or response.
  const pinMaterial = /voucherPin|\.pin\b/;
  for (const span of spans) {
    assert.ok(
      !pinMaterial.test(span),
      `voucher: PIN material inside a log/metric/response call:\n${span.slice(0, 300)}`
    );
  }
});
