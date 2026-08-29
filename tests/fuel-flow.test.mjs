/**
 * Fuel wiCode flow guards (v1.3 Task 3) — statics over the processor,
 * execute route, and gating config, plus behavioral drives of the shipped
 * matcher. The full-money proof lives in tests/e2e/fuel-e2e.mjs and
 * tests/e2e/fuel-chat-e2e.mjs (scratch schema + local UniFuel).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { VAS_CATEGORY_CONFIG } from '../lib/vas-config.js';
import { FEES } from '../lib/ledger-core.js';

const processorSource = readFileSync(
  fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)),
  'utf8'
);
const executeSource = readFileSync(
  fileURLToPath(new URL('../pages/api/vas/fuel/execute.js', import.meta.url)),
  'utf8'
);
const webhookSource = readFileSync(
  fileURLToPath(new URL('../pages/api/webhooks/unifuel.js', import.meta.url)),
  'utf8'
);
const clientSource = readFileSync(
  fileURLToPath(new URL('../lib/unifuel-client.js', import.meta.url)),
  'utf8'
);
const settlementSource = readFileSync(
  fileURLToPath(new URL('../lib/fuel-settlement.js', import.meta.url)),
  'utf8'
);

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

test('FUEL is gated on the wiCode production flag and defaults OFF', () => {
  // This test process has no WAPAY_WICODE_LIVE, so the shipped default must
  // be coming-soon.
  assert.equal(VAS_CATEGORY_CONFIG.FUEL.enabled, false);
  assert.equal(VAS_CATEGORY_CONFIG.FUEL.comingSoon, true);
  assert.equal(VAS_CATEGORY_CONFIG.FUEL.provider, 'YOYO');
  const vasConfig = readFileSync(fileURLToPath(new URL('../lib/vas-config.js', import.meta.url)), 'utf8');
  assert.match(vasConfig, /FUEL: process\.env\.WAPAY_WICODE_LIVE === 'true'/);
});

test('fuel commission defaults to 0 bps until a rate is signed', () => {
  assert.equal(FEES.commissionBps.FUEL, 0);
  assert.match(settlementSource, /WAPAY_WICODE_COMMISSION_BPS/);
});

test('every fuel entry point checks the category gate before any flow', () => {
  const fn = processorSource.slice(
    processorSource.indexOf('async function startFuelPurchase'),
    processorSource.indexOf('function logInternalFetchCall')
  );
  assert.match(fn, /if \(!isCategoryLive\('FUEL'\)\) \{/);
  assert.match(fn, /fuelComingSoonReply\(\)/);
  // The gate line comes before the preview call.
  assert.ok(fn.indexOf("isCategoryLive('FUEL')") < fn.indexOf('/api/vas/fuel/preview'));
});

// ---------------------------------------------------------------------------
// Matcher precision
// ---------------------------------------------------------------------------

function extractMatcher() {
  const start = processorSource.indexOf('function matchFuelPurchase(');
  assert.ok(start > -1);
  const end = processorSource.indexOf('\n}', start);
  const body = processorSource.slice(start, end + 2);
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return matchFuelPurchase;`)();
}

test('fuel matcher: purchase commands match, questions fall to the AI', () => {
  const m = extractMatcher();
  // Purchase commands:
  for (const t of ['buy fuel', 'Buy R200 petrol', 'fuel voucher', 'petrol R100', 'diesel', 'thenga petrol']) {
    assert.ok(m(t), `should match: ${t}`);
  }
  // Questions and mentions go to the AI (conversational answer):
  for (const t of [
    'Can I buy petrol with WaPay?',
    'where does the fuel voucher work',
    'how much is fuel these days',
    'is diesel cheaper than petrol?',
    'I put petrol in my car yesterday',
    'Petrol went up to R25 again',
    'The fuel voucher never arrived',
    'my fuel voucher is missing',
  ]) {
    assert.ok(!m(t), `should NOT match: ${t}`);
  }
});

// ---------------------------------------------------------------------------
// State machine hygiene
// ---------------------------------------------------------------------------

test('FUEL_AMOUNT carries the conversational-escape backstop (BUGLOG #29 family)', () => {
  const stateCase = processorSource.slice(
    processorSource.indexOf("case 'FUEL_AMOUNT'"),
    processorSource.indexOf("case 'FUEL_CONFIRM'")
  );
  assert.match(stateCase, /isConversationalEscape\(text\)/);
  assert.match(stateCase, /handlePostOnboarding\(\{ account, from, text \}\)/);
});

test('FUEL_CONFIRM accepts the multilingual YES words; FUEL_PIN only PIN-shaped input', () => {
  const confirmCase = processorSource.slice(
    processorSource.indexOf("case 'FUEL_CONFIRM'"),
    processorSource.indexOf("case 'FUEL_PIN'")
  );
  assert.match(confirmCase, /yebo\|ewe\|ja\|ee\|eya/);
  const pinCase = processorSource.slice(
    processorSource.indexOf("case 'FUEL_PIN'"),
    processorSource.indexOf("case 'VOUCHER_GIFT_CONFIRM'")
  );
  assert.match(pinCase, /digitsOnly\.length < 4 \|\| digitsOnly\.length > 6/);
  assert.match(pinCase, /PENDING_CONFIRMATION/, 'the indeterminate outcome has its own reassurance path');
});

test('dispatch carries a BUY_FUEL case routed through startFuelPurchase', () => {
  assert.match(processorSource, /case 'BUY_FUEL': \{/);
  const dispatchCase = processorSource.slice(
    processorSource.indexOf("case 'BUY_FUEL'"),
    processorSource.indexOf("case 'SEND_VOUCHER'")
  );
  assert.match(dispatchCase, /startFuelPurchase\(\{ from, account, amountCents: amountCents \|\| null, rawText: text \}\)/);
});

// ---------------------------------------------------------------------------
// Money-safety of the execute route (beyond the shared ledger-pattern test)
// ---------------------------------------------------------------------------

test('execute: UNKNOWN keeps the hold — no release, crash guard disarmed', () => {
  // The reconcile line also tests UNKNOWN — anchor past it to the real
  // still-indeterminate block.
  const unknownBlock = executeSource.slice(
    executeSource.indexOf("if (outcome.outcome === 'UNKNOWN'", executeSource.indexOf('outcome = await orderStatus')),
    executeSource.indexOf('// ISSUED — the voucher EXISTS')
  );
  assert.match(unknownBlock, /holdIdemKey = null/, 'crash-release guard must not release an indeterminate hold');
  assert.ok(!unknownBlock.includes('releaseHold'), 'never release on UNKNOWN');
  assert.match(unknownBlock, /status: 'RECONCILE'/);
  assert.match(unknownBlock, /sendOpsAlert/);
});

test('execute: concurrency gate — one owner per purchase, stale takeover only', () => {
  assert.match(executeSource, /status: 'EXECUTING',[\s\S]{0,40}metadata: \{ \.\.\.metadata, executingAt: new Date\(\)\.toISOString\(\) \}/);
  assert.match(executeSource, /if \(flipped\.count !== 1\)/);
  assert.match(executeSource, /IN_PROGRESS/);
  assert.match(executeSource, /TAKEOVER_MS = 120_000/);
});

test('execute: ISSUED disarms the crash guard BEFORE settling; settle failure goes to RECONCILE', () => {
  const issuedBlock = executeSource.slice(
    executeSource.indexOf('// ISSUED — the voucher EXISTS'),
    executeSource.indexOf('const updatedWallet')
  );
  const disarmAt = issuedBlock.indexOf('holdIdemKey = null');
  const settleAt = issuedBlock.indexOf('settleIssuedFuelPurchase');
  assert.ok(disarmAt > -1 && settleAt > disarmAt, 'disarm strictly before settle');
  assert.match(issuedBlock, /status: 'RECONCILE'/, 'settle failure queues the idempotent retry');
  assert.ok(!issuedBlock.includes('releaseHold'), 'an issued voucher is never refunded by a crash');
});

test('the reconciler exists and the processor retries indeterminate purchases on every message', () => {
  assert.match(settlementSource, /export async function reconcileFuelPurchases/);
  assert.match(settlementSource, /status: \{ in: \['RECONCILE', 'EXECUTING'\] \}/);
  assert.match(settlementSource, /releaseHold\(\{[\s\S]{0,20}idemKey: `wapay-fuel-exec-\$\{row\.id\}`/);
  assert.match(processorSource, /reconcileFuelPurchases\(\{ account \}\)/);
  const hookAt = processorSource.indexOf('reconcileFuelPurchases({ account })');
  const claimAt = processorSource.indexOf('hasPendingGifts({ recipientMsisdn: account.msisdn })');
  assert.ok(hookAt > -1 && claimAt > hookAt, 'reconcile runs BEFORE the claim block so fresh codes deliver same-turn');
});

test('FUEL is a strong-intent-switch candidate (fuel asks escape waiting flows)', () => {
  assert.match(processorSource, /\['FUEL', matchFuelPurchase\(t\)\]/);
  assert.match(processorSource, /state\.startsWith\('FUEL'\) \? 'FUEL'/);
});

test('execute: one immediate reconcile via orderStatus before giving up', () => {
  assert.match(executeSource, /outcome = await orderStatus\(reference\)/);
});

test('the compact reference respects the probed Yoyo userRef limit', () => {
  assert.match(settlementSource, /\.slice\(0, 38\)/);
  assert.match(settlementSource, /replace\(\/\^preview-fuel-\/, ''\)/);
  assert.match(executeSource, /const reference = fuelReference\(previewId\)/);
});

test('the wiCode is a bearer secret: never logged, never in HTTP responses', () => {
  // The only wicode sink is createPendingGift inside the settlement module.
  assert.match(settlementSource, /voucherPin: wicode/);
  assert.ok(!/logStructured\([^)]*wicode/i.test(settlementSource), 'no wicode in settlement logs');
  assert.ok(!/logStructured\([^)]*wicode/i.test(executeSource), 'no wicode in execute logs');
  assert.ok(!/wicode/.test(executeSource.slice(executeSource.indexOf('return res.status(200).json'))), 'no wicode in the success response');
  // The client module never logs the code either.
  assert.ok(!/log\([^)]*wicode/i.test(clientSource));
});

test('unifuel client: transport failures are UNKNOWN, never FAILED', () => {
  assert.match(clientSource, /TRANSPORT_INDETERMINATE/);
  assert.match(clientSource, /outcome: 'UNKNOWN', code: 'TRANSPORT'/);
  // Only explicit failed/not_found/400 map to FAILED.
  assert.match(clientSource, /if \(body\?\.status === 'failed'\) return \{ outcome: 'FAILED'/);
});

// ---------------------------------------------------------------------------
// Redemption webhook
// ---------------------------------------------------------------------------

test('unifuel webhook: bearer-gated, fail-closed, targeted, replay-guarded', () => {
  assert.match(webhookSource, /timingSafeEqual/);
  assert.match(webhookSource, /status: 503.*NOT_CONFIGURED|NOT_CONFIGURED/s);
  assert.match(webhookSource, /providerRef: String\(reference\), route: 'fuel-preview'/);
  // Targeted claim: only THIS voucher's row is ever flipped — never the
  // account's whole queue (review 2026-08-29).
  assert.match(webhookSource, /where: \{ id: gift\.id, status: 'ISSUED' \}/);
  assert.ok(!webhookSource.includes('claimPendingGifts'), 'the queue-wide claim is banned here');
  // Replay guard: a redemption can only shrink the balance.
  assert.match(webhookSource, /balanceCents >= gift\.amountCents/);
  assert.match(webhookSource, /stale: true/);
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

test('no betting words anywhere in the fuel surfaces', () => {
  const BETTING = /\b(bet|bets|betting|gambl\w*|bookmaker|hollywoodbets|lottostar)\b/i;
  for (const [name, src] of [
    ['execute', executeSource],
    ['webhook', webhookSource],
    ['client', clientSource],
  ]) {
    assert.ok(!BETTING.test(src), `betting words banned in ${name}`);
  }
});

test('Mission Control sells fuel under its own label', () => {
  const metrics = readFileSync(fileURLToPath(new URL('../pages/api/admin/metrics.js', import.meta.url)), 'utf8');
  assert.match(metrics, /SPEND_FUEL: 'Fuel \(wiCode\)'/);
  assert.match(metrics, /SPEND_RETAIL: 'Retail \(wiCode\)'/);
});
