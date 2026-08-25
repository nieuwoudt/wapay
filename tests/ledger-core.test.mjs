import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCT,
  BALANCE,
  FEES,
  RAIL,
  bps,
  buildBalanceUpgrade,
  buildCashout,
  buildCashoutRailCost,
  buildLoad,
  buildReversal,
  buildSend,
  buildSpend,
  deriveWalletBalance,
  netMarginCents,
  trialBalance,
  validateBalanced,
} from '../lib/ledger-core.js';

const ALICE = 'acct_alice';
const BOB = 'acct_bob';

// ---------------------------------------------------------------------------
// The invariant everything rests on
// ---------------------------------------------------------------------------

test('validateBalanced: rejects unbalanced entries', () => {
  assert.throws(
    () =>
      validateBalanced([
        { accountCode: 'A', debitCents: 100 },
        { accountCode: 'B', creditCents: 99 },
      ]),
    /not balanced/
  );
});

test('validateBalanced: rejects a line that is both debit and credit', () => {
  assert.throws(
    () =>
      validateBalanced([
        { accountCode: 'A', debitCents: 100, creditCents: 100 },
        { accountCode: 'B', creditCents: 100 },
      ]),
    /both debit and credit/
  );
});

test('validateBalanced: rejects negative and fractional cents', () => {
  assert.throws(
    () => validateBalanced([{ accountCode: 'A', debitCents: -5 }, { accountCode: 'B', creditCents: -5 }]),
    /negative/
  );
  assert.throws(
    () => validateBalanced([{ accountCode: 'A', debitCents: 10.5 }, { accountCode: 'B', creditCents: 10.5 }]),
    /integer/
  );
});

test('every built entry is balanced', () => {
  const entries = [
    buildLoad({ accountId: ALICE, rail: RAIL.BLU, faceCents: 10000, idemKey: 'load-1' }),
    buildSpend({ accountId: ALICE, category: 'AIRTIME', saleCents: 9400, idemKey: 'spend-1' }),
    buildSend({ fromAccountId: ALICE, toAccountId: BOB, amountCents: 5000, idemKey: 'send-1' }),
    buildCashout({ accountId: BOB, amountCents: 10000, idemKey: 'cash-1' }),
  ];
  for (const e of entries) {
    assert.doesNotThrow(() => validateBalanced(e.postings), `unbalanced: ${e.source}`);
  }
  assert.equal(trialBalance(entries), 0, 'global trial balance must be zero');
});

// ---------------------------------------------------------------------------
// Idempotency keys — the defect that allowed double-charges
// ---------------------------------------------------------------------------

test('rejects timestamp-based idemKeys (the Date.now() bug)', () => {
  assert.throws(
    () =>
      buildLoad({
        accountId: ALICE,
        rail: RAIL.BLU,
        faceCents: 10000,
        idemKey: `wapay-redeem-${ALICE}-${1763971714144}`,
      }),
    /timestamp-based/
  );
});

test('accepts deterministic idemKeys derived from message or preview id', () => {
  assert.doesNotThrow(() =>
    buildLoad({ accountId: ALICE, rail: RAIL.BLU, faceCents: 10000, idemKey: 'load:wamid.HBgLMjc4' })
  );
});

// ---------------------------------------------------------------------------
// Load — the 6% problem
// ---------------------------------------------------------------------------

test('Blu load credits net of the 6% Blu keeps', () => {
  const e = buildLoad({ accountId: ALICE, rail: RAIL.BLU, faceCents: 10000, idemKey: 'load-blu' });

  assert.equal(e.meta.receivedCents, 9400, 'we only receive 94% of face');
  assert.equal(e.meta.creditCents, 9400, 'NET policy credits what we received');
  assert.equal(e.meta.promoCents, 0);
  assert.equal(deriveWalletBalance([e], ALICE), 9400);

  // We never book money we did not receive.
  const clearing = e.postings.find((p) => p.accountCode === ACCT.clearing(RAIL.BLU));
  assert.equal(clearing.debitCents, 9400);
});

test('FACE credit policy books the shortfall as promo expense, never as phantom cash', () => {
  const e = buildLoad({ accountId: ALICE, rail: RAIL.PAYFAST, faceCents: 10000, idemKey: 'load-card' });
  assert.equal(e.meta.creditCents, 10000);
  assert.equal(deriveWalletBalance([e], ALICE), 10000);
  assert.equal(trialBalance([e]), 0);
});

test('a FACE-policy voucher load costs WaPay exactly the rail discount', () => {
  // Simulate choosing to credit Blu loads at face value.
  const original = FEES.load[RAIL.BLU].creditPolicy;
  FEES.load[RAIL.BLU].creditPolicy = 'FACE';
  try {
    const e = buildLoad({ accountId: ALICE, rail: RAIL.BLU, faceCents: 10000, idemKey: 'load-face' });
    assert.equal(e.meta.promoCents, 600, 'the R6 we gift is an expense, not free money');
    assert.equal(netMarginCents([e]), -600);
  } finally {
    FEES.load[RAIL.BLU].creditPolicy = original;
  }
});

// ---------------------------------------------------------------------------
// The three flow P&Ls from the business case
// ---------------------------------------------------------------------------

test('Flow A: load R100 Blu then buy airtime nets a small positive margin', () => {
  const load = buildLoad({ accountId: ALICE, rail: RAIL.BLU, faceCents: 10000, idemKey: 'a-load' });
  const spend = buildSpend({
    accountId: ALICE,
    category: 'AIRTIME',
    saleCents: load.meta.creditCents,
    idemKey: 'a-spend',
  });

  assert.equal(deriveWalletBalance([load, spend], ALICE), 0, 'customer spent the full balance');
  assert.equal(netMarginCents([load, spend]), 376, 'R3.76 on a R94 airtime sale (4%)');
  assert.equal(trialBalance([load, spend]), 0);
});

test('Flow B: betting deposit is the margin engine', () => {
  const load = buildLoad({ accountId: ALICE, rail: RAIL.BLU, faceCents: 10000, idemKey: 'b-load' });
  const bet = buildSpend({
    accountId: ALICE,
    category: 'BETTING',
    saleCents: load.meta.creditCents,
    idemKey: 'b-spend',
  });

  assert.equal(netMarginCents([load, bet]), 940, 'R9.40 on a R94 betting deposit (10%)');
  // Betting alone out-earns the 6% redemption cost, which airtime cannot.
  const airtime = buildSpend({ accountId: ALICE, category: 'AIRTIME', saleCents: 9400, idemKey: 'b-air' });
  assert.ok(
    netMarginCents([bet]) > netMarginCents([airtime]) * 2,
    'betting must materially out-earn airtime'
  );
});

test('Flow C: load, send, cash out LOSES money unless fees are charged', () => {
  const load = buildLoad({ accountId: ALICE, rail: RAIL.BLU, faceCents: 10000, idemKey: 'c-load' });

  // Alice upgrades to a withdrawable balance (KYC gate), sends to Bob, Bob withdraws.
  const upgrade = buildBalanceUpgrade({ accountId: ALICE, amountCents: 9400, idemKey: 'c-upgrade' });
  const send = buildSend({
    fromAccountId: ALICE,
    toAccountId: BOB,
    amountCents: 9000,
    idemKey: 'c-send',
    balanceType: BALANCE.CASH,
  });
  const cashout = buildCashout({ accountId: BOB, amountCents: 8000, idemKey: 'c-cash' });
  const railCost = buildCashoutRailCost({ amountCents: 8000, idemKey: 'c-cash-cost' });

  const all = [load, upgrade, send, cashout, railCost];
  assert.equal(trialBalance(all), 0);

  // Fees earned must cover the payout rail's charge.
  const margin = netMarginCents(all);
  // Pay@ costs R8.65 EXCL VAT; WaPay cannot reclaim VAT, so the real cost
  // booked is R9.95 incl (see cashoutRailCostCents).
  assert.equal(margin, 250 + 1200 - 995, 'send R2.50 + cashout R12.00 - Pay@ R9.95 incl VAT');
  assert.ok(margin > 0, 'the send+cashout path must not run at a loss');
});

test('Flow C without fees would be a loss — proves fees are load-bearing', () => {
  const railCost = buildCashoutRailCost({ amountCents: 10000, idemKey: 'no-fee-cost' });
  assert.ok(netMarginCents([railCost]) < 0, 'the rail always costs us something');
});

// ---------------------------------------------------------------------------
// Spend balance vs cash balance — the KYC boundary
// ---------------------------------------------------------------------------

test('spend-to-spend P2P is free (the growth loop)', () => {
  const e = buildSend({ fromAccountId: ALICE, toAccountId: BOB, amountCents: 5000, idemKey: 'p2p-free' });
  assert.equal(e.meta.feeCents, 0);
  assert.equal(deriveWalletBalance([e], ALICE), -5000);
  assert.equal(deriveWalletBalance([e], BOB), 5000);
});

test('cash-balance P2P charges the flat fee', () => {
  const e = buildSend({
    fromAccountId: ALICE,
    toAccountId: BOB,
    amountCents: 5000,
    idemKey: 'p2p-paid',
    balanceType: BALANCE.CASH,
  });
  assert.equal(e.meta.feeCents, 250);
  assert.equal(deriveWalletBalance([e], ALICE, BALANCE.CASH), -5250, 'sender pays amount + fee');
  assert.equal(deriveWalletBalance([e], BOB, BALANCE.CASH), 5000, 'recipient gets the full amount');
  assert.equal(netMarginCents([e]), 250);
});

test('cash-out always debits the CASH balance, never the no-KYC spend balance', () => {
  const e = buildCashout({ accountId: ALICE, amountCents: 10000, idemKey: 'cash-kyc' });
  const debited = e.postings.find((p) => p.debitCents);
  assert.equal(debited.accountCode, ACCT.wallet(ALICE, BALANCE.CASH));
  assert.equal(deriveWalletBalance([e], ALICE, BALANCE.SPEND), 0, 'spend balance is untouchable by withdrawals');
});

test('balance upgrade moves value between the customer\'s own accounts only', () => {
  const e = buildBalanceUpgrade({ accountId: ALICE, amountCents: 5000, idemKey: 'upgrade-1' });
  assert.equal(deriveWalletBalance([e], ALICE, BALANCE.SPEND), -5000);
  assert.equal(deriveWalletBalance([e], ALICE, BALANCE.CASH), 5000);
  assert.equal(netMarginCents([e]), 0, 'upgrading is not a revenue event');
});

// ---------------------------------------------------------------------------
// Cash-out method economics (Pay@ vs OTT PayShap)
// ---------------------------------------------------------------------------

test('PayShap cash-out is cheaper for us and for the customer than Pay@', () => {
  const payat = buildCashout({ accountId: ALICE, amountCents: 10000, idemKey: 'co-payat', method: RAIL.PAYAT });
  const payshap = buildCashout({ accountId: ALICE, amountCents: 10000, idemKey: 'co-shap', method: 'PAYSHAP' });

  assert.ok(payshap.meta.feeCents < payat.meta.feeCents, 'customer pays less via PayShap');
  assert.ok(payshap.meta.railCostCents < payat.meta.railCostCents, 'it costs us less too');

  const payatMargin = netMarginCents([payat, buildCashoutRailCost({ amountCents: 10000, idemKey: 'co-payat-c', method: RAIL.PAYAT })]);
  const shapMargin = netMarginCents([payshap, buildCashoutRailCost({ amountCents: 10000, idemKey: 'co-shap-c', method: 'PAYSHAP' })]);
  assert.ok(payatMargin > 0 && shapMargin > 0, 'both methods must be margin-positive');
});

test('CashSend switching fee scales with amount', () => {
  const small = buildCashoutRailCost({ amountCents: 10000, idemKey: 'cs-small', method: 'CASHSEND' });
  const large = buildCashoutRailCost({ amountCents: 100000, idemKey: 'cs-large', method: 'CASHSEND' });
  assert.ok(large.meta.railCostCents > small.meta.railCostCents, '0.3% switching fee must scale');
  // Both components are grossed up by VAT — WaPay cannot reclaim it, so the
  // ex-VAT rate card is never the real cost (agreement read 2026-08-25).
  assert.equal(small.meta.railCostCents, 1146 + 35, 'R9.96 + 0.3% of R100, both incl VAT');
});

// ---------------------------------------------------------------------------
// Reversals — replacing "rename the source field"
// ---------------------------------------------------------------------------

test('reversal mirrors the original and nets the customer back to zero', () => {
  const spend = buildSpend({ accountId: ALICE, category: 'AIRTIME', saleCents: 9400, idemKey: 'rev-spend' });
  const reversal = buildReversal({ original: spend, idemKey: 'rev-spend:reversal', reason: 'BLU_TIMEOUT' });

  assert.equal(deriveWalletBalance([spend, reversal], ALICE), 0, 'customer made whole');
  assert.equal(netMarginCents([spend, reversal]), 0, 'no phantom commission survives');
  assert.equal(trialBalance([spend, reversal]), 0);
  assert.equal(reversal.meta.reversalOf, 'rev-spend');
});

// ---------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------

test('bps rounds to whole cents and never loses money to floats', () => {
  assert.equal(bps(10000, 600), 600);
  assert.equal(bps(999, 600), 60); // 59.94 -> 60
  assert.equal(bps(1, 600), 0);
});

test('commission split always reconciles exactly, including odd amounts', () => {
  for (const sale of [1, 7, 333, 999, 12345, 99999]) {
    const e = buildSpend({ accountId: ALICE, category: 'DATA', saleCents: sale, idemKey: `round-${sale}` });
    assert.equal(
      e.meta.supplierCents + e.meta.commissionCents,
      sale,
      `supplier + commission must equal the sale for ${sale}`
    );
    assert.doesNotThrow(() => validateBalanced(e.postings));
  }
});
