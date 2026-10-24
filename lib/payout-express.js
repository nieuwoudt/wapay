/**
 * The express fee (founder 2026-10-24): "if you want to do a withdrawal within 2hrs of receipt, you need
 * to pay 2x the current fee". Money that arrived less than WAPAY_PAYOUT_EXPRESS_WINDOW_MINUTES (120) ago
 * can still be paid out on the OTT rails, at WAPAY_PAYOUT_EXPRESS_FEE_MULTIPLIER (2) times the method's
 * fee. It keeps money in WaPay a little longer and prices the fast cash-out that card fraud relies on;
 * spending stays free of it (and the cards, when they come, give immediate access without it).
 *
 * Only the part of a pay-out that needs fresh money makes it express: a pay-out the older balance can
 * cover, fee included, pays the normal fee. Fresh money is what CREDITED the customer's own wallets from
 * outside (RECEIPT_SOURCE_RE): a paid link or a top-up (LOAD_*), a Blu voucher load, a send from another
 * member, a claimed gift, a manual credit, a referral reward. Internal moves (the SPEND to CASH upgrade
 * and its reverse), refunds of the customer's own money (a failed airtime vend, a gift that came back)
 * and reversals never count. A failed read counts as no fresh money: this is a fee, never a gate.
 *
 * Every quote shown to a customer and requestPayout itself use the same decision, and requestPayout
 * refuses (FEE_CHANGED) when the fee it would charge is higher than the one the customer confirmed.
 */
import { ACCT, BALANCE } from './ledger-core.js';

export const RECEIPT_SOURCE_RE = /^(LOAD_|BLU_DEPOSIT$|P2P_SEND$|GIFT_CLAIM_BALANCE$|MANUAL_GIFT_TO_WALLET$|REFERRAL_REWARD$|TEST_CREDIT)/;

export function expressRules(env = process.env) {
  const n = (k, d) => { const v = Number(env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
  return {
    windowMs: Math.round(n('WAPAY_PAYOUT_EXPRESS_WINDOW_MINUTES', 120) * 60 * 1000),
    multiplier: n('WAPAY_PAYOUT_EXPRESS_FEE_MULTIPLIER', 2),
  };
}

/** Money that came in from outside within the window: [{ cents, at }] (epoch ms), oldest first. Never throws. */
export async function recentReceipts({ prisma, accountId, now = Date.now(), env = process.env }) {
  const { windowMs } = expressRules(env);
  if (!accountId || !windowMs || typeof prisma?.journalLine?.findMany !== 'function') return [];
  try {
    const lines = await prisma.journalLine.findMany({
      where: {
        accountCode: { in: [ACCT.wallet(accountId, BALANCE.SPEND), ACCT.wallet(accountId, BALANCE.CASH)] },
        creditCents: { gt: 0 },
        entry: { createdAt: { gte: new Date(now - windowMs), lte: new Date(now) } },
      },
      select: { creditCents: true, entry: { select: { source: true, createdAt: true } } },
    });
    return (lines || [])
      .filter((l) => RECEIPT_SOURCE_RE.test(String(l?.entry?.source || '')))
      .map((l) => ({ cents: Number(l.creditCents) || 0, at: new Date(l.entry.createdAt).getTime() }))
      .filter((r) => r.cents > 0 && Number.isFinite(r.at))
      .sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
}

/**
 * The decision for one pay-out. `normalFeeCents` is the method's own fee for this amount. Express when
 * the amount plus that fee needs money from the window; the fee is then multiplied. `normalFromAt` (epoch
 * ms) is when enough of the window's money has aged out for the normal fee, or null when it never will
 * (the balance cannot cover the pay-out at all).
 */
export function expressFor({ balanceCents, receipts = [], amountCents, normalFeeCents, now = Date.now(), env = process.env }) {
  const { windowMs, multiplier } = expressRules(env);
  const live = (receipts || []).filter((r) => r && now - Number(r.at) < windowMs).sort((a, b) => a.at - b.at);
  const freshCents = live.reduce((s, r) => s + (Number(r.cents) || 0), 0);
  const balance = Math.max(0, Number(balanceCents) || 0);
  const settledCents = Math.max(0, balance - freshCents);
  const need = (Number(amountCents) || 0) + (Number(normalFeeCents) || 0);
  const express = multiplier > 1 && freshCents > 0 && (Number(normalFeeCents) || 0) > 0 && need > settledCents;
  let normalFromAt = null;
  if (express && need <= balance) {
    // Money leaves the window oldest first; the normal fee applies once what is left of it fits.
    let stillFresh = freshCents;
    for (const r of live) {
      stillFresh -= r.cents;
      if (balance - Math.max(0, stillFresh) >= need) { normalFromAt = r.at + windowMs; break; }
    }
  }
  return {
    express,
    multiplier: express ? multiplier : 1,
    feeCents: express ? Math.round((Number(normalFeeCents) || 0) * multiplier) : Number(normalFeeCents) || 0,
    normalFeeCents: Number(normalFeeCents) || 0,
    freshCents,
    settledCents,
    normalFromAt,
  };
}

/** "14:35" in South African time. */
export function sastClock(ms) {
  return new Date(ms).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Johannesburg' });
}

const R = (c) => `R${(Number(c || 0) / 100).toFixed(2).replace(/\.00$/, '')}`;

/** The one line that explains a doubled fee; empty when the fee is normal. */
export function expressFeeLine(ex) {
  if (!ex?.express) return '';
  const when = ex.normalFromAt ? ` From ${sastClock(ex.normalFromAt)} the fee is ${R(ex.normalFeeCents)}.` : '';
  return `The fee is doubled because some of this money reached your balance less than 2 hours ago.${when}`;
}
