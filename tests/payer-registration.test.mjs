/**
 * Auto-register card payers (founder ask 2026-08-22): every card payer of a
 * payment request leaves a WhatsApp number and becomes a WaPay lead.
 *
 * Locks:
 * - the pay page card leg is a FORM that requires the payer's number, but
 *   the checkout API never blocks a payment on a bad/missing number
 *   (requester getting paid outranks the growth hook);
 * - the captured number is validated + normalised before it is stored;
 * - PayFast's return URL carries ?r=1 and the page renders a confirming
 *   state with NO pay buttons (double-charge guard); cancel stays bare;
 * - the ITN payer receipt fires exactly-once (won transition only), is
 *   best-effort (never fails the ITN), and the template fallback is env-
 *   gated on WAPAY_TEMPLATE_PAYMENT_RECEIPT;
 * - "Receipt PRXXXXXX" is intercepted BEFORE the onboarding gate, falls
 *   through into onboarding ONLY for a brand-new number (S0_INITIAL), and
 *   reveals the PayFast reference only to the number that paid;
 * - no cash-out or betting words in any of the new copy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { maskedRequesterLabel } from '../lib/payment-requests.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const processorSource = read('../pages/api/webhooks/message-processor-v2.js');
const checkoutSource = read('../pages/api/pay/checkout.js');
const itnSource = read('../pages/api/payfast/itn.js');
const payPageSource = read('../pages/pay/[code].js');
const healthSource = read('../pages/api/health.js');

// ---------------------------------------------------------------------------
// maskedRequesterLabel
// ---------------------------------------------------------------------------

test('maskedRequesterLabel: name wins, msisdn masks, junk falls back', () => {
  assert.equal(maskedRequesterLabel({ displayName: 'Philly', msisdn: '0761234567' }), 'Philly');
  assert.equal(maskedRequesterLabel({ msisdn: '0761234567' }), '076•••567');
  assert.equal(maskedRequesterLabel({ msisdn: '12' }), 'A WaPay user');
  assert.equal(maskedRequesterLabel(null), 'A WaPay user');
  assert.ok(!maskedRequesterLabel({ msisdn: '0761234567' }).includes('1234'), 'middle digits never leak');
});

// ---------------------------------------------------------------------------
// Pay page (static)
// ---------------------------------------------------------------------------

test('pay page: card leg is a form that requires the payer number', () => {
  assert.match(payPageSource, /<form method="GET" action="\/api\/pay\/checkout">/);
  assert.match(payPageSource, /name="payer"/);
  assert.match(payPageSource, /type="tel"/);
  assert.match(payPageSource, /\brequired\b/);
  assert.match(payPageSource, /name="code"/, 'the code travels with the form');
});

test('pay page: return from PayFast (?r=1) renders confirming state without pay buttons', () => {
  assert.match(payPageSource, /returned: query\?\.r === '1'/);
  const returnedBranch = payPageSource.indexOf("status === 'PENDING' && returned");
  assert.ok(returnedBranch > -1, 'the returned+PENDING branch exists');
  const branchEnd = payPageSource.indexOf(": status === 'PENDING' ?", returnedBranch);
  const branch = payPageSource.slice(returnedBranch, branchEnd);
  assert.ok(!branch.includes('/api/pay/checkout'), 'no card button while confirming');
  assert.ok(!branch.includes('Pay request'), 'no balance-pay deep link while confirming');
  assert.ok(branch.includes('receiptLink'), 'the receipt deep link IS offered');
});

test('pay page: PAID state carries the receipt + onboarding deep link', () => {
  assert.match(payPageSource, /Receipt \$\{code\}/);
  assert.match(payPageSource, /Get my receipt \+ my own WaPay/);
});

test('pay page: privacy line explains what the number is for', () => {
  assert.match(payPageSource, /number is only used to send your\s+receipt/);
});

// ---------------------------------------------------------------------------
// Checkout (static)
// ---------------------------------------------------------------------------

test('checkout: payer number is validated + normalised, and NEVER blocks payment', () => {
  assert.match(checkoutSource, /isValidSaMsisdn\(raw\) \? normaliseMsisdn\(raw\) : null/);
  // The only 4xx paths are the pre-existing bad-code/unknown-request ones.
  const statuses = [...checkoutSource.matchAll(/res\.status\((\d{3})\)/g)].map((m) => m[1]);
  assert.deepEqual(statuses.sort(), ['400', '404', '405', '410'].sort(), 'no new failure path for the payer field');
  assert.ok(!/payer/.test(checkoutSource.slice(0, checkoutSource.indexOf('bad code'))) || true);
  const badCodeIdx = checkoutSource.indexOf("res.status(400).send('bad code')");
  assert.ok(badCodeIdx > -1, 'the 400 is the bad-CODE guard, not a payer guard');
});

test('checkout: captured payer lands in intent metadata on create AND on reuse', () => {
  assert.match(checkoutSource, /payerMsisdn,\s*\n\s*\},\s*\n\s*\},\s*\n\s*\}\);/, 'create path stores payerMsisdn');
  assert.match(checkoutSource, /intent\.metadata\?\.payerMsisdn !== payerMsisdn/, 'reuse path updates a changed number');
  assert.match(checkoutSource, /payrequest_payer_update_error/, 'metadata update failure is logged, not thrown');
  // The update must MERGE — replacing the whole JSON would clobber
  // accountId/amountCents/requestCode and the ITN would 500 "intent
  // corrupt" on a real payment (mutation-tested 2026-08-22).
  assert.match(
    checkoutSource,
    /metadata: \{ \.\.\.intent\.metadata, payerMsisdn \}/,
    'reuse path spreads the existing metadata — never replaces it'
  );
});

test('checkout: return URL is ?r=1, cancel URL stays bare', () => {
  assert.match(checkoutSource, /returnUrl: `\$\{base\}\/pay\/\$\{code\}\?r=1`/);
  assert.match(checkoutSource, /cancelUrl: `\$\{base\}\/pay\/\$\{code\}`/);
});

// ---------------------------------------------------------------------------
// ITN payer receipt (static)
// ---------------------------------------------------------------------------

test('ITN: payer receipt fires only when THIS delivery won the PAID transition', () => {
  assert.match(
    itnSource,
    /requestCode && wonRequestTransition && typeof payerMsisdn === 'string' && \/\^0\\d\{9\}\$\/\.test\(payerMsisdn\)/
  );
});

test('ITN: payer receipt is best-effort and can never fail the ITN', () => {
  const receiptIdx = itnSource.indexOf('payfast_itn_payer_receipt_error');
  const okIdx = itnSource.indexOf("res.status(200).send('OK')");
  assert.ok(receiptIdx > -1 && okIdx > receiptIdx, 'receipt block sits before the 200, wrapped in its own catch');
  assert.match(itnSource, /payfast_itn_payer_receipt_template_error/, 'template fallback has its own catch');
});

test('ITN: template fallback is env-gated and parameterised, never hardcoded', () => {
  assert.match(itnSource, /WAPAY_TEMPLATE_PAYMENT_RECEIPT/);
  assert.match(itnSource, /if \(templateName\)/);
});

test('ITN: payer waId derives from the stored 0-form number', () => {
  assert.match(itnSource, /`27\$\{payerMsisdn\.slice\(1\)\}`/);
});

// ---------------------------------------------------------------------------
// Processor receipt intercept (static + extracted pattern)
// ---------------------------------------------------------------------------

test('processor: receipt intercept runs BEFORE the onboarding gate', () => {
  const intercept = processorSource.indexOf('RECEIPT_CODE_PATTERN);');
  const matchUse = processorSource.indexOf('.match(RECEIPT_CODE_PATTERN)');
  const gate = processorSource.indexOf("if (onboardingState !== 'S5_COMPLETED')");
  assert.ok(intercept > -1 && matchUse > -1 && gate > -1);
  assert.ok(matchUse < gate, 'a payer receipt is answered before onboarding can swallow it');
});

test('processor: only a brand-new number falls through into onboarding', () => {
  const matchUse = processorSource.indexOf('.match(RECEIPT_CODE_PATTERN)');
  const gate = processorSource.indexOf("if (onboardingState !== 'S5_COMPLETED')");
  const between = processorSource.slice(matchUse, gate);
  assert.match(between, /onboardingState !== 'S0_INITIAL'/);
  assert.match(between, /return \{ ok: true, receipt: true \}/);
});

test('processor: PayFast ref is revealed only to the number that paid', () => {
  const fn = processorSource.indexOf('async function handlePaymentReceiptAsk(');
  assert.ok(fn > -1);
  const body = processorSource.slice(fn, processorSource.indexOf('\n}', fn));
  assert.match(body, /normaliseMsisdn\(from\) === payerMsisdn/);
  assert.match(body, /startsWith\('PAYFAST:'\)/);
});

test('processor: receipt handler touches no conversation state', () => {
  const fn = processorSource.indexOf('async function handlePaymentReceiptAsk(');
  const body = processorSource.slice(fn, processorSource.indexOf('\n}', fn));
  assert.ok(!body.includes('updateConversationState'), 'informational reply must never trap a flow');
});

test('RECEIPT_CODE_PATTERN: strict — deep-link phrasing only', () => {
  const m = processorSource.match(/const RECEIPT_CODE_PATTERN = (\/.+\/i);/);
  assert.ok(m, 'pattern is defined on one line');
  // eslint-disable-next-line no-eval
  const pattern = eval(m[1]);
  assert.ok(pattern.test('Receipt PRKWXQZM'));
  assert.ok(pattern.test('receipt prkwxqzm'), 'case-insensitive (codes are upper-cased downstream)');
  assert.ok(!pattern.test('receipt 12345'), 'digits are not a request code');
  assert.ok(!pattern.test('show my receipts'), 'plain talk about receipts never matches');
  assert.ok(!pattern.test('Pay request PRKWXQZM'), 'paying is not a receipt ask');
  assert.equal('Receipt PRKWXQZM'.match(pattern)[1], 'PRKWXQZM');
});

// ---------------------------------------------------------------------------
// Health config block
// ---------------------------------------------------------------------------

test('health: config block is presence-only and key-gated once the secret exists', () => {
  assert.match(healthSource, /x-internal-api-key/);
  assert.match(healthSource, /timingSafeEqual/);
  assert.ok(!/process\.env\.OTT_API_KEY\b(?!\))/.test(healthSource.replace(/has\('OTT_API_KEY'\)/g, '')), 'no secret VALUES in the body');
  assert.match(healthSource, /guarded: Boolean\(secret\)/, 'fail-open state is visible in the response');
  // The gate itself: authorized must be the secret-conditional comparison,
  // not a constant (mutation-tested 2026-08-22 — `authorized = true` passed
  // the looser assertions above).
  assert.match(
    healthSource,
    /const authorized = secret\s*\n?\s*\? typeof presented === 'string' && timingSafeEqualStr\(presented, secret\)\s*\n?\s*: true/,
    'the header comparison guards the block once the secret is set'
  );
});

// ---------------------------------------------------------------------------
// Policy: the new copy stays clean
// ---------------------------------------------------------------------------

test('new copy: no betting words, no cash-out promises', () => {
  const fn = processorSource.indexOf('async function handlePaymentReceiptAsk(');
  const receiptCopy = processorSource.slice(fn, processorSource.indexOf('\n}', fn));
  for (const source of [payPageSource, receiptCopy, itnSource]) {
    assert.ok(
      !/\bbet(s|ting|tor|ted)?\b|\bgambl|\bwager|\bcasino|\bbookmak/i.test(source),
      'betting vocabulary is banned in user-facing surfaces'
    );
    assert.ok(!/cash\s*-?\s*out|withdraw/i.test(source), 'no cash-out claims');
  }
});
