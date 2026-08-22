/**
 * Auto-register card payers (founder ask 2026-08-22): every card payer of a
 * payment request leaves a WhatsApp number and becomes a WaPay lead.
 *
 * Locks (including the 2026-08-22 adversarial-review fixes):
 * - the pay page card leg is a POST form (a number must never ride a query
 *   string into request logs) that requires the payer's number, but the
 *   checkout API never blocks a payment on a bad/missing number;
 * - the captured number is validated + normalised before it is stored, and
 *   the RECEIPT DESTINATION is bound to the PayFast session via signed
 *   custom_str1 — a later checkout click can never redirect a receipt;
 * - PayFast's return URL carries ?r=1 and the page renders a confirming
 *   state with NO pay buttons (double-charge guard); cancel stays bare;
 * - the ITN payer receipt fires exactly-once (won transition only), is
 *   best-effort (never fails the ITN), branches on the RESOLVED result —
 *   sendWhatsAppText/Template never throw, they return {ok:false} — and the
 *   template fallback is env-gated on WAPAY_TEMPLATE_PAYMENT_RECEIPT;
 * - "Receipt PRXXXXXX" is intercepted BEFORE the onboarding gate, anchored
 *   to the whole message and restricted to the code alphabet (no I/L/O) so
 *   ordinary sentences can never be hijacked; it falls through into
 *   onboarding ONLY for a brand-new number (S0_INITIAL), reveals the
 *   PayFast reference only to the number that paid, and never claims "no
 *   payment was taken" when the intent shows a card payment landed;
 * - /api/health?config=1 FAILS CLOSED until WAPAY_INTERNAL_API_KEY is set;
 * - no cash-out or betting words in any of the new copy, and the ITN push
 *   receipt is purely transactional (no upsell — POPIA purpose limitation).
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

test('pay page: card leg is a POST form that requires the payer number', () => {
  assert.match(payPageSource, /<form method="POST" action="\/api\/pay\/checkout">/);
  assert.ok(!/method="GET" action="\/api\/pay\/checkout"/.test(payPageSource), 'GET would put the number in the URL');
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
  assert.match(branch, /Tap the button above/, 'the delivery promise routes through the button — honest for every payer');
});

test('pay page: PAID state carries the receipt + onboarding deep link', () => {
  assert.match(payPageSource, /Receipt \$\{code\}/);
  assert.match(payPageSource, /Get my receipt \+ my own WaPay/);
});

test('pay page: fine print honestly discloses BOTH uses of the number', () => {
  assert.match(payPageSource, /number is used to send your\s+receipt on WhatsApp — and to offer you your own free WaPay/);
});

// ---------------------------------------------------------------------------
// Checkout (static)
// ---------------------------------------------------------------------------

test('checkout: payer number comes from the POST body only, never the query string', () => {
  assert.match(checkoutSource, /req\.method !== 'POST' && req\.method !== 'GET'/, 'POST (form) and GET (legacy links) both allowed');
  assert.match(checkoutSource, /if \(req\.method !== 'POST'\) return null;/, 'GET never reads a payer');
  assert.match(checkoutSource, /req\.body\?\.payer/);
  assert.ok(!/req\.query\.payer/.test(checkoutSource), 'a payer in the query string must be ignored');
});

test('checkout: payer number is validated + normalised, and NEVER blocks payment', () => {
  assert.match(checkoutSource, /isValidSaMsisdn\(raw\) \? normaliseMsisdn\(raw\) : null/);
  // The only failure paths are the pre-existing method/code/request guards.
  const statuses = [...checkoutSource.matchAll(/res\.status\((\d{3})\)/g)].map((m) => m[1]);
  assert.deepEqual(statuses.sort(), ['400', '404', '405', '410'].sort(), 'no new failure path for the payer field');
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

test('checkout: the receipt destination rides the SIGNED PayFast session (custom_str1)', () => {
  assert.match(checkoutSource, /customStr1: payerMsisdn \|\| ''/, 'the paying session carries its own receipt number');
});

test('checkout: return URL is ?r=1, cancel URL stays bare, redirect is 303', () => {
  assert.match(checkoutSource, /returnUrl: `\$\{base\}\/pay\/\$\{code\}\?r=1`/);
  assert.match(checkoutSource, /cancelUrl: `\$\{base\}\/pay\/\$\{code\}`/);
  assert.match(checkoutSource, /res\.redirect\(303, checkoutUrl\)/);
});

// ---------------------------------------------------------------------------
// ITN payer receipt (static)
// ---------------------------------------------------------------------------

test('ITN: receipt destination prefers signed custom_str1, strict shape, metadata fallback', () => {
  assert.match(itnSource, /params\.custom_str1/);
  const block = itnSource.slice(itnSource.indexOf('params.custom_str1') - 400, itnSource.indexOf('return res.status(200)'));
  assert.match(block, /\/\^0\\d\{9\}\$\//, 'destination is shape-checked');
  assert.match(itnSource, /requestCode && wonRequestTransition && payerMsisdn/, 'fires only when THIS delivery won the PAID transition');
});

test('ITN: the true payer is persisted back into metadata for the in-chat ref gate', () => {
  assert.match(itnSource, /metadata: \{ \.\.\.intent\.metadata, payerMsisdn \}/, 'persist merges, never replaces');
});

test('ITN: send outcomes are read from the RESOLVED result — the send functions never throw', () => {
  assert.match(itnSource, /const sent = await sendWhatsAppText\(/);
  assert.match(itnSource, /if \(!sent\?\.ok\)/, 'free-form failure detected via .ok, not catch (dead-code fallback, QA 2026-08-22)');
  assert.match(itnSource, /const tpl = await sendWhatsAppTemplate\(/);
  assert.match(itnSource, /if \(!tpl\?\.ok\)/, 'template failure is observable');
  assert.match(itnSource, /const confirmSent = await sendWhatsAppText\(/, 'requester confirm outcome is observable too');
});

test('ITN: payer receipt is best-effort and can never fail the ITN', () => {
  const receiptIdx = itnSource.indexOf('payfast_itn_payer_receipt_error');
  const okIdx = itnSource.indexOf("res.status(200).send('OK')");
  assert.ok(receiptIdx > -1 && okIdx > receiptIdx, 'receipt block sits before the 200, wrapped in try/catch');
  assert.match(itnSource, /payfast_itn_payer_receipt_template_error/);
});

test('ITN: template fallback is env-gated and parameterised, never hardcoded', () => {
  assert.match(itnSource, /WAPAY_TEMPLATE_PAYMENT_RECEIPT/);
  assert.match(itnSource, /if \(templateName\)/);
});

test('ITN: payer receipt quotes the GROSS charge and stays purely transactional', () => {
  assert.match(itnSource, /const paidRands = centsToRandString\(grossCents\)/, 'receipt states what the card was charged — metadata.amountCents is the NET credit on payrequest intents');
  assert.match(itnSource, /This message is your receipt\.`/, 'receipt copy ends transactionally');
  assert.ok(!/Want your own WaPay/.test(itnSource), 'no upsell inside a push receipt (POPIA purpose limitation) — the offer lives in the user-initiated wa.me path');
});

test('ITN: payer waId derives from the stored 0-form number', () => {
  assert.match(itnSource, /`27\$\{payerMsisdn\.slice\(1\)\}`/);
});

// ---------------------------------------------------------------------------
// Processor receipt intercept (static + extracted pattern)
// ---------------------------------------------------------------------------

test('processor: receipt intercept runs BEFORE the onboarding gate', () => {
  const matchUse = processorSource.indexOf('.match(RECEIPT_CODE_PATTERN)');
  const gate = processorSource.indexOf("if (onboardingState !== 'S5_COMPLETED')");
  assert.ok(matchUse > -1 && gate > -1);
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

test('processor: a charged payer is never told "no payment was taken"', () => {
  const fn = processorSource.indexOf('async function handlePaymentReceiptAsk(');
  const body = processorSource.slice(fn, processorSource.indexOf('\n}', fn));
  // CANCELLED/EXPIRED requests consult the intent before denying a payment
  // (a card payment can land after the requester cancels).
  assert.match(body, /intent\?\.status === 'SUCCESS' \|\| Boolean\(intent\?\.providerRef\)/);
  assert.match(body, /a card payment WAS received/);
});

test('processor: receipt handler touches no conversation state', () => {
  const fn = processorSource.indexOf('async function handlePaymentReceiptAsk(');
  const body = processorSource.slice(fn, processorSource.indexOf('\n}', fn));
  assert.ok(!body.includes('updateConversationState'), 'informational reply must never trap a flow');
});

test('RECEIPT_CODE_PATTERN: anchored + code-alphabet — ordinary sentences can never match', () => {
  const m = processorSource.match(/const RECEIPT_CODE_PATTERN = (\/.+\/i);/);
  assert.ok(m, 'pattern is defined on one line');
  // eslint-disable-next-line no-eval
  const pattern = eval(m[1]);
  // The wa.me deep link sends exactly this as the whole message.
  assert.ok(pattern.test('Receipt PRKWXQZM'));
  assert.ok(pattern.test('  receipt prkwxqzm  '), 'case-insensitive + whitespace tolerant');
  assert.ok(pattern.test('Receipt PRKWXQZM.'), 'trailing punctuation tolerated');
  assert.equal('Receipt PRKWXQZM'.match(pattern)[1], 'PRKWXQZM');
  // The QA 2026-08-22 false-positive corpus — every one must be rejected.
  for (const text of [
    'I have receipt problems',
    'receipt problems',
    'the receipt probably came through',
    'is my receipt prepared',
    'receipt provider',
    'receipt printers',
    'no receipt provided',
    'receipt 12345',
    'show my receipts',
    'Pay request PRKWXQZM',
    'Receipt PRKWXQZM please help me', // anchored: extra words break the deep-link shape
  ]) {
    assert.ok(!pattern.test(text), `must NOT match: "${text}"`);
  }
});

test('PAY_REQUEST_CODE_PATTERN: capture class is the real code alphabet (no I/L/O)', () => {
  const m = processorSource.match(/const PAY_REQUEST_CODE_PATTERN = (\/.+\/i);/);
  assert.ok(m);
  // eslint-disable-next-line no-eval
  const pattern = eval(m[1]);
  assert.ok(pattern.test('Pay request PRKWXQZM'));
  assert.ok(!pattern.test('pay request problems'), 'English words with I/L/O can never be codes');
});

// ---------------------------------------------------------------------------
// Health config block
// ---------------------------------------------------------------------------

test('health: config block FAILS CLOSED and is presence-only', () => {
  assert.match(healthSource, /x-internal-api-key/);
  assert.match(
    healthSource,
    /const authorized =\s*\n?\s*Boolean\(secret\) && typeof presented === 'string' && timingSafeEqualStr\(presented, secret\)/,
    'no secret set -> no config block; never fail-open (QA 2026-08-22)'
  );
  assert.match(healthSource, /ottVendorCode: has\('OTT_VENDOR_CODE'\)/, 'presence boolean, not the value');
  assert.match(healthSource, /payerReceiptTemplate: has\('WAPAY_TEMPLATE_PAYMENT_RECEIPT'\)/, 'presence boolean, not the value');
  assert.ok(!/\(default 11\)/.test(healthSource), 'no env values in the body');
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
