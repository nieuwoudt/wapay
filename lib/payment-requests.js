/**
 * Payment requests — "please pay me" (founder ask, 2026-08-21).
 *
 * A request is a short shareable code the requester forwards to anyone.
 * Whoever opens wapay.co.za/pay/<code> can pay it two ways:
 *   * from their own WaPay balance (in chat, free, PIN-gated buildSend)
 *   * by card/EFT via PayFast (payer covers the banded payment fee;
 *     requester is credited FACE via the standard ITN machinery)
 *
 * Status machine: PENDING -> PAID exactly once (status-guarded update);
 * PENDING -> CANCELLED by the requester; expiry is enforced at read time.
 * This module never moves money.
 */

import crypto from 'crypto';
import prisma from './prisma.js';

/** R5 floor, R3000 ceiling (same no-KYC exposure cap as deposits). */
export const MIN_REQUEST_CENTS = 500;
export const MAX_REQUEST_CENTS = 300000;

/** Requests live for 7 days — after that the link politely refuses. */
export const REQUEST_TTL_DAYS = 7;

/**
 * Abuse caps on creation (env-tunable; set a cap to 0 to disable it).
 * These protect the free-under-R50 subsidy and the recipients' inboxes —
 * they are NOT money invariants, so approximate enforcement is fine
 * (two concurrent creates may briefly exceed a cap by one; postEntry
 * idempotency still guards every rand).
 */
export const MAX_OPEN_REQUESTS = Number(process.env.WAPAY_PAYREQ_MAX_OPEN ?? 10);
export const MAX_REQUESTS_PER_DAY = Number(process.env.WAPAY_PAYREQ_MAX_PER_DAY ?? 20);

/**
 * Business links (WaPay for Business, 2026-09-04) carry their own caps: a
 * laundry legitimately has dozens of tickets open at once, so the personal
 * caps would cripple it. Counted per BUSINESS, never against the owner's
 * personal chat links (and personal counts exclude business links).
 */
export const MAX_OPEN_BUSINESS_REQUESTS = Number(process.env.WAPAY_BIZ_PAYREQ_MAX_OPEN ?? 250);
export const MAX_BUSINESS_REQUESTS_PER_DAY = Number(process.env.WAPAY_BIZ_PAYREQ_MAX_PER_DAY ?? 300);
/** Business links may live longer than the personal 7 days, up to this. */
export const MAX_BUSINESS_TTL_DAYS = 30;

// Unambiguous alphabet: no 0/O/1/I/L, and letters-only avoids the ledger's
// timestamp-lookalike idemKey guard by construction.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;

/** A short, unambiguous, letters-only request code like "PRKWXQZM". */
export function newRequestCode() {
  let code = 'PR';
  const bytes = crypto.randomBytes(CODE_LENGTH - 2);
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

function requireString(v, name) {
  if (!v || typeof v !== 'string') throw new Error(`${name} is required`);
  return v;
}

/**
 * Create a PENDING payment request for the requester.
 *
 * @param {object} args
 * @param {object} [args.prisma] - injectable for tests
 * @param {string} args.accountId - the REQUESTER (credited when paid)
 * @param {number} args.amountCents - integer cents, R5..R3000
 * @param {string} [args.note] - short free-text shown to the payer
 * @param {object} [args.business] - WaPay for Business extras (all optional;
 *   absent = a personal link, byte-for-byte the pre-2026-09-04 behaviour):
 *   { businessId, customerId, items, reference, ttlDays }
 * @returns {Promise<object>} the request row
 */
export async function createPaymentRequest({ prisma: prismaClient = prisma, accountId, amountCents, note, business = null }) {
  requireString(accountId, 'accountId');
  if (!Number.isInteger(amountCents)) {
    throw new Error(`amountCents must be integer cents, got ${amountCents}`);
  }
  if (amountCents < MIN_REQUEST_CENTS || amountCents > MAX_REQUEST_CENTS) {
    throw new Error(`Request must be between R5 and R3000`);
  }
  const cleanNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 120) : null;

  const businessId = business && typeof business.businessId === 'string' && business.businessId ? business.businessId : null;
  const openCap = businessId ? MAX_OPEN_BUSINESS_REQUESTS : MAX_OPEN_REQUESTS;
  const dayCap = businessId ? MAX_BUSINESS_REQUESTS_PER_DAY : MAX_REQUESTS_PER_DAY;

  // Creation caps. The open-links count MUST exclude lazily-expired rows
  // (status stays PENDING in the DB until someone reads the link) — counting
  // them would permanently lock out anyone with 10 stale unpaid links.
  // Business links count per business; personal links exclude business
  // links, so an owner's own chat "please pay me" is never blocked by their
  // shop's open tickets.
  const now = new Date();
  const scope = businessId ? { businessId } : { accountId, businessId: null };
  const [openCount, dayCount] = await Promise.all([
    openCap > 0
      ? prismaClient.paymentRequest.count({
          where: { ...scope, status: 'PENDING', expiresAt: { gt: now } },
        })
      : 0,
    dayCap > 0
      ? prismaClient.paymentRequest.count({
          where: { ...scope, createdAt: { gt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
        })
      : 0,
  ]);
  if (openCap > 0 && openCount >= openCap) {
    const err = new Error(`Open payment-request limit reached (${openCount} live links)`);
    err.code = 'REQUEST_LIMIT';
    err.limit = 'OPEN';
    err.openCount = openCount;
    throw err;
  }
  if (dayCap > 0 && dayCount >= dayCap) {
    const err = new Error('Daily payment-request creation limit reached');
    err.code = 'REQUEST_LIMIT';
    err.limit = 'DAILY';
    throw err;
  }

  let ttlDays = REQUEST_TTL_DAYS;
  if (businessId && Number.isInteger(business.ttlDays) && business.ttlDays >= 1) {
    ttlDays = Math.min(business.ttlDays, MAX_BUSINESS_TTL_DAYS);
  }
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  const extra = businessId
    ? {
        businessId,
        customerId: typeof business.customerId === 'string' && business.customerId ? business.customerId : null,
        items: Array.isArray(business.items) && business.items.length ? business.items : null,
        reference: typeof business.reference === 'string' && business.reference.trim() ? business.reference.trim().slice(0, 40) : null,
      }
    : {};

  // Collision on an 8-char code is ~impossible, but a unique-violation retry
  // costs one loop iteration and removes the class of bug entirely.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prismaClient.paymentRequest.create({
        data: { id: newRequestCode(), accountId, amountCents, note: cleanNote, expiresAt, ...extra },
      });
    } catch (err) {
      if (err?.code !== 'P2002' || attempt === 2) throw err;
    }
  }
  throw new Error('unreachable');
}

/**
 * Fetch a request by code. Expiry is enforced here: a PENDING request past
 * its expiresAt is reported (and lazily marked) EXPIRED.
 *
 * @returns {Promise<object|null>} the row (status reflects expiry), or null
 */
export async function getPaymentRequest({ prisma: prismaClient = prisma, code }) {
  requireString(code, 'code');
  const row = await prismaClient.paymentRequest.findUnique({ where: { id: code.toUpperCase() } });
  if (!row) return null;
  if (row.status === 'PENDING' && row.expiresAt && row.expiresAt < new Date()) {
    try {
      await prismaClient.paymentRequest.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
    } catch {
      // Display-path best effort; the guard below still reports EXPIRED.
    }
    return { ...row, status: 'EXPIRED' };
  }
  return row;
}

/**
 * Mark a request PAID exactly once (atomic PENDING->PAID check-and-set).
 *
 * @param {object} args
 * @param {object} [args.prisma] - injectable for tests
 * @param {string} args.code
 * @param {string} args.payerRef - 'WAPAY:<accountId>' or 'PAYFAST:<pf id>'
 * @returns {Promise<boolean>} true when THIS call won the transition
 */
export async function markRequestPaid({ prisma: prismaClient = prisma, code, payerRef }) {
  requireString(code, 'code');
  const updated = await prismaClient.paymentRequest.updateMany({
    where: { id: code.toUpperCase(), status: 'PENDING' },
    data: { status: 'PAID', payerRef: payerRef ?? null, paidAt: new Date() },
  });
  return updated.count === 1;
}

/**
 * The requester's most recent PENDING request — what "change my amount to
 * R1000" operates on (cancel + recreate, the smooth swap).
 */
export async function getLatestPendingRequest({ prisma: prismaClient = prisma, accountId }) {
  requireString(accountId, 'accountId');
  // Personal links only: a shop owner's chat "change my amount" must never
  // swap one of their business tickets (those are managed in the portal).
  return prismaClient.paymentRequest.findFirst({
    where: { accountId, status: 'PENDING', businessId: null },
    orderBy: { createdAt: 'desc' },
  });
}

/** Cancel a PENDING request (requester-initiated). */
export async function cancelPaymentRequest({ prisma: prismaClient = prisma, code, accountId }) {
  requireString(code, 'code');
  requireString(accountId, 'accountId');
  const updated = await prismaClient.paymentRequest.updateMany({
    where: { id: code.toUpperCase(), accountId, status: 'PENDING' },
    data: { status: 'CANCELLED' },
  });
  return updated.count === 1;
}

/**
 * The public link for a request code. Set PAYLINK_BASE_URL to the short
 * domain (e.g. https://pleasepayme.co.za) once it's attached to the Vercel
 * project — links become pleasepayme.co.za/PRXXXXXX. Falls back to the
 * app's own /pay path.
 */
export function paymentRequestUrl(code) {
  // FOUNDER DECISION 2026-08-25: pay links read "please pay me" — the
  // market responds to the phrase. Hardcoded so it cannot drift with env
  // churn; wa-pay.me keeps serving all OLD links via the same host rewrite.
  // (PAYLINK_BASE_URL in Vercel is retired — code wins over the stale var.)
  return `https://pleasepayme.co.za/${code}`;
}

/**
 * How a requester is shown to a third-party payer: display name when set,
 * otherwise a masked msisdn (076•••624). Never the full number — the payer
 * may be a stranger who only holds the link.
 */
export function maskedRequesterLabel(account) {
  if (account?.displayName) return account.displayName;
  const m = account?.msisdn;
  if (typeof m === 'string' && m.length >= 6) return `${m.slice(0, 3)}•••${m.slice(-3)}`;
  return 'A WaPay user';
}
