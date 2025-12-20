import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BLU_QA_TEST_NUMBERS,
  isValidSaMsisdn,
  normaliseMsisdn,
} from '../lib/msisdn.js';

test('Blu QA allow-list passes validation', () => {
  for (const qaMsisdn of BLU_QA_TEST_NUMBERS) {
    assert.equal(isValidSaMsisdn(qaMsisdn), true, `${qaMsisdn} should be valid`);
  }
});

test('Standard SA numbers validate and normalise correctly', () => {
  assert.equal(isValidSaMsisdn('0781234567'), true);
  assert.equal(normaliseMsisdn('+27 78 123 4567'), '0781234567');
  assert.equal(isValidSaMsisdn('+27781234567'), true);
});

test('Invalid numbers fail validation', () => {
  assert.equal(isValidSaMsisdn('0512345678'), false, 'prefix outside 06/07/08 should fail');
  assert.equal(isValidSaMsisdn('12345'), false, 'too short should fail');
  assert.equal(isValidSaMsisdn('0A81234567'), false, 'non-digit content should fail');
});

