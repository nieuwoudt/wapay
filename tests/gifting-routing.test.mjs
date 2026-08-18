/**
 * Routing contract for gifting: raw WhatsApp text -> parseSlots -> resolveGift.
 *
 * These lock the invariants the message processor depends on:
 * - "send R50 airtime to 084..." is an AIRTIME gift, never a cash send.
 * - a bare "Send R30 to 084..." is a VOUCHER gift (a GOODS voucher sale),
 *   never routed to a money-transfer path; resolveGift's copy is the single
 *   source of truth for the user-facing asks.
 * - buyer-vs-target comparison works across waId (27...) and local (0...)
 *   formats, since Account.msisdn is stored as the 27-prefixed waId.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSlots } from '../lib/slot-parser.js';
import { resolveGift } from '../lib/gifting.js';
import { normaliseMsisdn } from '../lib/msisdn.js';

test('routing: "send R50 airtime to <number>" resolves to a GIFT', () => {
  const slots = parseSlots('send R50 airtime to 0840012300');
  assert.equal(slots.productHint, 'AIRTIME');

  const r = resolveGift({ slots, senderMsisdn: '27830012300' });
  assert.equal(r.kind, 'GIFT');
  assert.equal(r.ok, true);
  assert.equal(r.recipientMsisdn, '0840012300');
  assert.equal(r.amountCents, 5000);
  assert.equal(r.product, 'AIRTIME');
});

test('routing: gifting your own number resolves to SELF (no recipient notification)', () => {
  const slots = parseSlots('send R50 airtime to 0840012300');
  // Sender in waId format, target in local format: must still compare equal.
  const r = resolveGift({ slots, senderMsisdn: '27840012300' });
  assert.equal(r.kind, 'SELF');
  assert.equal(r.ok, true);
});

test('routing: bare "Send R30 to <number>" becomes a VOUCHER_GIFT, never a money path', () => {
  const slots = parseSlots('Send R30 to 0840012300');
  assert.equal(slots.productHint, 'SEND_MONEY');

  const r = resolveGift({ slots, senderMsisdn: '27830012300' });
  assert.equal(r.kind, 'VOUCHER_GIFT');
  assert.equal(r.ok, true);
  assert.equal(r.recipientMsisdn, '0840012300');
  assert.equal(r.amountCents, 3000);
  assert.equal(r.product, 'VOUCHER');
});

test('routing: "send money" with no slots asks for the amount with voucher copy', () => {
  const slots = parseSlots('send money');
  assert.equal(slots.productHint, 'SEND_MONEY');

  const r = resolveGift({ slots, senderMsisdn: '27830012300' });
  assert.equal(r.kind, 'NEEDS_AMOUNT');
  assert.equal(r.ok, false);
  assert.match(r.message, /WaPay voucher/);
});

test('routing: waId <-> local msisdn normalisation is symmetric for buyer/target compare', () => {
  // The processor compares normaliseMsisdn(account.msisdn) to the vend target.
  assert.equal(normaliseMsisdn('27840012300'), '0840012300');
  assert.equal(normaliseMsisdn('0840012300'), '0840012300');
  assert.notEqual(normaliseMsisdn('27830012300'), normaliseMsisdn('0840012300'));
});
