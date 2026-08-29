/**
 * Customer LIST for the admin console (founder ask 2026-08-29: "list the
 * customers down here, then obviously we can search them").
 *
 * GET ?q=&limit=&offset=  → newest-first page of customers with the numbers
 * an operator actually scans for: name, number, joined, balance, KYC, state.
 *
 * Same guards as every other admin route: session-cookie or internal-key,
 * fails closed, read-only. Voucher PINs and other bearer secrets are never
 * touched here. `q` is matched by Prisma (parameterised), never string-built.
 */

import prisma from '../../../lib/prisma.js';
import { requireAdmin } from '../../../lib/admin-auth.js';

export const config = { maxDuration: 25 };

const MAX_LIMIT = 100;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });

  const q = String(req.query.q || '').trim();
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || 25));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  // Search by number (any format — digits only) or by display name.
  const digits = q.replace(/\D/g, '');
  const where = q
    ? {
        OR: [
          ...(digits.length >= 3
            ? [{ msisdn: { contains: digits } }, { waId: { contains: digits } }]
            : []),
          { displayName: { contains: q, mode: 'insensitive' } },
        ],
      }
    : {};

  try {
    const [total, accounts] = await Promise.all([
      prisma.account.count({ where }),
      prisma.account.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          waId: true,
          msisdn: true,
          displayName: true,
          status: true,
          onboardingState: true,
          createdAt: true,
          profile: true,
          wallets: { select: { balanceType: true, availableCents: true, pendingCents: true } },
        },
      }),
    ]);

    // Last money movement per listed account, in ONE grouped query rather
    // than N+1 lookups.
    const codes = accounts.map((a) => `WALLET:${a.id}:SPEND`);
    let lastSeen = new Map();
    if (codes.length) {
      try {
        const rows = await prisma.$queryRaw`
          SELECT jl."accountCode" AS code, max(je."createdAt") AS last
          FROM "JournalLine" jl JOIN "JournalEntry" je ON je.id = jl."entryId"
          WHERE jl."accountCode" = ANY(${codes})
          GROUP BY 1`;
        lastSeen = new Map(rows.map((r) => [r.code, r.last]));
      } catch {
        // Non-essential column: the list still renders without it.
      }
    }

    return res.status(200).json({
      total,
      limit,
      offset,
      customers: accounts.map((a) => {
        const profile = a.profile && typeof a.profile === 'object' ? a.profile : {};
        const spend = a.wallets.find((w) => w.balanceType === 'SPEND');
        return {
          id: a.id,
          waId: a.waId,
          msisdn: a.msisdn,
          displayName: a.displayName,
          status: a.status,
          onboardingState: a.onboardingState,
          createdAt: a.createdAt,
          language: profile.language || 'en',
          acquisitionSource: profile.acquisitionSource || 'organic',
          kycStatus: profile.kyc?.status || 'NOT_VERIFIED',
          availableCents: spend?.availableCents ?? 0,
          pendingCents: spend?.pendingCents ?? 0,
          lastActivityAt: lastSeen.get(`WALLET:${a.id}:SPEND`) || null,
        };
      }),
    });
  } catch (error) {
    console.error(JSON.stringify({ type: 'admin_customers_error', error: error?.message }));
    return res.status(500).json({ error: 'Could not load customers.' });
  }
}
