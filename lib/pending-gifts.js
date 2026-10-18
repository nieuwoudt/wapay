/**
 * Pending voucher gifts — the claim store for "Send R50 to 084...".
 *
 * When a sender gifts a voucher, the rail (OTT today) has already issued it
 * by the time a row lands here. This module only answers three questions:
 *   * createPendingGift  - remember an issued voucher for a recipient
 *                          (idempotent: a replayed idemKey returns the row)
 *   * claimPendingGifts  - the recipient showed up on WhatsApp; hand over
 *                          every ISSUED gift exactly once, oldest first
 *   * hasPendingGifts    - cheap existence check for greeting copy
 *
 * Money movement is NOT this module's job — the sender was debited via
 * lib/ledger-core.js buildVoucherGift + postEntry before the row exists.
 *
 * SECURITY: voucherPin is a bearer secret (whoever holds it can redeem the
 * value). The full PIN is returned to callers — delivery needs it — but it
 * must NEVER appear in logs; everything logged here goes through maskPin.
 */

import prisma from './prisma.js';
import { normaliseMsisdn } from './msisdn.js';

const CLAIMABLE_STATUS = 'ISSUED';

/**
 * Mask a voucher PIN for logs, in the maskMsisdn style: a hint of the tail,
 * never enough to redeem. '' for anything too short to mask safely.
 * @param {string} pin
 * @returns {string}
 */
export function maskPin(pin = '') {
  const s = String(pin ?? '');
  if (s.length < 4) return '';
  return `•••${s.slice(-4)}`;
}

/** Show only the last 3 digits of a number in logs (mirrors lib/gifting.js). */
function maskMsisdn(raw = '') {
  const m = normaliseMsisdn(raw);
  if (!m || m.length < 4) return '';
  return `${m.slice(0, 3)}•••${m.slice(-3)}`;
}

function requireString(v, name) {
  if (!v || typeof v !== 'string') throw new Error(`${name} is required`);
  return v;
}

/**
 * Record an issued voucher gift awaiting its recipient.
 *
 * Idempotent on idemKey: replaying the same key (webhook redelivery, retry
 * after a crash between OTT issue and this write) returns the original row
 * instead of storing the voucher twice.
 *
 * @param {object} args
 * @param {object} [args.prisma] - injectable for tests; defaults to the shared client
 * @param {string} args.senderAccountId
 * @param {string} args.recipientMsisdn - normalised before storage so claims match
 * @param {number} args.amountCents - integer cents, > 0
 * @param {string} args.rail - issuing rail, e.g. 'OTT'
 * @param {string} args.voucherPin - bearer secret; stored, never logged
 * @param {string} [args.voucherSerial]
 * @param {string} args.idemKey - deterministic; same key as the ledger entry's
 * @returns {Promise<object>} the PendingGift row (existing one on replay)
 */
export async function createPendingGift({
  prisma: prismaClient = prisma,
  senderAccountId,
  recipientMsisdn,
  amountCents,
  rail,
  voucherPin,
  voucherSerial = null,
  idemKey,
}) {
  requireString(senderAccountId, 'senderAccountId');
  requireString(rail, 'rail');
  requireString(voucherPin, 'voucherPin');
  requireString(idemKey, 'idemKey');
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`amountCents must be a positive integer number of cents, got ${amountCents}`);
  }
  const msisdn = normaliseMsisdn(recipientMsisdn);
  requireString(msisdn, 'recipientMsisdn');

  const existing = await prismaClient.pendingGift.findUnique({ where: { idemKey } });
  if (existing) return existing;

  try {
    const gift = await prismaClient.pendingGift.create({
      data: {
        senderAccountId,
        recipientMsisdn: msisdn,
        amountCents,
        rail,
        voucherPin,
        voucherSerial,
        status: CLAIMABLE_STATUS,
        idemKey,
      },
    });
    console.log(JSON.stringify({
      type: 'pending_gift_created',
      giftId: gift.id,
      senderAccountId,
      recipientMasked: maskMsisdn(msisdn),
      amountCents,
      rail,
      pinMasked: maskPin(voucherPin),
      idemKey,
      timestamp: new Date().toISOString(),
    }));
    return gift;
  } catch (err) {
    // Two concurrent creates of the same key: the loser hits the unique
    // constraint. That is success — the gift exists; return the winner's row.
    if (err?.code === 'P2002') {
      const winner = await prismaClient.pendingGift.findUnique({ where: { idemKey } });
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Deliver every ISSUED gift waiting for this number, oldest first.
 *
 * Each row is claimed with a status-guarded updateMany (ISSUED -> DELIVERED),
 * the same atomic check-and-set that closes the check-then-write race in the
 * ledger: if two webhook invocations claim concurrently, only the guard
 * winner gets each gift, so a gift is delivered exactly once. Rows lost to
 * the other claimer are simply omitted here — the winner delivered them.
 *
 * @param {object} args
 * @param {object} [args.prisma] - injectable for tests
 * @param {string} args.recipientMsisdn
 * @returns {Promise<Array<object>>} the gifts THIS call delivered (may be []),
 *   each with status DELIVERED and deliveredAt set. Rows include the full
 *   voucherPin — the caller is about to hand it to the recipient — so the
 *   caller must not log them wholesale.
 */
export async function claimPendingGifts({ prisma: prismaClient = prisma, recipientMsisdn, rails = VOUCHER_RAILS }) {
  const msisdn = normaliseMsisdn(recipientMsisdn);
  requireString(msisdn, 'recipientMsisdn');

  // Voucher rails only: a held send (rail WAPAY) is balance, never a PIN, and is
  // claimed by claimHeldGiftsToBalance (BUGLOG #116). Without this filter the fuel
  // and OTT self-purchase sweeps would hand a held gift out as a fake PIN.
  const candidates = await prismaClient.pendingGift.findMany({
    where: { recipientMsisdn: msisdn, status: CLAIMABLE_STATUS, rail: { in: rails } },
    orderBy: { createdAt: 'asc' },
  });
  if (candidates.length === 0) return [];

  const delivered = [];
  for (const gift of candidates) {
    const deliveredAt = new Date();
    // Guarded update: count is 0 when a concurrent claim beat us to this row.
    const updated = await prismaClient.pendingGift.updateMany({
      where: { id: gift.id, status: CLAIMABLE_STATUS },
      data: { status: 'DELIVERED', deliveredAt },
    });
    if (updated.count === 1) {
      delivered.push({ ...gift, status: 'DELIVERED', deliveredAt });
    }
  }

  if (delivered.length > 0) {
    console.log(JSON.stringify({
      type: 'pending_gifts_delivered',
      recipientMasked: maskMsisdn(msisdn),
      count: delivered.length,
      giftIds: delivered.map((g) => g.id),
      amountCentsTotal: delivered.reduce((sum, g) => sum + g.amountCents, 0),
      timestamp: new Date().toISOString(),
    }));
  }
  return delivered;
}

/**
 * Does this number have gifts waiting? Read-only, claims nothing.
 *
 * @param {object} args
 * @param {object} [args.prisma] - injectable for tests
 * @param {string} args.recipientMsisdn
 * @returns {Promise<boolean>}
 */
/**
 * Has this sender ever sent money (a voucher gift) TO this recipient? A real
 * prior money movement — the only tie strong enough to gate a directed
 * in-chat payment request on (abuse review 2026-08-25: a bare saved
 * beneficiary is attacker-self-populatable via a contact-card share; a
 * PendingGift is not — it required the sender to actually spend to them).
 *
 * @returns {Promise<boolean>}
 */
export async function hasPriorSendTo({ prisma: prismaClient = prisma, senderAccountId, recipientMsisdn }) {
  const m = String(recipientMsisdn || '').trim();
  if (!senderAccountId || !m) return false;
  try {
    const hit = await prismaClient.pendingGift.findFirst({
      where: { senderAccountId, recipientMsisdn: m },
    });
    return Boolean(hit);
  } catch (error) {
    console.error(JSON.stringify({ type: 'prior_send_check_error', senderAccountId, error: error?.message }));
    return false;
  }
}

export async function hasPendingGifts({ prisma: prismaClient = prisma, recipientMsisdn }) {
  const msisdn = normaliseMsisdn(recipientMsisdn);
  requireString(msisdn, 'recipientMsisdn');

  const first = await prismaClient.pendingGift.findFirst({
    where: { recipientMsisdn: msisdn, status: CLAIMABLE_STATUS },
    select: { id: true },
  });
  return first !== null;
}

/**
 * Put a gift back to ISSUED after a DEFINITIVELY failed delivery send, so
 * the next inbound message retries the claim. Only flips DELIVERED rows —
 * a real delivery is never reverted by a late caller.
 *
 * QA 2026-08-21: claiming marked DELIVERED before the WhatsApp send; one
 * failed send permanently stranded the recipient's bearer PIN.
 */
export async function revertGiftDelivery({ prisma: prismaClient = prisma, giftId }) {
  if (!giftId) return false;
  const updated = await prismaClient.pendingGift.updateMany({
    where: { id: giftId, status: 'DELIVERED' },
    data: { status: 'ISSUED', deliveredAt: null },
  });
  return updated.count === 1;
}

/** Rails whose gift is a voucher PIN to hand over; WAPAY gifts are balance, never a PIN. */
export const VOUCHER_RAILS = Object.freeze(['OTT', 'YOYO', 'BLU']);
export const HELD_RAIL = 'WAPAY';

/**
 * A held send to someone not yet on WaPay (lib/send-money.js). No PIN exists:
 * the money is WaPay's liability (LIABILITY:GIFT_PENDING) until they join.
 * Called inside the same transaction as the gift-held entry. Idempotent on
 * the gift id (idemKey gift-held-<giftId>, the entry's own key).
 */
export async function createHeldGift({ prisma: prismaClient = prisma, giftId, senderAccountId, recipientMsisdn, amountCents }) {
  requireString(giftId, 'giftId');
  requireString(senderAccountId, 'senderAccountId');
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error(`amountCents must be a positive integer number of cents, got ${amountCents}`);
  const msisdn = normaliseMsisdn(recipientMsisdn);
  requireString(msisdn, 'recipientMsisdn');
  const idemKey = `gift-held-${giftId}`;
  const existing = await prismaClient.pendingGift.findUnique({ where: { idemKey } });
  if (existing) return existing;
  const gift = await prismaClient.pendingGift.create({
    data: { id: giftId, senderAccountId, recipientMsisdn: msisdn, amountCents, rail: HELD_RAIL, voucherPin: null, voucherSerial: null, status: CLAIMABLE_STATUS, idemKey },
  });
  console.log(JSON.stringify({ type: 'held_gift_created', giftId, senderAccountId, recipientMasked: maskMsisdn(msisdn), amountCents, timestamp: new Date().toISOString() }));
  return gift;
}

/**
 * The recipient is a member now: every held gift to their number becomes
 * balance, exactly once. Each row is claimed with the guarded ISSUED →
 * DELIVERED flip; the entry (gift-claim-balance-<giftId>) is idempotent, so a
 * crash between the two is finished by the next message, and a second claim
 * posts nothing. A failed post puts the row back to ISSUED.
 *   → [{ giftId, amountCents, senderAccountId }] claimed by THIS call
 */
export async function claimHeldGiftsToBalance({ prisma: prismaClient = prisma, ledger, account }) {
  const msisdn = normaliseMsisdn(account?.msisdn || account?.waId || '');
  if (!account?.id || !msisdn) return [];
  const { buildGiftClaimToBalance, BALANCE } = await import('./ledger-core.js');
  const post = ledger || (await import('./ledger-post.js'));
  const rows = await prismaClient.pendingGift.findMany({ where: { recipientMsisdn: msisdn, rail: HELD_RAIL, status: CLAIMABLE_STATUS }, orderBy: { createdAt: 'asc' } });
  const claimed = [];
  for (const gift of rows) {
    const flipped = await prismaClient.pendingGift.updateMany({ where: { id: gift.id, status: CLAIMABLE_STATUS }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    if (flipped.count !== 1) continue;
    try {
      await post.ensureWallet({ accountId: account.id, balanceType: BALANCE.SPEND });
      await post.postEntry(buildGiftClaimToBalance({ recipientAccountId: account.id, amountCents: gift.amountCents, giftId: gift.id }));
      claimed.push({ giftId: gift.id, amountCents: gift.amountCents, senderAccountId: gift.senderAccountId });
    } catch (e) {
      await prismaClient.pendingGift.updateMany({ where: { id: gift.id, status: 'DELIVERED' }, data: { status: CLAIMABLE_STATUS, deliveredAt: null } }).catch(() => {});
      console.error(JSON.stringify({ type: 'held_gift_claim_failed', giftId: gift.id, error: e?.message }));
    }
  }
  if (claimed.length) console.log(JSON.stringify({ type: 'held_gifts_claimed', accountId: account.id, count: claimed.length, amountCentsTotal: claimed.reduce((s, g) => s + g.amountCents, 0), timestamp: new Date().toISOString() }));
  return claimed;
}

/**
 * Held gifts nobody claimed within WAPAY_HELD_GIFT_DAYS (default 30) go back
 * to their senders (founder default, 2026-10-18; OTT issuing is off, so no
 * voucher at expiry). Guarded flip ISSUED → REFUNDED, then the idempotent
 * entry gift-refund-<giftId>; a failed post flips back. Run by the cron sweep.
 *   → [{ giftId, senderAccountId, amountCents, recipientMsisdn }] refunded by THIS call
 */
export const HELD_GIFT_DAYS = () => Math.max(1, Number(process.env.WAPAY_HELD_GIFT_DAYS ?? 30));
export async function refundExpiredHeldGifts({ prisma: prismaClient = prisma, ledger, now = new Date(), limit = 200 } = {}) {
  const { buildGiftRefund, BALANCE } = await import('./ledger-core.js');
  const post = ledger || (await import('./ledger-post.js'));
  const cutoff = new Date(now.getTime() - HELD_GIFT_DAYS() * 86400 * 1000);
  const rows = await prismaClient.pendingGift.findMany({ where: { rail: HELD_RAIL, status: CLAIMABLE_STATUS, createdAt: { lt: cutoff } }, orderBy: { createdAt: 'asc' }, take: limit });
  const refunded = [];
  for (const gift of rows) {
    const flipped = await prismaClient.pendingGift.updateMany({ where: { id: gift.id, status: CLAIMABLE_STATUS }, data: { status: 'REFUNDED', deliveredAt: now } });
    if (flipped.count !== 1) continue;
    try {
      await post.ensureWallet({ accountId: gift.senderAccountId, balanceType: BALANCE.SPEND });
      await post.postEntry(buildGiftRefund({ senderAccountId: gift.senderAccountId, amountCents: gift.amountCents, giftId: gift.id, recipientMsisdn: gift.recipientMsisdn }));
      refunded.push({ giftId: gift.id, senderAccountId: gift.senderAccountId, amountCents: gift.amountCents, recipientMsisdn: gift.recipientMsisdn });
    } catch (e) {
      await prismaClient.pendingGift.updateMany({ where: { id: gift.id, status: 'REFUNDED' }, data: { status: CLAIMABLE_STATUS, deliveredAt: null } }).catch(() => {});
      console.error(JSON.stringify({ type: 'held_gift_refund_failed', giftId: gift.id, error: e?.message }));
    }
  }
  return refunded;
}

