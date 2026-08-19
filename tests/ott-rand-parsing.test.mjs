/**
 * OTT rand-amount parsing — exact string math at the money boundary.
 *
 * Regression: the day the R100k test float landed (2026-08-19), GetBalance
 * returned "100,000.00" — comma thousands separators — and randToCents
 * rejected it, failing the balance check. Only WELL-FORMED grouping is
 * accepted; any other comma pattern still throws.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { randToCents, centsToRand } from '@wapay/providers-ott';

test('plain decimal amounts parse exactly', () => {
  assert.equal(randToCents('996.70'), 99670);
  assert.equal(randToCents('1000'), 100000);
  assert.equal(randToCents('-3.30'), -330);
  assert.equal(randToCents(10.0), 1000);
  assert.equal(randToCents('0.05'), 5);
});

test('comma thousands separators parse (the R100k float regression)', () => {
  assert.equal(randToCents('100,000.00'), 10000000);
  assert.equal(randToCents('1,234,567.89'), 123456789);
  assert.equal(randToCents('-1,000.00'), -100000);
  assert.equal(randToCents('5,000'), 500000);
});

test('malformed comma patterns still throw', () => {
  for (const bad of ['1,00.00', '12,34', ',100', '1,,000', '1000,000']) {
    assert.throws(() => randToCents(bad), /Invalid rand amount/, `should reject "${bad}"`);
  }
});

test('sub-cent precision that is not all zeros still throws', () => {
  assert.throws(() => randToCents('10.001'), /Sub-cent/);
  assert.equal(randToCents('10.0100'), 1001, 'trailing zeros beyond cents are fine');
});

test('round-trip with centsToRand', () => {
  assert.equal(centsToRand(randToCents('100,000.00')), '100000.00');
});
