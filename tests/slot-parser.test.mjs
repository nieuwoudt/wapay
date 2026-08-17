import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSlots } from '../lib/slot-parser.js';

test('parseSlots: extracts amountCents from common formats', () => {
  assert.equal(parseSlots('Buy R10 airtime').amountCents, 1000);
  assert.equal(parseSlots('Buy R 10 airtime').amountCents, 1000);
  assert.equal(parseSlots('Buy 10 rand airtime').amountCents, 1000);
  assert.equal(parseSlots('R10.50').amountCents, 1050);
});

test('parseSlots: extracts msisdn from multiple formats (including separators)', () => {
  const cases = [
    ['0840012300', '0840012300'],
    ['084 001 2300', '0840012300'],
    ['0 8 4 0 0 1 2 3 0 0', '0840012300'],
    ['+27 84 001 2300', '0840012300'],
    ['Buy R10 airtime for 0840012300', '0840012300'],
    ['Ek wil R10 airtime koop vir 0840012300', '0840012300'],
    // WhatsApp-ish formatting marks between digits
    ['0\u200e84\u200f 00\u200e12\u200f300', '0840012300'],
  ];

  for (const [input, expected] of cases) {
    assert.equal(parseSlots(input).msisdn, expected, `failed for: ${input}`);
  }
});

test('parseSlots: extracts retailer names (variants)', () => {
  assert.equal(parseSlots('Pay R50 at Pick n Pay').retailer, 'PICKNPAY');
  assert.equal(parseSlots('Pay R50 at Picknpay').retailer, 'PICKNPAY');
  assert.equal(parseSlots('Pay R50 at PnP').retailer, 'PICKNPAY');
  assert.equal(parseSlots('Pay R50 at Shoprite').retailer, 'SHOPRITE');
  assert.equal(parseSlots('Pay R50 at Checkers').retailer, 'CHECKERS');
  assert.equal(parseSlots('Pay R50 at Usave').retailer, 'USAVE');
  assert.equal(parseSlots('Pay R50 at Boxer').retailer, 'BOXER');
  assert.equal(parseSlots('Pay R50 at Engen').retailer, 'ENGEN');
});

test('parseSlots: extracts send money intent-ish slots', () => {
  const s = parseSlots('Send R30 to 08798908089');
  assert.equal(s.amountCents, 3000);
  // MSISDN must be 10 digits; parser should pick the valid 10-digit substring.
  assert.equal(s.msisdn, '0879890808');
  assert.equal(s.productHint, 'SEND_MONEY');
});

test('parseSlots: explicit product word beats generic send-to (gifting phrasing)', () => {
  // "send ... to ..." with a product word is a gift of that product, never SEND_MONEY.
  const airtime = parseSlots('send R50 airtime to 0840012300');
  assert.equal(airtime.productHint, 'AIRTIME');
  assert.equal(airtime.amountCents, 5000);
  assert.equal(airtime.msisdn, '0840012300');

  const data = parseSlots('Send R30 data to 0840012300');
  assert.equal(data.productHint, 'DATA');
  assert.equal(data.amountCents, 3000);
  assert.equal(data.msisdn, '0840012300');
});

test('parseSlots: bare send-to (no product word) still yields SEND_MONEY', () => {
  const s = parseSlots('Send R30 to 0840012300');
  assert.equal(s.productHint, 'SEND_MONEY');
  assert.equal(s.amountCents, 3000);
  assert.equal(s.msisdn, '0840012300');
});


