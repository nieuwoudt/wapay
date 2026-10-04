/**
 * Pay-out books: the reconciliation Mission Control shows between the three
 * places a withdrawal leaves a mark and the one place the money actually sits.
 *
 *   providerRequest (route ott-payout)  what we asked the rail and what it said
 *   holds (reason "payout …")           the customer's money parked while the rail works
 *   journal (source CASHOUT_*)          what settled: cash-out, our fee, the rail's cost
 *   the supplier's pay-out float        read live by /api/admin/floats, compared on the card
 *
 * Pure: takes rows, returns numbers and a list of checks. The route fetches,
 * this file judges, the card renders. Nothing here names a recipient; the
 * reference (WP…) and the method are the only identifiers that leave.
 *
 * The money rules this guards (CLAUDE.md, lib/payouts.js):
 *   SUCCESS  = hold SETTLED + one -cashout entry (never two)
 *   FAILED   = hold RELEASED (or never reserved) + no -cashout entry
 *   PENDING / INIT = hold ACTIVE: money held, not spent, not released
 *   an ACTIVE hold with no open pay-out row is money stuck with nobody chasing it
 */

const toInt = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
const OPEN = new Set(['PENDING', 'INIT']);

/** Sum of wallet balances: what WaPay owes its customers right now. */
export function clientFunds(walletSums = []) {
  const out = { spendCents: 0, cashCents: 0, pendingCents: 0, wallets: 0 };
  for (const w of walletSums || []) {
    const avail = toInt(w?._sum?.availableCents ?? w?.availableCents);
    const pend = toInt(w?._sum?.pendingCents ?? w?.pendingCents);
    const type = String(w?.balanceType || '').toUpperCase();
    if (type === 'CASH') out.cashCents += avail; else out.spendCents += avail;
    out.pendingCents += pend;
    out.wallets += toInt(w?._count?._all ?? 1);
  }
  out.totalCents = out.spendCents + out.cashCents + out.pendingCents;
  return out;
}

/** Classify CASHOUT_* journal entries by what they book. */
export function ledgerTotals(entries = []) {
  const out = { paidOutCents: 0, feeRevenueCents: 0, railCostCents: 0, paidOutEntries: 0, railCostEntries: 0 };
  for (const e of entries || []) {
    const key = String(e?.idemKey || '');
    const lines = Array.isArray(e?.lines) ? e.lines : [];
    if (key.endsWith('-cashout')) {
      out.paidOutEntries += 1;
      for (const l of lines) {
        if (String(l.accountCode).startsWith('CLEARING:')) out.paidOutCents += toInt(l.creditCents);
        if (l.accountCode === 'REVENUE:FEE:CASHOUT') out.feeRevenueCents += toInt(l.creditCents);
      }
    } else if (key.endsWith('-railcost')) {
      out.railCostEntries += 1;
      for (const l of lines) if (String(l.accountCode).startsWith('EXPENSE:PROVIDER:')) out.railCostCents += toInt(l.debitCents);
    }
  }
  return out;
}

/**
 * Judge the books. Every check is { id, label, ok, count }; every anomaly is a
 * row a human must look at, with the reference, status, method, amount and
 * the one-line problem. `ok` is null when a check could not run.
 */
export function reconcilePayoutBooks({ payoutRows = [], holds = [], entries = [], walletSums = [], now = new Date() } = {}) {
  const holdByKey = new Map();
  for (const h of holds || []) holdByKey.set(String(h.idemKey || ''), h);
  const entryByKey = new Map();
  for (const e of entries || []) entryByKey.set(String(e.idemKey || ''), e);

  const byStatus = {};
  const bump = (status, m) => {
    const s = byStatus[status] || (byStatus[status] = { count: 0, amountCents: 0, feeCents: 0 });
    s.count += 1; s.amountCents += toInt(m.amountCents); s.feeCents += toInt(m.feeCents);
  };

  const anomalies = [];
  const counts = {
    successNoCashout: 0, successHoldNotSettled: 0, failedWithCashout: 0, failedHoldNotReleased: 0,
    openNoActiveHold: 0, orphanActiveHolds: 0, duplicateCashout: 0,
  };
  let openHeldFromRows = 0;
  let successAmountFromRows = 0;
  const openKeys = new Set();

  for (const pr of payoutRows || []) {
    const m = pr?.metadata && typeof pr.metadata === 'object' ? pr.metadata : {};
    const status = String(pr?.status || 'UNKNOWN').toUpperCase();
    bump(status, m);
    const base = String(pr?.idemKey || '');
    const hold = holdByKey.get(`${base}-hold`) || null;
    const cashout = entryByKey.get(`${base}-cashout`) || null;
    const row = (problem) => anomalies.push({
      reference: m.reference || null, status, method: m.method || null,
      amountCents: m.amountCents ?? null, feeCents: m.feeCents ?? null,
      ageMinutes: pr?.requestTs ? Math.round((now.getTime() - new Date(pr.requestTs).getTime()) / 60000) : null,
      problem,
    });
    if (status === 'SUCCESS') {
      successAmountFromRows += toInt(m.amountCents);
      if (!cashout) { counts.successNoCashout += 1; row('SUCCESS at the rail but no pay-out entry in the journal: the customer was paid and our books do not show it.'); }
      if (hold && hold.status !== 'SETTLED') { counts.successHoldNotSettled += 1; row(`SUCCESS but its hold is ${hold.status}: the money may still be parked or may have gone back to the customer after being paid.`); }
      if (!hold) { counts.successHoldNotSettled += 1; row('SUCCESS with no hold on record: nothing was reserved before the rail paid.'); }
    } else if (status === 'FAILED') {
      if (cashout) { counts.failedWithCashout += 1; row('FAILED at the rail but a pay-out journal entry exists: the customer may have been debited for money that never left.'); }
      if (hold && hold.status === 'ACTIVE') { counts.failedHoldNotReleased += 1; row('FAILED but the hold is still ACTIVE: the customer cannot use this money and nobody is chasing it.'); }
      if (hold && hold.status === 'SETTLED') { counts.failedHoldNotReleased += 1; row('FAILED but the hold was SETTLED: the customer paid for a withdrawal that did not happen.'); }
    } else if (OPEN.has(status)) {
      openKeys.add(`${base}-hold`);
      openHeldFromRows += toInt(m.amountCents) + toInt(m.feeCents);
      if (!hold || hold.status !== 'ACTIVE') { counts.openNoActiveHold += 1; row(`${status} with ${hold ? `a ${hold.status} hold` : 'no hold'}: the rail may still pay this and the money is not parked.`); }
      if (cashout) { counts.duplicateCashout += 1; row(`${status} but a pay-out journal entry already exists: a late SUCCESS would book it twice.`); }
    }
  }

  let activeHeldCents = 0;
  let activeHolds = 0;
  for (const h of holds || []) {
    if (h.status !== 'ACTIVE') continue;
    activeHolds += 1;
    activeHeldCents += toInt(h.amountCents);
    if (!openKeys.has(String(h.idemKey))) {
      counts.orphanActiveHolds += 1;
      anomalies.push({
        reference: null, status: 'HOLD', method: null, amountCents: toInt(h.amountCents), feeCents: null,
        ageMinutes: h.createdAt ? Math.round((now.getTime() - new Date(h.createdAt).getTime()) / 60000) : null,
        problem: `ACTIVE pay-out hold with no open pay-out row (${String(h.idemKey || '').slice(-12)}): money parked with nobody chasing it.`,
      });
    }
  }

  const ledger = ledgerTotals(entries);
  const funds = clientFunds(walletSums);

  const checks = [
    { id: 'success_booked', label: 'Every SUCCESS has one journal entry and a settled hold', ok: counts.successNoCashout + counts.successHoldNotSettled === 0, count: counts.successNoCashout + counts.successHoldNotSettled },
    { id: 'failed_clean', label: 'Every FAILED released its hold and booked nothing', ok: counts.failedWithCashout + counts.failedHoldNotReleased === 0, count: counts.failedWithCashout + counts.failedHoldNotReleased },
    { id: 'open_held', label: 'Every PENDING or INIT pay-out is holding its money', ok: counts.openNoActiveHold + counts.duplicateCashout === 0, count: counts.openNoActiveHold + counts.duplicateCashout },
    { id: 'no_orphans', label: 'No active pay-out hold without an open pay-out', ok: counts.orphanActiveHolds === 0, count: counts.orphanActiveHolds },
    { id: 'held_total', label: 'Active holds equal what the open pay-outs say is held', ok: activeHeldCents === openHeldFromRows, count: Math.abs(activeHeldCents - openHeldFromRows) },
    { id: 'ledger_total', label: 'Journal pay-outs equal the SUCCESS rows’ amounts', ok: ledger.paidOutCents === successAmountFromRows, count: Math.abs(ledger.paidOutCents - successAmountFromRows) },
    { id: 'cashout_per_success', label: 'One journal entry per SUCCESS, never two', ok: ledger.paidOutEntries === (byStatus.SUCCESS?.count || 0), count: Math.abs(ledger.paidOutEntries - (byStatus.SUCCESS?.count || 0)) },
  ];

  return {
    generatedAt: now.toISOString(),
    clientFunds: funds,
    payouts: {
      total: (payoutRows || []).length,
      byStatus,
      openCount: (byStatus.PENDING?.count || 0) + (byStatus.INIT?.count || 0),
      openHeldCents: openHeldFromRows,
      activeHolds,
      activeHeldCents,
      successAmountCents: successAmountFromRows,
    },
    ledger,
    checks,
    allOk: checks.every((c) => c.ok === true),
    anomalies: anomalies.slice(0, 50),
  };
}
