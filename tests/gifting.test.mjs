/**
 * Tests for the gifting resolver — the V1 launch wedge ("send R50 airtime to Mom").
 * These encode the product rules: what's giftable, gift vs self, and the
 * regulatory guard that a bare cash-send becomes a VOUCHER gift (a GOODS
 * voucher sale) — never a person-to-person money transfer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveGift, buildRecipientNotification, maskMsisdn, GIFTABLE_PRODUCTS } from '../lib/gifting.js';

const SENDER = '0721234567';

test('resolveGift: airtime to another number is a GIFT', () => {
  const r = resolveGift({
    slots: { productHint: 'AIRTIME', amountCents: 5000, msisdn: '0840012300' },
    senderMsisdn: SENDER,
  });
  assert.equal(r.kind, 'GIFT');
  assert.equal(r.ok, true);
  assert.equal(r.recipientMsisdn, '0840012300');
  assert.equal(r.amountCents, 5000);
  assert.equal(r.product, 'AIRTIME');
});

test('resolveGift: data to another number is a GIFT', () => {
  const r = resolveGift({
    slots: { productHint: 'DATA', amountCents: 3000, msisdn: '0831112222' },
    senderMsisdn: SENDER,
  });
  assert.equal(r.kind, 'GIFT');
  assert.equal(r.product, 'DATA');
});

test('resolveGift: buying for your own number is SELF, not a gift', () => {
  const r = resolveGift({
    slots: { productHint: 'AIRTIME', amountCents: 2000, msisdn: SENDER },
    senderMsisdn: SENDER,
  });
  assert.equal(r.kind, 'SELF');
  assert.equal(r.ok, true);
});

test('resolveGift: +27 sender vs 0-prefixed recipient still detected as SELF', () => {
  const r = resolveGift({
    slots: { productHint: 'AIRTIME', amountCents: 2000, msisdn: '0721234567' },
    senderMsisdn: '+27 72 123 4567',
  });
  assert.equal(r.kind, 'SELF');
});

test('resolveGift: bare cash send becomes a VOUCHER_GIFT (goods voucher, never money transfer)', () => {
  const r = resolveGift({
    slots: { productHint: 'SEND_MONEY', amountCents: 5000, msisdn: '0840012300' },
    senderMsisdn: SENDER,
  });
  assert.equal(r.kind, 'VOUCHER_GIFT');
  assert.equal(r.ok, true);
  assert.equal(r.recipientMsisdn, '0840012300');
  assert.equal(r.amountCents, 5000);
  assert.equal(r.product, 'VOUCHER');
});

test('resolveGift: send-money without amount asks for it with voucher-flavoured copy', () => {
  const r = resolveGift({
    slots: { productHint: 'SEND_MONEY', msisdn: '0840012300' },
    senderMsisdn: SENDER,
  });
  assert.equal(r.kind, 'NEEDS_AMOUNT');
  assert.equal(r.ok, false);
  assert.equal(r.product, 'VOUCHER');
  assert.match(r.message, /WaPay voucher/);
  assert.match(r.message, /spend online or take to their bank/i);
});

test('resolveGift: send-money without recipient asks for it (keeps amount, voucher copy)', () => {
  const r = resolveGift({
    slots: { productHint: 'SEND_MONEY', amountCents: 5000 },
    senderMsisdn: SENDER,
  });
  assert.equal(r.kind, 'NEEDS_RECIPIENT');
  assert.equal(r.ok, false);
  assert.equal(r.amountCents, 5000);
  assert.match(r.message, /WaPay voucher/);
});

test('resolveGift: send-money with invalid recipient is rejected', () => {
  const r = resolveGift({
    slots: { productHint: 'SEND_MONEY', amountCents: 5000, msisdn: '12345' },
    senderMsisdn: SENDER,
  });
  assert.equal(r.kind, 'INVALID_RECIPIENT');
  assert.equal(r.ok, false);
});

test('resolveGift: send-money recipient with spaces / +27 is normalised', () => {
  const r = resolveGift({
    slots: { productHint: 'SEND_MONEY', amountCents: 5000, msisdn: '+27 84 001 2300' },
    senderMsisdn: SENDER,
  });
  assert.equal(r.kind, 'VOUCHER_GIFT');
  assert.equal(r.recipientMsisdn, '0840012300');
});

test('resolveGift: non-giftable product (electricity) is rejected', () => {
  const r = resolveGift({
    slots: { productHint: 'ELECTRICITY', amountCents: 5000, msisdn: '0840012300' },
    senderMsisdn: SENDER,
  });
  assert.equal(r.kind, 'NOT_GIFTABLE');
  assert.equal(r.ok, false);
});

test('resolveGift: missing amount asks for it', () => {
  const r = resolveGift({
    slots: { productHint: 'AIRTIME', msisdn: '0840012300' },
    senderMsisdn: SENDER,
  });
  assert.equal(r.kind, 'NEEDS_AMOUNT');
  assert.equal(r.ok, false);
});

test('resolveGift: missing recipient asks for it (but keeps amount + product)', () => {
  const r = resolveGift({
    slots: { productHint: 'AIRTIME', amountCents: 5000 },
    senderMsisdn: SENDER,
  });
  assert.equal(r.kind, 'NEEDS_RECIPIENT');
  assert.equal(r.amountCents, 5000);
  assert.equal(r.product, 'AIRTIME');
});

test('resolveGift: invalid recipient number is rejected', () => {
  const r = resolveGift({
    slots: { productHint: 'AIRTIME', amountCents: 5000, msisdn: '12345' },
    senderMsisdn: SENDER,
  });
  assert.equal(r.kind, 'INVALID_RECIPIENT');
  assert.equal(r.ok, false);
});

test('resolveGift: recipient number with spaces / +27 is normalised', () => {
  const r = resolveGift({
    slots: { productHint: 'AIRTIME', amountCents: 5000, msisdn: '+27 84 001 2300' },
    senderMsisdn: SENDER,
  });
  assert.equal(r.kind, 'GIFT');
  assert.equal(r.recipientMsisdn, '0840012300');
});

test('buildRecipientNotification: uses sender name and formats the amount', () => {
  const n = buildRecipientNotification({
    senderName: 'Sipho',
    senderMsisdn: SENDER,
    product: 'AIRTIME',
    amountCents: 5000,
  });
  assert.equal(n.templateName, 'wapay_voucher_received');
  assert.equal(n.requiresTemplate, true);
  assert.deepEqual(n.bodyParams, ['Sipho', 'R50 airtime']);
  assert.match(n.fallbackText, /Sipho sent you R50 airtime with WaPay/);
});

test('buildRecipientNotification: falls back to a masked number when no name', () => {
  const n = buildRecipientNotification({
    senderMsisdn: '0721234567',
    product: 'DATA',
    amountCents: 3000,
  });
  assert.deepEqual(n.bodyParams, ['072•••567', 'R30 of data']);
});

test('buildRecipientNotification: VOUCHER product reads "a R50 WaPay voucher"', () => {
  const n = buildRecipientNotification({
    senderName: 'Sipho',
    senderMsisdn: SENDER,
    product: 'VOUCHER',
    amountCents: 5000,
  });
  assert.equal(n.templateName, 'wapay_voucher_received');
  assert.deepEqual(n.bodyParams, ['Sipho', 'a R50 WaPay voucher']);
  assert.match(n.fallbackText, /Sipho sent you a R50 WaPay voucher/);
});

test('maskMsisdn: shows only first 3 and last 3 digits', () => {
  assert.equal(maskMsisdn('0721234567'), '072•••567');
  assert.equal(maskMsisdn('+27 84 001 2300'), '084•••300');
  assert.equal(maskMsisdn('123'), '');
});

test('GIFTABLE_PRODUCTS is airtime and data only in V1', () => {
  assert.equal(GIFTABLE_PRODUCTS.has('AIRTIME'), true);
  assert.equal(GIFTABLE_PRODUCTS.has('DATA'), true);
  assert.equal(GIFTABLE_PRODUCTS.has('ELECTRICITY'), false);
});
