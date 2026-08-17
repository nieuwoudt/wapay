/**
 * Routing contract for gifting: raw WhatsApp text -> parseSlots -> resolveGift.
 *
 * These lock the invariants the message processor depends on:
 * - "send R50 airtime to 084..." is an AIRTIME gift, never a cash send.
 * - a bare "Send R30 to 084..." is a cash send and must be redirected to
 *   gifting with resolveGift's CASH_SEND_UNSUPPORTED copy (single source of
 *   truth for the user-facing message).
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

test('routing: bare "Send R30 to <number>" is redirected, not routed to a money path', () => {
  const slots = parseSlots('Send R30 to 0840012300');
  assert.equal(slots.productHint, 'SEND_MONEY');

  const r = resolveGift({ slots, senderMsisdn: '27830012300' });
  assert.equal(r.kind, 'CASH_SEND_UNSUPPORTED');
  assert.equal(r.ok, false);
  // The redirect must actively steer the user to gifting.
  assert.match(r.message, /airtime/i);
  assert.match(r.message, /can't send cash/i);
});

test('routing: "send money" with no slots still gets the cash-send redirect', () => {
  const slots = parseSlots('send money');
  assert.equal(slots.productHint, 'SEND_MONEY');

  const r = resolveGift({ slots, senderMsisdn: '27830012300' });
  assert.equal(r.kind, 'CASH_SEND_UNSUPPORTED');
});

test('routing: waId <-> local msisdn normalisation is symmetric for buyer/target compare', () => {
  // The processor compares normaliseMsisdn(account.msisdn) to the vend target.
  assert.equal(normaliseMsisdn('27840012300'), '0840012300');
  assert.equal(normaliseMsisdn('0840012300'), '0840012300');
  assert.notEqual(normaliseMsisdn('27830012300'), normaliseMsisdn('0840012300'));
});
