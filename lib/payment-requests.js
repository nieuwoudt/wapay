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
 * @returns {Promise<object>} the request row
 */
export async function createPaymentRequest({ prisma: prismaClient = prisma, accountId, amountCents, note }) {
  requireString(accountId, 'accountId');
  if (!Number.isInteger(amountCents)) {
    throw new Error(`amountCents must be integer cents, got ${amountCents}`);
  }
  if (amountCents < MIN_REQUEST_CENTS || amountCents > MAX_REQUEST_CENTS) {
    throw new Error(`Request must be between R5 and R3000`);
  }
  const cleanNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 120) : null;
  const expiresAt = new Date(Date.now() + REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000);

  // Collision on an 8-char code is ~impossible, but a unique-violation retry
  // costs one loop iteration and removes the class of bug entirely.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prismaClient.paymentRequest.create({
        data: { id: newRequestCode(), accountId, amountCents, note: cleanNote, expiresAt },
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
  return prismaClient.paymentRequest.findFirst({
    where: { accountId, status: 'PENDING' },
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
