/**
 * Beneficiaries — the people an account sends money/airtime/data to.
 *
 * Customers send to the same people again and again (founder ask,
 * 2026-08-19): remembering every successful recipient — and every shared
 * WhatsApp contact card — means "send R50 to Philly" resolves without
 * retyping the number.
 *
 * This module never moves money. Names are display sugar; the msisdn a
 * flow actually uses is always shown IN FULL at the confirm step, so a
 * mis-remembered beneficiary is caught by the same human gate as a
 * mistyped number.
 */

import prisma from './prisma.js';
import { normaliseMsisdn, isValidSaMsisdn } from './msisdn.js';

/**
 * Record (or refresh) a beneficiary after a successful send or a shared
 * contact card. Upsert keyed on (accountId, msisdn): timesUsed bumps,
 * lastUsedAt refreshes, and a name fills in when newly learned — but a
 * known name is never overwritten with null.
 *
 * Best-effort by contract: callers fire-and-forget this around money flows,
 * so it swallows its own failures after logging.
 *
 * @param {object} args
 * @param {object} [args.prisma] - injectable for tests
 * @param {string} args.accountId
 * @param {string} args.msisdn - any format; normalised before storage
 * @param {string} [args.name] - from a shared contact card
 * @returns {Promise<object|null>} the row, or null (invalid input / DB failure)
 */
export async function rememberBeneficiary({ prisma: prismaClient = prisma, accountId, msisdn, name }) {
  try {
    if (!accountId) return null;
    const normalised = normaliseMsisdn(String(msisdn || ''));
    if (!normalised || !isValidSaMsisdn(normalised)) return null;
    const cleanName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : null;

    return await prismaClient.beneficiary.upsert({
      where: { accountId_msisdn: { accountId, msisdn: normalised } },
      create: { accountId, msisdn: normalised, name: cleanName },
      update: {
        timesUsed: { increment: 1 },
        lastUsedAt: new Date(),
        ...(cleanName ? { name: cleanName } : {}),
      },
    });
  } catch (error) {
    console.error(JSON.stringify({ type: 'beneficiary_remember_error', accountId, error: error?.message }));
    return null;
  }
}

/**
 * Find beneficiaries by name for "send R50 to Philly".
 *
 * Case-insensitive substring match on the stored name, most-recently-used
 * first. Returns an ARRAY — the caller decides what a unique hit, an
 * ambiguous set, or a miss means for its flow.
 *
 * @param {object} args
 * @param {object} [args.prisma] - injectable for tests
 * @param {string} args.accountId
 * @param {string} args.query - the name as the user said it
 * @param {number} [args.limit]
 * @returns {Promise<Array<{msisdn: string, name: string|null}>>}
 */
export async function findBeneficiariesByName({ prisma: prismaClient = prisma, accountId, query, limit = 5 }) {
  const q = String(query || '').trim();
  if (!accountId || q.length < 2) return [];
  try {
    return await prismaClient.beneficiary.findMany({
      where: { accountId, name: { contains: q, mode: 'insensitive' } },
      orderBy: { lastUsedAt: 'desc' },
      take: limit,
    });
  } catch (error) {
    console.error(JSON.stringify({ type: 'beneficiary_find_error', accountId, error: error?.message }));
    return [];
  }
}

/**
 * Recent beneficiaries for display ("who do I usually send to?").
 *
 * @param {object} args
 * @param {object} [args.prisma] - injectable for tests
 * @param {string} args.accountId
 * @param {number} [args.limit]
 * @returns {Promise<Array<{msisdn: string, name: string|null}>>}
 */
export async function listRecentBeneficiaries({ prisma: prismaClient = prisma, accountId, limit = 5 }) {
  if (!accountId) return [];
  try {
    return await prismaClient.beneficiary.findMany({
      where: { accountId },
      orderBy: { lastUsedAt: 'desc' },
      take: limit,
    });
  } catch (error) {
    console.error(JSON.stringify({ type: 'beneficiary_list_error', accountId, error: error?.message }));
    return [];
  }
}

/** "Philly (0798743910)" or bare msisdn when no name is known. */
export function formatBeneficiary(b) {
  return b?.name ? `${b.name} (${b.msisdn})` : String(b?.msisdn || '');
}
