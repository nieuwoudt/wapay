/**
 * Payout / cash-out commercials (OTT Payout Annexure A, read 2026-08-25).
 *
 * Locks the things that quietly destroy margin:
 * - supplier rates are quoted EXCL VAT and WaPay cannot reclaim it, so every
 *   rail cost must be grossed up before margin is claimed;
 * - the 0.3% switching fee applies to CashSend/VAS ONLY — never to PayShap
 *   or RTC (Annexure A 3.2 vs 3.3). A stray percentage on PayShap would
 *   silently erode the one rail the whole withdrawal margin rests on;
 * - EVERY rail at EVERY legal amount must be margin-positive (a single flat
 *   R14 CashSend fee went underwater above ~R738 face — that is the bug
 *   these bands exist to prevent);
 * - customer fees stay FLAT per band: no percentage is ever quoted to a
 *   customer (FEE_STYLE).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEES,
  FEE_STYLE,
  VAT_BPS,
  inclVatCents,
  cashoutFeeCents,
  cashoutRailCostCents,
  cashoutMarginCents,
  buildCashout,
  buildCashoutRailCost,
  RAIL,
} from '../lib/ledger-core.js';

const MIN_CENTS = 5000; // R50 floor
const MAX_CENTS = 300000; // R3000 no-KYC ceiling
const RAILS = [RAIL.PAYAT, 'PAYSHAP', 'RTC', 'CASHSEND'];

test('VAT: rail costs are grossed up, never taken ex-VAT', () => {
  assert.equal(VAT_BPS, 1500);
  assert.equal(inclVatCents(996), 1146); // ABSA/Nedbank CashSend
  assert.equal(inclVatCents(250), 288); // PayShap
  assert.equal(inclVatCents(450), 518); // RTC
  assert.equal(inclVatCents(865), 995); // Pay@
  for (const rail of RAILS) {
    const cfg = FEES.cashout[rail];
    assert.ok(cfg.railCostExVatCents > 0, `${rail} must state an ex-VAT rate`);
    assert.ok(
      cashoutRailCostCents(rail, MIN_CENTS) > cfg.railCostExVatCents,
      `${rail} cost must be grossed up by VAT`
    );
  }
});

test('the 0.3% switching fee is CashSend/VAS only — never PayShap or RTC', () => {
  assert.equal(FEES.cashout.CASHSEND.switchingBps, 30);
  for (const rail of [RAIL.PAYAT, 'PAYSHAP', 'RTC']) {
    assert.ok(!FEES.cashout[rail].switchingBps, `${rail} is a Bank EFT product: no percentage`);
    // Cost must therefore be identical at R50 and at R3000.
    assert.equal(
      cashoutRailCostCents(rail, MIN_CENTS),
      cashoutRailCostCents(rail, MAX_CENTS),
      `${rail} cost must not scale with amount`
    );
  }
  // CashSend, by contrast, must scale.
  assert.ok(cashoutRailCostCents('CASHSEND', MAX_CENTS) > cashoutRailCostCents('CASHSEND', MIN_CENTS));
});

test('EVERY rail is margin-positive at EVERY amount R50..R3000', () => {
  for (const rail of RAILS) {
    for (let cents = MIN_CENTS; cents <= MAX_CENTS; cents += 100) {
      const margin = cashoutMarginCents(rail, cents);
      assert.ok(
        margin > 0,
        `${rail} loses ${margin}c at ${cents}c — a fee band is underwater`
      );
    }
  }
});

test('the old flat R14 CashSend fee WOULD have gone underwater (regression witness)', () => {
  // The bug these bands prevent: R14 flat against a cost that rises with 0.3%.
  const underwaterAt = 100000; // R1000
  assert.ok(
    1400 - cashoutRailCostCents('CASHSEND', underwaterAt) < 0,
    'R14 flat must be demonstrably loss-making at R1000 — otherwise the bands are unnecessary'
  );
  // And the shipped banded fee must fix exactly that case.
  assert.ok(cashoutMarginCents('CASHSEND', underwaterAt) > 0);
});

test('PayShap is the margin rail: constant margin at any ticket size', () => {
  const small = cashoutMarginCents('PAYSHAP', MIN_CENTS);
  const large = cashoutMarginCents('PAYSHAP', MAX_CENTS);
  assert.equal(small, large, 'flat cost + flat fee = flat margin');
  assert.equal(small, 312, 'R6.00 charged - R2.88 cost incl VAT');
  // It must also beat CashSend at the top end — that is why we steer to it.
  assert.ok(
    cashoutRailCostCents('PAYSHAP', MAX_CENTS) < cashoutRailCostCents('CASHSEND', MAX_CENTS)
  );
});

test('customer fees are FLAT per band — never a percentage', () => {
  assert.equal(FEE_STYLE, 'FLAT');
  for (const rail of RAILS) {
    for (const [, feeCents] of FEES.cashout[rail].bands) {
      assert.ok(Number.isInteger(feeCents), 'a fee band must be integer cents');
      assert.equal(feeCents % 100, 0, `${rail} fee ${feeCents} must be a whole rand`);
    }
    // Within a band the fee cannot move with the amount.
    const [firstMax] = FEES.cashout[rail].bands[0];
    const lo = cashoutFeeCents(rail, MIN_CENTS);
    const hi = cashoutFeeCents(rail, Math.min(firstMax, MAX_CENTS));
    assert.equal(lo, hi, `${rail} band 1 must quote ONE number`);
  }
});

test('bands are ordered, ascending, and end in a catch-all', () => {
  for (const rail of RAILS) {
    const bands = FEES.cashout[rail].bands;
    assert.equal(bands.at(-1)[0], Infinity, `${rail} must have an Infinity catch-all`);
    for (let i = 1; i < bands.length; i += 1) {
      assert.ok(bands[i][0] > bands[i - 1][0], `${rail} band ceilings must ascend`);
      assert.ok(bands[i][1] >= bands[i - 1][1], `${rail} band fees must not decrease`);
    }
  }
});

test('the builders use the banded fee and the VAT-grossed cost', () => {
  const amount = 100000; // R1000 — inside CashSend band 2
  const entry = buildCashout({ accountId: 'acc1', amountCents: amount, idemKey: 'co-1', method: 'CASHSEND' });
  assert.equal(entry.meta.feeCents, cashoutFeeCents('CASHSEND', amount));
  assert.equal(entry.meta.railCostCents, cashoutRailCostCents('CASHSEND', amount));
  const cost = buildCashoutRailCost({ amountCents: amount, idemKey: 'co-1-cost', method: 'CASHSEND' });
  assert.equal(cost.meta.railCostCents, cashoutRailCostCents('CASHSEND', amount));
  // The customer is debited amount + the quoted fee, nothing more.
  const debit = entry.postings.find((p) => p.debitCents)?.debitCents;
  assert.equal(debit, amount + cashoutFeeCents('CASHSEND', amount));
});

test('an unknown rail is rejected, never silently free', () => {
  assert.throws(() => cashoutFeeCents('BITCOIN', 10000), /No cashout config/);
  assert.throws(() => cashoutRailCostCents('BITCOIN', 10000), /No cashout config/);
});
