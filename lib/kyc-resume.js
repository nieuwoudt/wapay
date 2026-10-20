/**
 * Continue where the customer left off after the identity check (founder, 2026-10-20:
 * "we should be able to continue where we left off automatically").
 *
 * When a pay-out rule sends a customer to the identity check, the ask they were busy
 * with (amount and method) is kept on `profile.kyc.pendingWithdraw`. The moment the
 * verification lands, from Didit's webhook or from a manual sync in Mission Control,
 * `resumeAfterKyc` tells them they are verified and opens the pay-out flow again with
 * that ask, so they answer the next step instead of starting over. If the customer
 * writes "withdraw" first, `startWithdraw` picks the pending ask up itself. A pending
 * ask older than 24 hours is dropped: balances and minds change.
 *
 * Nothing here is business-initiated in the policy sense: the verification is the
 * customer's own action and the continuation is its receipt.
 */
import { mergeProfileSubkeyAtomic } from './profile-merge.js';

export const PENDING_WITHDRAW_TTL_MS = 24 * 60 * 60 * 1000;

/** Keep the ask the identity check interrupted. Never throws. */
export async function rememberPendingWithdraw({ prisma, accountId, ask, now = new Date() }) {
  if (!accountId || !ask || !ask.amountCents) return false;
  try {
    return await mergeProfileSubkeyAtomic({ prisma, accountId, key: 'kyc', patch: { pendingWithdraw: { amountCents: ask.amountCents, method: ask.method || null, at: now.toISOString() } } });
  } catch {
    return false;
  }
}

/** The pending ask if it is still fresh, else null. Pure. */
export function takePendingWithdraw(profile, now = Date.now()) {
  const p = profile && typeof profile === 'object' && profile.kyc && typeof profile.kyc === 'object' ? profile.kyc.pendingWithdraw : null;
  if (!p || !p.amountCents) return null;
  const at = p.at ? Date.parse(p.at) : NaN;
  if (!Number.isFinite(at) || now - at > PENDING_WITHDRAW_TTL_MS) return null;
  return { amountCents: Number(p.amountCents), method: p.method || null };
}

export async function clearPendingWithdraw({ prisma, accountId }) {
  try {
    return await mergeProfileSubkeyAtomic({ prisma, accountId, key: 'kyc', patch: { pendingWithdraw: null } });
  } catch {
    return false;
  }
}

const R = (c) => `R${(Number(c) / 100).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).replace(/ /g, ',')}`;

export function verifiedResumeLine(ask) {
  return `✅ You are verified. Continuing your pay-out of ${R(ask.amountCents)}.`;
}
export const VERIFIED_PLAIN_LINE = '✅ You are verified. Say *withdraw* whenever you want to pay out.';

/**
 * After a VERIFIED result: open the pay-out flow again with the pending ask, or say
 * the plain verified line. `deps` carries the flow and the state helpers so this file
 * imports nothing from the webhook side: { startWithdraw, updateConversationState,
 * send, localize }. Returns { resumed, sent }.
 */
export async function resumeAfterKyc({ prisma, account, deps, now = Date.now() }) {
  const { startWithdraw, updateConversationState, send, localize = async (t) => t } = deps || {};
  const ask = takePendingWithdraw(account?.profile, now);
  if (!ask || !startWithdraw || !updateConversationState || !send) {
    const r = send ? await send({ to: account.waId, text: await localize(VERIFIED_PLAIN_LINE), kind: 'flow' }) : null;
    return { resumed: false, sent: !!(r && r.ok) };
  }
  await send({ to: account.waId, text: await localize(verifiedResumeLine(ask)), kind: 'flow' });
  const step = await startWithdraw({ prisma, account, ask }).catch(() => null);
  await clearPendingWithdraw({ prisma, accountId: account.id });
  if (!step || !step.text) return { resumed: false, sent: true };
  await updateConversationState(account.waId, step.state || null, step.data || null);
  const r = await send({ to: account.waId, text: step.raw ? step.text : await localize(step.text), kind: 'flow', ...(step.refs ? { refs: step.refs } : {}) });
  return { resumed: true, sent: !!(r && r.ok) };
}
