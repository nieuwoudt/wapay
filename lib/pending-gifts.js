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
export async function claimPendingGifts({ prisma: prismaClient = prisma, recipientMsisdn }) {
  const msisdn = normaliseMsisdn(recipientMsisdn);
  requireString(msisdn, 'recipientMsisdn');

  const candidates = await prismaClient.pendingGift.findMany({
    where: { recipientMsisdn: msisdn, status: CLAIMABLE_STATUS },
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
