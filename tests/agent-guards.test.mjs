/**
 * Agent guards (v1.4 agent, 2026-09-16): the pre-model guard list reproduces
 * the processor's patterns exactly, and the output gate blocks what the bot
 * may never send (betting words, the pay-out partner before cash-out is live,
 * off-domain links, over-long replies) and rewrites dashes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  agentGuard,
  outputGate,
  rewriteDashes,
  PAY_REQUEST_CODE_PATTERN,
  VOUCHER_PIN_RESEND_PATTERN,
  BETTING_LEXICON,
  MAX_REPLY_CHARS,
} from '../lib/agent/guards.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

// --- agentGuard ------------------------------------------------------------

test('a bare 16-digit voucher PIN is caught, with separators stripped', () => {
  assert.deepEqual(agentGuard('1234567890123456'), { kind: 'VOUCHER_PIN', pin: '1234567890123456' });
  assert.deepEqual(agentGuard('1234 5678 9012 3456'), { kind: 'VOUCHER_PIN', pin: '1234567890123456' });
  assert.deepEqual(agentGuard('1234-5678-9012-3456'), { kind: 'VOUCHER_PIN', pin: '1234567890123456' });
  assert.deepEqual(agentGuard('  pin: 1234.5678.9012.3456 '), { kind: 'VOUCHER_PIN', pin: '1234567890123456' });
});

test('15 or 17 digits, or a phone number, is not a voucher PIN', () => {
  assert.equal(agentGuard('123456789012345'), null);
  assert.equal(agentGuard('12345678901234567'), null);
  assert.equal(agentGuard('0821234567'), null);
  assert.equal(agentGuard('send R50 to 0821234567'), null);
  assert.equal(agentGuard('1234'), null);
});

test('"Pay request PRXXXXXX" is caught and the code upper-cased', () => {
  assert.deepEqual(agentGuard('Pay request PRABCDEF'), { kind: 'PAY_REQUEST_CODE', code: 'PRABCDEF' });
  assert.deepEqual(agentGuard('pay   request prhjkmnp please'), { kind: 'PAY_REQUEST_CODE', code: 'PRHJKMNP' });
  // The processor's alphabet excludes I, L and O (and digits).
  assert.equal(agentGuard('pay request PRABCDEI'), null);
  assert.equal(agentGuard('pay request PRABCD12'), null);
  assert.equal(agentGuard('pay request PRABCDE'), null);
  assert.equal(agentGuard('PRABCDEF'), null);
});

test('"voucher pin <tail>" is the PIN-gated resend ask, not a voucher PIN', () => {
  assert.deepEqual(agentGuard('voucher pin 1234'), { kind: 'VOUCHER_PIN_RESEND', tail: '1234' });
  assert.deepEqual(agentGuard('  Voucher  PIN 98765432 '), { kind: 'VOUCHER_PIN_RESEND', tail: '98765432' });
  // A literal resend prefix wins over the 16-digit rule, as in the processor.
  assert.deepEqual(agentGuard('voucher pin 1234567890123456'), { kind: 'VOUCHER_PIN_RESEND', tail: '1234567890123456' });
  // Not anchored: extra words fall through to the model.
  assert.equal(agentGuard('voucher pin 1234 please'), null);
  assert.equal(agentGuard('voucher pin 123'), null);
  assert.equal(agentGuard('voucher pin'), null);
});

test('plain chat, empty and non-string input are null', () => {
  for (const t of ['hi', 'what is my balance', 'buy R10 airtime', '', '   ']) assert.equal(agentGuard(t), null, JSON.stringify(t));
  assert.equal(agentGuard(undefined), null);
  assert.equal(agentGuard(null), null);
  assert.equal(agentGuard(42), null);
});

test('the guard patterns are the processor patterns, byte for byte', () => {
  const src = read('../pages/api/webhooks/message-processor-v2.js');
  assert.ok(src.includes(`const PAY_REQUEST_CODE_PATTERN = ${PAY_REQUEST_CODE_PATTERN.toString()};`), 'PR code pattern drifted');
  assert.ok(src.includes(`text.trim().match(${VOUCHER_PIN_RESEND_PATTERN.toString()})`), 'resend pattern drifted');
  assert.ok(src.includes("const digitsOnly = text.replace(/[^\\d]/g, '');"), 'digit strip drifted');
  assert.ok(src.includes("if (/^\\d{16}$/.test(digitsOnly)) {\n    return { intent: 'VOUCHER_PIN'"), 'voucher PIN rule drifted');
});

test('the guard module imports no model client and no DB', () => {
  const src = read('../lib/agent/guards.js');
  assert.ok(!/from ['"]openai['"]|@anthropic-ai|prisma|node-fetch/i.test(src));
  assert.ok(!/^import /m.test(src), 'guards.js is dependency-free');
});

// --- outputGate: BETTING ---------------------------------------------------

test('betting and gambling words are blocked, word-bounded, any case', () => {
  for (const t of [
    'You can bet on the game',
    'Place a BET now',
    'Betting sites accept OTT vouchers',
    'Top up your Hollywoodbets account',
    'hollywoodbets',
    'Betway takes OTT',
    'Supabets and Sportingbet both do',
    'Try LottoStar',
    'the odds are good',
    'a wager of R10',
    'the casino accepts it',
    'do not gamble',
    'gambling is not allowed',
    'play the lotto',
  ]) {
    const r = outputGate(t, { withdrawLive: true });
    assert.equal(r.ok, false, t);
    assert.equal(r.rule, 'BETTING', t);
  }
});

test('words that merely contain the lexicon are fine', () => {
  for (const t of ['alphabet soup', 'the Tibetan plateau', 'a better deal', 'Elizabeth sent R50', 'lottery is not a word we use? it is fine here', 'the diabetes clinic']) {
    const r = outputGate(t, { withdrawLive: true });
    assert.equal(r.ok, true, t);
    assert.equal(r.rule, null, t);
  }
});

test('the lexicon carries every name from the contract', () => {
  for (const w of ['bet', 'betting', 'wager', 'casino', 'odds', 'gamble', 'hollywoodbets', 'betway', 'supabets', 'sportingbet', 'lottostar', 'lotto'])
    assert.ok(BETTING_LEXICON.includes(w), w);
});

// --- outputGate: PARTNER ---------------------------------------------------

test('"OTT voucher" is a product name and is allowed whether or not cash-out is live', () => {
  for (const live of [false, true]) {
    for (const t of [
      'Buy an OTT voucher at any till and load it here.',
      'OTT vouchers are accepted at Takealot.',
      'Load your OTT voucher PIN to deposit.',
      'You cannot cash out an OTT voucher, you spend it instead.',
      'An OTT-voucher works at Spar tills too.',
    ]) {
      const r = outputGate(t, { withdrawLive: live });
      assert.equal(r.ok, true, `${live}: ${t}`);
    }
  }
});

test('the partner name near pay-out words is blocked while cash-out is not live', () => {
  for (const t of [
    'Your pay-out runs through OTT and lands via PayShap.',
    'We use OTT for payouts.',
    'OTT will process the PayShap transfer tomorrow.',
    'Cash-out is handled by OTT.',
    'Withdrawals go through OTT.',
    'OTT sends the cash out to your bank.',
    'ott payshap',
  ]) {
    const r = outputGate(t, { withdrawLive: false });
    assert.equal(r.ok, false, t);
    assert.equal(r.rule, 'PARTNER', t);
  }
});

test('the same partner sentences pass once cash-out is live for this customer', () => {
  for (const t of ['Your pay-out runs through OTT and lands via PayShap.', 'We use OTT for payouts.']) {
    const r = outputGate(t, { withdrawLive: true });
    assert.equal(r.ok, true, t);
  }
});

test('the partner name with no pay-out word nearby passes, and the window is 40 chars', () => {
  assert.equal(outputGate('OTT is a voucher company.', { withdrawLive: false }).ok, true);
  const far = 'OTT ' + 'x'.repeat(45) + ' payout';
  assert.equal(outputGate(far, { withdrawLive: false }).ok, true);
  const near = 'OTT ' + 'x'.repeat(30) + ' payout';
  assert.equal(outputGate(near, { withdrawLive: false }).rule, 'PARTNER');
  // The partner word must stand alone: "Scott", "OTTER" and "bottom" are not it.
  assert.equal(outputGate('Scott asked about a withdrawal.', { withdrawLive: false }).ok, true);
  assert.equal(outputGate('An otter can cash out?', { withdrawLive: false }).ok, true);
});

// --- outputGate: URL -------------------------------------------------------

test('wapay.co.za and pleasepayme.co.za links, and their subdomains, are allowed', () => {
  for (const t of [
    'Pay here: https://pleasepayme.co.za/p/PRABCDEF',
    'See https://wapay.co.za/fees for the schedule.',
    'https://business.wapay.co.za/login',
    'http://www.pleasepayme.co.za/x',
    'Visit https://WAPAY.CO.ZA/help.',
    'Two links https://wapay.co.za and https://pleasepayme.co.za/p/PRABCDEF.',
  ]) {
    const r = outputGate(t, { withdrawLive: true });
    assert.equal(r.ok, true, t);
    assert.equal(r.rule, null, t);
  }
});

test('any other http(s) URL is blocked, including look-alike hosts', () => {
  for (const t of [
    'Go to https://example.com/pay',
    'http://bit.ly/abc',
    'https://wapay.co.za.evil.com/login',
    'https://notwapay.co.za/x',
    'https://pleasepayme.co.za@evil.com/',
    'See https://hollywood.example.org (no lexicon word, still off-domain)',
  ]) {
    const r = outputGate(t, { withdrawLive: true });
    assert.equal(r.ok, false, t);
    assert.equal(r.rule, 'URL', t);
  }
});

test('plain domain mentions without a scheme are not URLs for this rule', () => {
  assert.equal(outputGate('Ask at spar.co.za if unsure.', { withdrawLive: true }).ok, true);
});

// --- outputGate: DASH_REWRITE ---------------------------------------------

test('em and en dashes are rewritten to a comma and ok stays true', () => {
  const r = outputGate('Your balance is R50 — enough for R29 airtime.', { withdrawLive: true });
  assert.equal(r.ok, true);
  assert.equal(r.rule, 'DASH_REWRITE');
  assert.equal(r.text, 'Your balance is R50, enough for R29 airtime.');
  assert.equal(rewriteDashes('R10–R20'), 'R10, R20');
  assert.equal(rewriteDashes('Fee — R2.50\nSent – R100'), 'Fee, R2.50\nSent, R100');
  assert.equal(rewriteDashes('— leading and trailing —'), 'leading and trailing');
  assert.ok(!/[–—]/.test(rewriteDashes('a —— b')));
});

test('a hyphen is not a dash and the text comes back untouched', () => {
  const t = 'Cash-out fee is R2.50, pay-out lands in 2-4 hours.';
  const r = outputGate(t, { withdrawLive: true });
  assert.equal(r.rule, null);
  assert.equal(r.text, t);
});

// --- outputGate: LENGTH ----------------------------------------------------

test('replies over 1,500 chars are blocked; 1,500 exactly passes', () => {
  assert.equal(MAX_REPLY_CHARS, 1500);
  const atLimit = 'a'.repeat(1500);
  assert.equal(outputGate(atLimit, { withdrawLive: true }).ok, true);
  const over = outputGate('a'.repeat(1501), { withdrawLive: true });
  assert.equal(over.ok, false);
  assert.equal(over.rule, 'LENGTH');
});

// --- order and shape -------------------------------------------------------

test('rules fire in contract order: betting before partner before URL before length', () => {
  const all = 'bet on it with OTT payout at https://evil.com ' + 'x'.repeat(1600);
  assert.equal(outputGate(all, { withdrawLive: false }).rule, 'BETTING');
  const noBet = 'OTT payout at https://evil.com ' + 'x'.repeat(1600);
  assert.equal(outputGate(noBet, { withdrawLive: false }).rule, 'PARTNER');
  assert.equal(outputGate(noBet, { withdrawLive: true }).rule, 'URL');
  const longOnly = 'https://wapay.co.za/x ' + 'x'.repeat(1600);
  assert.equal(outputGate(longOnly, { withdrawLive: true }).rule, 'LENGTH');
});

test('a clean reply passes with rule null and the same text; odd input never throws', () => {
  const t = 'Hi Thabo. Your balance is R120.00.\nWant to buy airtime?';
  assert.deepEqual(outputGate(t), { ok: true, rule: null, text: t });
  assert.deepEqual(outputGate(''), { ok: true, rule: null, text: '' });
  assert.deepEqual(outputGate(undefined), { ok: true, rule: null, text: '' });
  assert.deepEqual(outputGate(null, {}), { ok: true, rule: null, text: '' });
});
