/**
 * buildVoucherGift — the "Send R50 to 084..." money math.
 *
 * A voucher gift is a GOODS purchase, not a money transfer: sender pays
 * face + flat R3 fee from SPEND, the issuing rail is owed face less any
 * commission, and the fee is revenue. Commission is 0 until OTT's rate card
 * is signed, so the commission line must be absent today and appear (still
 * balanced) the day the rate goes in.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCT,
  BALANCE,
  FEES,
  RAIL,
  bps,
  buildVoucherGift,
  deriveWalletBalance,
  netMarginCents,
  trialBalance,
  validateBalanced,
} from '../lib/ledger-core.js';

const ALICE = 'acct_alice';
const RECIPIENT = '0840012300';

// ---------------------------------------------------------------------------
// Balance and shape
// ---------------------------------------------------------------------------

test('a voucher gift is a balanced entry', () => {
  const e = buildVoucherGift({
    senderAccountId: ALICE,
    amountCents: 5000,
    idemKey: 'gift-1',
    recipientMsisdn: RECIPIENT,
  });
  assert.doesNotThrow(() => validateBalanced(e.postings));
  assert.equal(trialBalance([e]), 0);
});

test('sender pays face + R3 flat fee from the no-KYC SPEND balance', () => {
  const e = buildVoucherGift({
    senderAccountId: ALICE,
    amountCents: 5000,
    idemKey: 'gift-2',
    recipientMsisdn: RECIPIENT,
  });

  const debit = e.postings.find((p) => p.debitCents);
  assert.equal(debit.accountCode, ACCT.wallet(ALICE, BALANCE.SPEND), 'gifts buy from SPEND, no KYC gate');
  assert.equal(debit.debitCents, 5300, 'R50 face + R3 flat fee');
  assert.equal(deriveWalletBalance([e], ALICE), -5300);
  assert.equal(e.meta.flatFeeCents, FEES.voucherGift.flatFeeCents);
});

test('the rail is owed full face value while commission is 0', () => {
  const e = buildVoucherGift({
    senderAccountId: ALICE,
    amountCents: 5000,
    idemKey: 'gift-3',
    recipientMsisdn: RECIPIENT,
  });

  const clearing = e.postings.find((p) => p.accountCode === ACCT.clearing(RAIL.OTT));
  assert.equal(clearing.creditCents, 5000, 'no signed commission means the rail keeps nothing back');
  assert.equal(e.meta.commissionCents, 0);
  assert.equal(e.meta.railCents, 5000);
});

test('flat fee lands in REVENUE:FEE:SEND and is the entire margin today', () => {
  const e = buildVoucherGift({
    senderAccountId: ALICE,
    amountCents: 5000,
    idemKey: 'gift-4',
    recipientMsisdn: RECIPIENT,
  });

  const fee = e.postings.find((p) => p.accountCode === ACCT.feeRevenue('SEND'));
  assert.equal(fee.creditCents, 300);
  assert.equal(netMarginCents([e]), 300, 'until OTT rates are signed, the R3 fee is all we earn');
});

// ---------------------------------------------------------------------------
// Commission — zero-line guard today, correct split when rates arrive
// ---------------------------------------------------------------------------

test('commission line is OMITTED while commissionBps is 0 (zero-line guard)', () => {
  const e = buildVoucherGift({
    senderAccountId: ALICE,
    amountCents: 5000,
    idemKey: 'gift-5',
    recipientMsisdn: RECIPIENT,
  });
  const commission = e.postings.find((p) => p.accountCode === ACCT.commissionRevenue('VOUCHER'));
  assert.equal(commission, undefined, 'a zero-amount journal line must never be emitted');
  assert.equal(e.postings.length, 3, 'wallet debit, clearing credit, fee credit — nothing else');
});

test('a signed commission rate splits face between rail and revenue, still balanced', () => {
  // Simulate the day OTT's rate card is signed at 1% (100 bps).
  const original = FEES.voucherGift.commissionBps;
  FEES.voucherGift.commissionBps = 100;
  try {
    const e = buildVoucherGift({
      senderAccountId: ALICE,
      amountCents: 5000,
      idemKey: 'gift-6',
      recipientMsisdn: RECIPIENT,
    });

    const commission = e.postings.find((p) => p.accountCode === ACCT.commissionRevenue('VOUCHER'));
    assert.equal(commission.creditCents, 50, '1% of R50');

    const clearing = e.postings.find((p) => p.accountCode === ACCT.clearing(RAIL.OTT));
    assert.equal(clearing.creditCents, 4950, 'rail is owed face minus our commission');

    assert.equal(e.meta.railCents + e.meta.commissionCents, 5000, 'split must reconcile exactly');
    assert.doesNotThrow(() => validateBalanced(e.postings));
    assert.equal(netMarginCents([e]), 300 + 50, 'fee plus commission');
  } finally {
    FEES.voucherGift.commissionBps = original;
  }
});

test('commission split reconciles for odd amounts (rounding never loses cents)', () => {
  const original = FEES.voucherGift.commissionBps;
  FEES.voucherGift.commissionBps = 150;
  try {
    for (const amount of [1, 7, 333, 999, 12345, 99999]) {
      const e = buildVoucherGift({
        senderAccountId: ALICE,
        amountCents: amount,
        idemKey: `gift-round-${amount}`,
        recipientMsisdn: RECIPIENT,
      });
      assert.equal(e.meta.railCents + e.meta.commissionCents, amount, `split must equal face for ${amount}`);
      assert.equal(e.meta.commissionCents, bps(amount, 150));
      assert.doesNotThrow(() => validateBalanced(e.postings));
    }
  } finally {
    FEES.voucherGift.commissionBps = original;
  }
});

// ---------------------------------------------------------------------------
// Rail-agnostic source, masked recipient
// ---------------------------------------------------------------------------

test('source names the rail: OTT by default, any RAIL on request', () => {
  const ott = buildVoucherGift({
    senderAccountId: ALICE,
    amountCents: 5000,
    idemKey: 'gift-7',
    recipientMsisdn: RECIPIENT,
  });
  assert.equal(ott.source, 'VOUCHER_GIFT_OTT');
  assert.equal(ott.meta.rail, RAIL.OTT);

  const blu = buildVoucherGift({
    senderAccountId: ALICE,
    amountCents: 5000,
    idemKey: 'gift-8',
    rail: RAIL.BLU,
    recipientMsisdn: RECIPIENT,
  });
  assert.equal(blu.source, 'VOUCHER_GIFT_BLU');
  const clearing = blu.postings.find((p) => p.accountCode === ACCT.clearing(RAIL.BLU));
  assert.ok(clearing, 'the chosen rail owns the clearing account');
});

test('meta stores only a MASKED recipient, never the full number', () => {
  const e = buildVoucherGift({
    senderAccountId: ALICE,
    amountCents: 5000,
    idemKey: 'gift-9',
    recipientMsisdn: RECIPIENT,
  });
  assert.equal(e.meta.recipientMasked, '084•••300');
  assert.ok(
    !JSON.stringify(e).includes(RECIPIENT),
    'the full msisdn must not appear anywhere in the entry'
  );
});

// ---------------------------------------------------------------------------
// Guard rails
// ---------------------------------------------------------------------------

test('rejects zero, negative, and fractional amounts', () => {
  const base = { senderAccountId: ALICE, idemKey: 'gift-bad', recipientMsisdn: RECIPIENT };
  assert.throws(() => buildVoucherGift({ ...base, amountCents: 0 }), /greater than zero/);
  assert.throws(() => buildVoucherGift({ ...base, amountCents: -100 }), /negative/);
  assert.throws(() => buildVoucherGift({ ...base, amountCents: 50.5 }), /integer/);
});

test('rejects timestamp-based idemKeys (the Date.now() bug)', () => {
  assert.throws(
    () =>
      buildVoucherGift({
        senderAccountId: ALICE,
        amountCents: 5000,
        idemKey: `gift-${1763971714144}`,
        recipientMsisdn: RECIPIENT,
      }),
    /timestamp-based/
  );
});
