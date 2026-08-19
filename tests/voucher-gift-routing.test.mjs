/**
 * Voucher gift routing — "Send R50 to 084..." becomes a WaPay VOUCHER gift.
 *
 * Pure tests (no DB, no network) locking:
 * - raw WhatsApp text -> parseSlots -> resolveGift = VOUCHER_GIFT with the
 *   right amount + recipient;
 * - bare "send money" still asks (voucher-flavoured copy);
 * - airtime gift phrasing is untouched (regression);
 * - the claim message hands over the FULL voucher PIN (by design — the PIN is
 *   the gift) plus usage copy and the "reply BALANCE" hook;
 * - static wiring: message-processor-v2 carries the VOUCHER_GIFT_CONFIRM /
 *   VOUCHER_GIFT_PIN states and calls claimPendingGifts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseSlots } from '../lib/slot-parser.js';
import { resolveGift, buildVoucherClaimMessage } from '../lib/gifting.js';

const SENDER = '27830012300';

test('voucher gift: "send R50 to 0840012300" resolves to VOUCHER_GIFT', () => {
  const slots = parseSlots('send R50 to 0840012300');
  assert.equal(slots.productHint, 'SEND_MONEY');
  assert.equal(slots.amountCents, 5000);
  assert.equal(slots.msisdn, '0840012300');

  const r = resolveGift({ slots, senderMsisdn: SENDER });
  assert.equal(r.kind, 'VOUCHER_GIFT');
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 5000);
  assert.equal(r.recipientMsisdn, '0840012300');
  assert.equal(r.product, 'VOUCHER');
});

test('voucher gift: bare "send money" asks for a missing slot (voucher copy)', () => {
  const slots = parseSlots('send money');
  assert.equal(slots.productHint, 'SEND_MONEY');

  const r = resolveGift({ slots, senderMsisdn: SENDER });
  assert.equal(r.ok, false);
  assert.ok(
    ['NEEDS_AMOUNT', 'NEEDS_RECIPIENT'].includes(r.kind),
    `expected an ask kind, got ${r.kind}`
  );
  assert.match(r.message, /WaPay voucher/);
});

test('voucher gift: "send R20 to" a recipient-less message asks for the number', () => {
  const slots = parseSlots('send R20 to my cousin');
  assert.equal(slots.productHint, 'SEND_MONEY');
  assert.equal(slots.amountCents, 2000);
  assert.equal(slots.msisdn, null);

  const r = resolveGift({ slots, senderMsisdn: SENDER });
  assert.equal(r.kind, 'NEEDS_RECIPIENT');
  assert.equal(r.amountCents, 2000);
});

test('regression: airtime gift phrasing still yields a plain GIFT, not a voucher', () => {
  const slots = parseSlots('send R50 airtime to 0840012300');
  assert.equal(slots.productHint, 'AIRTIME');

  const r = resolveGift({ slots, senderMsisdn: SENDER });
  assert.equal(r.kind, 'GIFT');
  assert.equal(r.ok, true);
  assert.equal(r.product, 'AIRTIME');
  assert.equal(r.recipientMsisdn, '0840012300');
});

test('claim message: contains the FULL PIN (by design), usage copy and the BALANCE hook', () => {
  const pin = '1234567890123456';
  const msg = buildVoucherClaimMessage({
    senderName: 'Sipho',
    amountCents: 5000,
    pin,
    serial: 'SN-001122',
  });

  assert.match(msg, /Sipho/);
  assert.match(msg, /R50 WaPay voucher/);
  // The PIN is the gift: it MUST be present, unmasked, in this one message.
  assert.ok(msg.includes(pin), 'claim message must carry the full voucher PIN');
  assert.match(msg, /SN-001122/);
  // Usage copy: spend online where OTT is accepted. NO cash-out claim —
  // OTT confirmed in writing (2026-08-19) the voucher cannot be exchanged
  // for cash; promising a bank route would be a false product claim.
  assert.match(msg, /online/i);
  assert.match(msg, /OTT/);
  assert.ok(!/cash it out|cash out|take it to your bank/i.test(msg), 'no cash-out promise');
  // Conversion hook.
  assert.match(msg, /reply BALANCE/i);
});

test('claim message: degrades gracefully without sender name or serial', () => {
  const msg = buildVoucherClaimMessage({ amountCents: 1000, pin: '9999888877776666' });
  assert.match(msg, /Someone sent you a R10 WaPay voucher/);
  assert.ok(msg.includes('9999888877776666'));
  assert.ok(!/Serial:/.test(msg), 'no Serial line when serial is unknown');
});

// ---------------------------------------------------------------------------
// Static wiring checks on the message processor (no import — it pulls Prisma).
// ---------------------------------------------------------------------------
const processorSource = readFileSync(
  fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)),
  'utf8'
);

test('static: processor has the VOUCHER_GIFT_CONFIRM and VOUCHER_GIFT_PIN states', () => {
  assert.match(processorSource, /case 'VOUCHER_GIFT_CONFIRM':/);
  assert.match(processorSource, /case 'VOUCHER_GIFT_PIN':/);
  // The PIN state must execute against the voucher execute route.
  assert.match(processorSource, /\/api\/vas\/voucher\/execute/);
  assert.match(processorSource, /\/api\/vas\/voucher\/preview/);
});

test('static: processor delivers pending gifts via claimPendingGifts (guarded by hasPendingGifts)', () => {
  assert.match(processorSource, /\bhasPendingGifts\(/);
  assert.match(processorSource, /\bclaimPendingGifts\(/);
  assert.match(processorSource, /buildVoucherClaimMessage\(/);
});

test('static: the old CASH_SEND_UNSUPPORTED redirect is gone from the processor', () => {
  assert.ok(!processorSource.includes('CASH_SEND_UNSUPPORTED'));
});
