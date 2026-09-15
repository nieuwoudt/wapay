/** OTT acceptance is data (researched 2026-09-15): yes/no by name, never a betting word, never a website deflection alone. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { OTT_ACCEPTED, OTT_NOT_ACCEPTED, OTT_PIN_DIGITS, lookupOttMerchant, ottAcceptedFacts, ottRedemptionFacts, ottAcceptanceAnswer } from '../lib/ott-acceptance.js';

const BETTING = /\b(bet|bets|betting|gambl\w*|casino|lotto\w*|hollywood\w*|betway|supabets|gbets|yesplay|sportingbet)\b/i;

test('named lookups: shops that sell but do not accept, partners that accept, unknowns', () => {
  assert.equal(lookupOttMerchant('Is it accepted at Checkers?').accepted, false);
  assert.equal(lookupOttMerchant('can I pay with it on Sixty60').name, 'Checkers');
  assert.equal(lookupOttMerchant('does pick and pay take OTT').name, 'Pick n Pay');
  assert.equal(lookupOttMerchant('can I use it on Talk360').accepted, true);
  assert.equal(lookupOttMerchant('pay my dstv with it').name, 'DStv');
  assert.equal(lookupOttMerchant('what about my spaza'), null);
  assert.equal(OTT_PIN_DIGITS, 12);
});

test('answers say yes or no by name, then where it works; the facts name partners and non-acceptors, never betting', () => {
  const no = ottAcceptanceAnswer('Is it accepted at Checkers?');
  assert.match(no, /No, Checkers does not take OTT vouchers/); assert.match(no, /sells OTT vouchers at the till/); assert.match(no, /Talk360/);
  const yes = ottAcceptanceAnswer('can I use it on fibertime');
  assert.match(yes, /Yes, fibertime takes OTT vouchers/); assert.match(yes, /12-digit PIN/);
  const dstv = ottAcceptanceAnswer('can I pay DStv with it?');
  assert.match(dstv, /No, DStv does not take/); assert.match(dstv, /through Pay@ or Xash/);
  const general = ottAcceptanceAnswer('where do OTT vouchers work');
  assert.match(general, /ONLINE and in apps, never at a shop till/); assert.match(general, /ottvoucher\.com/); assert.match(general, /36 months/);
  for (const s of [no, yes, dstv, general, ottAcceptedFacts(), ottRedemptionFacts(), ...OTT_ACCEPTED.map((m) => m.name), ...OTT_NOT_ACCEPTED.map((m) => m.name)]) {
    assert.ok(!BETTING.test(s), `betting never named: ${String(s).slice(0, 40)}`);
    assert.ok(!/—|–/.test(s), 'no em dashes');
  }
});
