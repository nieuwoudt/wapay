/**
 * "Send money" moves balance, never a voucher (founder decision 2026-10-18,
 * BUGLOG #116). Before this, every send bought an OTT voucher for the
 * recipient: Lisa's R350 on 12 Oct arrived as a PIN on OTT's test host and
 * her balance stayed R0, while the copy promised "lands in their balance".
 *
 *   to a member (onboarding complete)  an immediate SPEND → SPEND transfer
 *                                      (buildSend, P2P_SEND, free);
 *   to anyone else                     held as WaPay's liability (buildGiftHeld,
 *                                      free) with a WAPAY gift row, credited to
 *                                      their balance when they join
 *                                      (claimHeldGiftsToBalance), refunded to the
 *                                      sender after 30 days if they never do.
 *
 * No payment rail is touched on any path. Money moves only with the sender's
 * PIN proof bound to this preview and this amount (docs/GOLDEN_THREAD.md 2.1,
 * 2.7): verifyPIN issues it in the route, this module checks it before any
 * write. What the sender reads is the same for a member and a non-member
 * (membership-neutral: a send must never become an oracle for who is on
 * WaPay, memory cross-user-actions-need-consent-gate).
 */
import prismaDefault from './prisma.js';
import { readPayoutFreeze } from './payout-freeze.js';
import * as ledgerDefault from './ledger-post.js';
import { BALANCE, buildSend, buildGiftHeld } from './ledger-core.js';
import { normaliseMsisdn, toWaId } from './msisdn.js';
import { verifyPinProof } from '@wapay/auth/pin-proof';
import { createHeldGift } from './pending-gifts.js';
import { buildRecipientNotification } from './gifting.js';

/** A member is an account that finished onboarding (founder default, 2026-10-18). */
export const MEMBER_STATE = 'S5_COMPLETED';
export const SEND_MIN_CENTS = 1000;
export const SEND_MAX_CENTS = 100000;

/** The member behind a typed number, or null. Both stored forms are matched. */
export async function findMember({ prisma = prismaDefault, msisdn }) {
  const zero = normaliseMsisdn(msisdn);
  if (!zero) return null;
  const wa = toWaId(zero);
  return prisma.account.findFirst({
    where: { onboardingState: MEMBER_STATE, OR: [{ msisdn: zero }, { msisdn: wa }, { waId: wa }] },
    select: { id: true, displayName: true, msisdn: true, waId: true },
  });
}

/** The fee a send carries: none, to anyone (founder default, 2026-10-18). Quoted fee = booked fee. */
export const sendFeeCents = () => 0;

/**
 * Move the money for one confirmed send. Idempotent on the preview id: a
 * replay returns the first outcome and moves nothing again.
 *   → { ok: true, delivered: 'BALANCE' | 'HELD', amountCents, giftId?, recipientAccountId?, replayed }
 *   → { ok: false, error: 'NOT_AUTHORISED' | 'SELF' | 'BAD_AMOUNT' | 'INSUFFICIENT_FUNDS' }
 */
export async function sendMoney({ prisma = prismaDefault, ledger = ledgerDefault, sender, previewId, recipientMsisdn, amountCents, authorization, giftId = null }) {
  const proof = verifyPinProof(authorization, { accountId: sender?.id, intentId: previewId, amountCents });
  if (!proof.ok) return { ok: false, error: 'NOT_AUTHORISED', reason: proof.reason };
  if (await readPayoutFreeze({ prisma, accountId: sender?.id, fallbackProfile: sender?.profile || null })) return { ok: false, error: 'FROZEN' };
  if (!Number.isInteger(amountCents) || amountCents < SEND_MIN_CENTS || amountCents > SEND_MAX_CENTS) return { ok: false, error: 'BAD_AMOUNT' };
  const to = normaliseMsisdn(recipientMsisdn);
  if (!to || to === normaliseMsisdn(sender.msisdn || sender.waId || '')) return { ok: false, error: 'SELF' };

  const member = await findMember({ prisma, msisdn: to });
  try {
    if (member) {
      if (member.id === sender.id) return { ok: false, error: 'SELF' };
      await ledger.ensureWallet({ accountId: member.id, balanceType: BALANCE.SPEND });
      const r = await ledger.postEntry(buildSend({ fromAccountId: sender.id, toAccountId: member.id, amountCents, idemKey: `send-${previewId}` }));
      return { ok: true, delivered: 'BALANCE', amountCents, recipientAccountId: member.id, recipientName: member.displayName || null, replayed: !!r?.replayed };
    }
    // Not a member: the money waits as WaPay's liability, the row and the entry
    // in one transaction, so a held gift can never exist without its row or the
    // reverse. The gift id is the preview's, so a replay finds both.
    const id = giftId || `gift-${previewId}`;
    const result = await prisma.$transaction(async (tx) => {
      const r = await ledger.postEntry(buildGiftHeld({ senderAccountId: sender.id, amountCents, giftId: id, recipientMsisdn: to, flatFeeCentsOverride: sendFeeCents() }), { tx });
      await createHeldGift({ prisma: tx, giftId: id, senderAccountId: sender.id, recipientMsisdn: to, amountCents });
      return r;
    });
    return { ok: true, delivered: 'HELD', amountCents, giftId: id, replayed: !!result?.replayed };
  } catch (e) {
    if (e?.name === 'InsufficientFundsError' || /insufficient/i.test(String(e?.message))) return { ok: false, error: 'INSUFFICIENT_FUNDS' };
    throw e;
  }
}

/**
 * The env naming the approved UTILITY template that tells a member money landed in their balance
 * when their 24-hour window is closed (docs/templates/wapay_money_received.md). Unset or 'off':
 * a member hears only inside their window, as before 2026-11-10.
 */
export const MONEY_RECEIVED_TEMPLATE_ENV = 'WAPAY_TEMPLATE_MONEY_RECEIVED';

/** Is the money-received template switched on? Pure. */
export function moneyReceivedTemplateOn(env = process.env) {
  const v = String(env?.[MONEY_RECEIVED_TEMPLATE_ENV] || '').trim();
  return !!v && v.toLowerCase() !== 'off';
}

/**
 * The sender's line about who tells the recipient: the same words whoever the number belongs to
 * (membership-neutral). Pure.
 */
export function recipientNoticeLine(env = process.env) {
  return moneyReceivedTemplateOn(env)
    ? 'If they use WaPay, WaPay tells them on WhatsApp. If not, let them know it is waiting for them.'
    : 'WaPay does not message them, so let them know you sent it.';
}

/**
 * What the sender reads after the money moved: the same words for a member
 * and a non-member. Pure.
 */
export function sendReceiptText({ amountCents, recipientMsisdn, newBalanceCents, env = process.env }) {
  const R = (c) => `R${(c / 100).toFixed(2).replace(/\.00$/, '')}`;
  return `✅ *Sent ${R(amountCents)}* to ${recipientMsisdn}.\n\nIt is in their WaPay balance, or it waits there for them until they join WaPay. No fee. ${recipientNoticeLine(env)}\n\n💳 Your balance: ${R(newBalanceCents)}`;
}

/**
 * Tell the person who was paid (founder, 2026-11-10: "the user should automatically receive a
 * message from WaPay if they get paid by another customer").
 *
 *   a member (the money is in their balance)   every time: inside their 24-hour window a plain
 *                                               message; outside it notifyCustomer, which asks the
 *                                               outbound guard first and then sends the approved
 *                                               UTILITY template named by WAPAY_TEMPLATE_MONEY_RECEIVED
 *                                               (unset: nothing outside the window);
 *   anyone else (the money waits for them)      only inside a window they opened by writing to WaPay.
 *                                               A typed number is never consent: a number that never
 *                                               wrote to WaPay hears nothing (BUGLOG #144, Meta's
 *                                               second spam strike).
 *
 * Someone who said stop hears nothing until they write again. A credit to your own account is the
 * receipt of a transaction on it (utility), never a promotion. Best effort: never throws, never
 * blocks the send.
 * @returns {Promise<{ sent: boolean, reason: string|null, rail?: string|null }>}
 */
export async function notifySendRecipient({ prisma = prismaDefault, sender, recipientMsisdn, amountCents, delivered, env = process.env, now = Date.now(), deps = {} } = {}) {
  try {
    const to = normaliseMsisdn(recipientMsisdn || '');
    if (!to || !Number.isInteger(amountCents) || amountCents <= 0) return { sent: false, reason: 'BAD_ARGS' };
    if (to === normaliseMsisdn(sender?.msisdn || sender?.waId || '')) return { sent: false, reason: 'SELF' };
    const wa = toWaId(to);
    const recipient = await prisma.account.findFirst({ where: { OR: [{ waId: wa }, { msisdn: wa }, { msisdn: to }] }, select: { id: true, waId: true, profile: true } });
    if (!recipient) return { sent: false, reason: 'NO_ACCOUNT' };
    const last = await prisma.conversationTurn.findFirst({ where: { accountId: recipient.id, role: 'user' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }).catch(() => null);
    const lastAt = last?.createdAt ? new Date(last.createdAt).getTime() : null;
    const messaging = recipient.profile?.messaging;
    const optOutAt = messaging?.optOut ? Date.parse(messaging.optOutAt || 0) || 0 : null;
    if (optOutAt != null && !(lastAt && lastAt > optOutAt)) return { sent: false, reason: 'OPTED_OUT' };
    const windowOpen = lastAt != null && now - lastAt < 24 * 60 * 60 * 1000;
    const note = buildRecipientNotification({ senderName: sender?.displayName, senderMsisdn: sender?.msisdn || sender?.waId, product: 'MONEY', amountCents, delivered });
    const toWa = recipient.waId || wa;
    if (delivered === 'BALANCE') {
      if (!windowOpen && !moneyReceivedTemplateOn(env)) return { sent: false, reason: 'NO_TEMPLATE' };
      const notify = deps.notifyCustomer || (await import('./notify.js')).notifyCustomer;
      const r = await notify({ to: toWa, accountId: recipient.id, text: note.fallbackText, kind: 'receipt', templateEnv: MONEY_RECEIVED_TEMPLATE_ENV, templateParams: [note.who, note.what] });
      return { sent: !!r?.ok, reason: r?.ok ? null : r?.error || 'NOT_SENT', rail: r?.rail || null };
    }
    if (!windowOpen) return { sent: false, reason: 'NO_WINDOW' };
    const say = deps.say || (await import('./say.js'));
    const r = await say.sendWhatsAppText({ to: toWa, text: note.fallbackText, kind: 'receipt' });
    return { sent: !!r?.ok, reason: r?.ok ? null : r?.error || 'NOT_SENT', rail: 'text' };
  } catch (error) {
    return { sent: false, reason: 'ERROR', error: error?.message };
  }
}

/** The confirm the sender reads before the PIN: the same for a member and a non-member. Pure. */
export function sendConfirmText({ amountCents, recipientMsisdn }) {
  const R = (c) => `R${(c / 100).toFixed(2).replace(/\.00$/, '')}`;
  return `💸 *Send ${R(amountCents)}* to ${recipientMsisdn}?\n\nIt lands in their WaPay balance: straight away if they use WaPay, or when they join. No fee.\n\nReply *YES* to continue to your PIN, or *NO* to cancel.`;
}

/**
 * The daily refund of held sends nobody claimed (pages/api/cron/daily-vas-sync.js,
 * folded in like the pay-out sweep: Hobby plan, one daily cron). Each sender is
 * told once through notifyCustomer (the rail that crosses the 24-hour window);
 * a sender we cannot reach gets the fact in their history instead, so the
 * agent's next turn is not looking at a balance that changed for no reason.
 * Best-effort: never throws.
 */
export async function refundHeldGiftsAndNotify({ prisma = prismaDefault, ledger, deps = {}, now = new Date() } = {}) {
  const counts = { refunded: 0, notified: 0, notifyFailed: 0 };
  const { refundExpiredHeldGifts, HELD_GIFT_DAYS } = await import('./pending-gifts.js');
  const refunded = await refundExpiredHeldGifts({ prisma, ledger, now });
  const R = (c) => `R${(c / 100).toFixed(2).replace(/\.00$/, '')}`;
  for (const g of refunded) {
    counts.refunded += 1;
    const text = `↩️ The ${R(g.amountCents)} you sent to ${g.recipientMsisdn} was not collected in ${HELD_GIFT_DAYS()} days, so it is back in your WaPay balance. Nothing else changed.`;
    try {
      const sender = await prisma.account.findUnique({ where: { id: g.senderAccountId }, select: { waId: true } });
      const notify = deps.notifyCustomer || (await import('./notify.js')).notifyCustomer;
      const sent = sender?.waId ? await notify({ to: sender.waId, accountId: g.senderAccountId, text, kind: 'receipt', templateEnv: 'WAPAY_TEMPLATE_SEND_REFUND', templateParams: [R(g.amountCents), g.recipientMsisdn] }) : { ok: false };
      if (sent?.ok === false) throw new Error('NOT_SENT');
      counts.notified += 1;
    } catch {
      counts.notifyFailed += 1;
      const record = deps.recordMoneyEvent || (await import('./notify.js')).recordMoneyEvent;
      await record({ prisma, accountId: g.senderAccountId, text, kind: 'reconcile', refs: { giftId: g.giftId } }).catch(() => {});
    }
  }
  return counts;
}
