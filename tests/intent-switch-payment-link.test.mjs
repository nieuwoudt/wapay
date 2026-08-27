/**
 * Mid-flow intent switch: "Please create a payment link for R20" while the
 * electricity flow waits for a meter number (founder live sighting
 * 2026-08-27, BUGLOG #29). Two layers, both guarded here:
 *
 * 1. matchRequestMoneyAsk recognizes payment-LINK phrasings, so the
 *    universal escape sees the new intent and re-routes it;
 * 2. every slot-collector state carries the conversational backstop, so a
 *    sentence the matchers DON'T recognize still reaches the router
 *    instead of a validation insult;
 * plus the escape now acknowledges the parked flow out loud.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const processorSource = read('../pages/api/webhooks/message-processor-v2.js');

function extractFns(names) {
  const preamble = `
    const DEPOSIT_CARD_PATTERN = /\\b(?:deposit|depsit|deposite|diposit)\\b(?:\\s+(?:money|funds|cash))?\\s*[:,-]?\\s*r?\\s*(\\d+(?:[.,]\\d{1,2})?)(?:\\s*(?:rand|rande|zar))?\\b/i;
    const PAY_REQUEST_CODE_PATTERN = /\\bpay\\s+request\\s+(PR[A-HJKMNP-Z]{6})\\b/i;
    const RECEIPT_CODE_PATTERN = /^\\s*receipt\\s+(PR[A-HJKMNP-Z]{6})\\s*[.!]?\\s*$/i;
    const matchOttVoucherSelfRequest = (t) => /\\bott\\s*vouchers?\\b/i.test(t) && !/\\b(redeem\\w*|have|my)\\b/i.test(t);
  `;
  const bodies = names.map((name) => {
    const start = processorSource.indexOf(`function ${name}(`);
    assert.ok(start > -1, `processor must define ${name}`);
    return processorSource.slice(start, processorSource.indexOf('\n}', start) + 2);
  });
  // eslint-disable-next-line no-new-func
  return new Function(`${preamble}; ${bodies.join(';\n')}; return [${names.join(', ')}];`)();
}

// The REAL matcher feeds the REAL switch detector — no stubs, so a matcher
// regression fails here even if the founder-feedback stub still passes.
const [matchRequestMoneyAsk, detectStrongIntentSwitch] = extractFns([
  'matchRequestMoneyAsk',
  'detectStrongIntentSwitch',
]);

// ---------------------------------------------------------------------------
// Layer 1: the matcher knows payment-LINK phrasings
// ---------------------------------------------------------------------------

test('payment-link asks create a request', () => {
  for (const text of [
    'Please create a payment link for R20', // founder's exact message
    'create a pay link',
    'make me a payment link',
    'send me a payment link for R20',
    'I need a pay link',
    'payment link for R50 please',
    'pay link R100',
  ]) {
    assert.ok(matchRequestMoneyAsk(text), `should match: "${text}"`);
  }
});

test('payment-link mentions that are NOT create asks stay with the router', () => {
  for (const text of [
    'the payment link doesn\'t work',
    'how long does the payment link last',
    'I can\'t open the payment link',
    'Pay request PRKWXQZM',
    'pay my sister 0841234567',
  ]) {
    assert.ok(!matchRequestMoneyAsk(text), `must NOT match: "${text}"`);
  }
});

// ---------------------------------------------------------------------------
// Layer 2: the universal escape fires from the meter state
// ---------------------------------------------------------------------------

test('escape: the founder\'s message breaks out of ELECTRICITY_METER', () => {
  assert.equal(
    detectStrongIntentSwitch('Please create a payment link for R20', 'ELECTRICITY_METER'),
    'REQUEST_MONEY'
  );
});

test('escape: in-flow answers still never escape', () => {
  assert.equal(detectStrongIntentSwitch('300004312928', 'ELECTRICITY_METER'), null, 'a meter number is the answer');
  assert.equal(detectStrongIntentSwitch('50', 'ELECTRICITY_AMOUNT'), null, 'an amount is the answer');
  assert.equal(
    detectStrongIntentSwitch('create a payment link for R20', 'REQUEST_MONEY_AMOUNT'),
    null,
    'same family stays in the flow'
  );
});

// ---------------------------------------------------------------------------
// Layer 3: conversational backstop in every slot-collector state
// ---------------------------------------------------------------------------

test('every slot-collector state escapes conversational sentences to the router', () => {
  const states = [
    'ELECTRICITY_AMOUNT',
    'ELECTRICITY_METER',
    'AIRTIME_AMOUNT',
    'AIRTIME_MSISDN',
    'DATA_MSISDN',
    'DATA_NETWORK',
    'DATA_PERIOD',
    'VOUCHER_GIFT_AMOUNT',
  ];
  for (const state of states) {
    const start = processorSource.indexOf(`case '${state}'`);
    assert.ok(start > -1, `state ${state} must exist`);
    const end = processorSource.indexOf("case '", start + 10);
    const body = processorSource.slice(start, end);
    assert.match(body, /isConversationalEscape\(text\)/, `${state} must carry the sentence backstop`);
    assert.match(body, /handlePostOnboarding\(\{ account, from, text \}\)/, `${state} must hand the sentence to the router`);
  }
});

// ---------------------------------------------------------------------------
// The switch is acknowledged out loud, before fresh routing
// ---------------------------------------------------------------------------

test('escape acknowledges the parked flow, with no em dashes', () => {
  const idx = processorSource.indexOf('state_escape_intent_switch');
  const after = processorSource.slice(idx, idx + 1600);
  assert.match(after, /parkedFlow/, 'the ack names the parked flow');
  assert.match(after, /No problem, switching over\. We can come back to \$\{parkedFlow\} any time\./);
  assert.ok(!/—/.test(after), 'client-facing ack copy carries no em dash');
  // Ack is best-effort and never blocks the re-route: state is cleared FIRST.
  assert.ok(
    after.indexOf('updateConversationState(from, null)') < after.indexOf('parkedFlow'),
    'state cleared before the ack'
  );
});
