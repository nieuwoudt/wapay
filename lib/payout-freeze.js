/**
 * Per-account pay-out freeze (2026-10-20, BUGLOG #133).
 *
 * The first R3,000 card-paid link was followed by 23 pay-out attempts across
 * three rails, money bounced through two accounts opened minutes earlier, and
 * a second account repeated the shape the same morning. The business needed a
 * way to pause money leaving ONE account while a card payment is checked,
 * without switching pay-outs off for everyone (WAPAY_PAYOUT_ENABLED).
 *
 * The freeze lives on `Account.profile.payouts` and is read at the two places
 * money leaves a balance: requestPayout (lib/payouts.js, before any ledger
 * move) and sendMoney (lib/send-money.js, a frozen account cannot move its
 * balance to another account and withdraw from there). Receiving money is not
 * affected. The customer hears the truth in one line with no time promise and
 * no blame; a person follows up through the Inbox.
 *
 * Set and lifted through POST /api/internal/payout-freeze (internal key) and
 * never by the model: the golden thread keeps account controls out of the AI.
 */
import prisma from './prisma.js';
import { mergeProfileSubkeyAtomic } from './profile-merge.js';

export const FROZEN_PAYOUT_COPY = '⏸ Pay-outs on this account are paused while we check a recent payment. Nothing has left your balance and your money is safe. A person from WaPay will contact you here, and you can reply with any question.';
export const FROZEN_SEND_COPY = '⏸ Sending from this account is paused while we check a recent payment. Your balance is safe and you can still receive money. A person from WaPay will contact you here, and you can reply with any question.';

/** The freeze record on a profile, or null. Pure. */
export function freezeState(profile) {
  const p = profile && typeof profile === 'object' ? profile.payouts : null;
  if (!p || typeof p !== 'object' || p.frozen !== true) return null;
  return { frozen: true, reason: p.reason || null, at: p.at || null, by: p.by || null };
}

export function isPayoutFrozen(profile) {
  return freezeState(profile) !== null;
}

/**
 * Freeze or lift. `by` is an operator label (never a customer field), `reason`
 * a short operator note kept with the record for the Inbox and the audit.
 */
export async function setPayoutFreeze({ prisma: prismaClient = prisma, accountId, frozen, reason = null, by = 'ops', now = new Date() }) {
  const id = String(accountId || '').trim();
  if (!/^[a-z0-9]{20,40}$/i.test(id)) return { ok: false, error: 'BAD_ACCOUNT' };
  const patch = frozen
    ? { frozen: true, reason: reason ? String(reason).slice(0, 200) : null, at: now.toISOString(), by: String(by).slice(0, 40) }
    : { frozen: false, reason: null, at: null, by: null, liftedAt: now.toISOString(), liftedBy: String(by).slice(0, 40) };
  const ok = await mergeProfileSubkeyAtomic({ prisma: prismaClient, accountId: id, key: 'payouts', patch });
  if (!ok) return { ok: false, error: 'NO_ACCOUNT' };
  const row = await prismaClient.account.findUnique({ where: { id }, select: { profile: true } });
  return { ok: true, accountId: id, state: freezeState(row?.profile) };
}

/** A fresh read of the freeze for an account id; falls back to the profile in hand when the read fails. */
export async function readPayoutFreeze({ prisma: prismaClient = prisma, accountId, fallbackProfile = null }) {
  try {
    const row = await prismaClient.account.findUnique({ where: { id: accountId }, select: { profile: true } });
    if (row) return freezeState(row.profile);
  } catch {
    // fall through to what the caller already holds
  }
  return freezeState(fallbackProfile);
}
