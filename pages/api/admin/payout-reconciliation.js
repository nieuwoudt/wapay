/**
 * Pay-out reconciliation — Mission Control's answer to "is every withdrawal
 * accounted for, and does our money match the rail's?" (main session,
 * 2026-10-04, after the first customer withdrawal completed).
 *
 * Reads four things in one batch and hands them to lib/payout-books.js:
 *   - every ott-payout provider row (what we asked, what the rail said),
 *   - every pay-out hold (reason "payout …"),
 *   - every CASHOUT_* journal entry (cash-out, our fee, the rail's cost),
 *   - wallet balances summed by type (what WaPay owes its customers).
 * The supplier's live pay-out float is NOT read here: the card fetches
 * /api/admin/floats separately, so a slow supplier never hides the books.
 *
 * Security: admin session / internal key gated like every admin route. No
 * recipient detail, account id or provider message leaves; references and
 * methods are the only identifiers in the payload.
 */

import prisma from '../../../lib/prisma.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { reconcilePayoutBooks } from '../../../lib/payout-books.js';

export const config = { maxDuration: 25 };

/** The founder's own record of what was wired to the pay-out float, if set. */
function fundedCents() {
  const v = Number(process.env.WAPAY_OTT_PAYOUT_FUNDED_CENTS);
  return Number.isInteger(v) && v >= 0 ? v : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });

  try {
    const [payoutRows, holds, entries, walletSums] = await Promise.all([
      prisma.providerRequest.findMany({
        where: { route: 'ott-payout' },
        select: { idemKey: true, status: true, requestTs: true, metadata: true },
        orderBy: { requestTs: 'desc' },
        take: 2000,
      }),
      prisma.hold.findMany({
        where: { reason: { startsWith: 'payout' } },
        select: { idemKey: true, status: true, amountCents: true, createdAt: true, resolvedAt: true },
        take: 5000,
      }),
      prisma.journalEntry.findMany({
        where: { source: { startsWith: 'CASHOUT' } },
        select: { idemKey: true, source: true, createdAt: true, lines: { select: { accountCode: true, debitCents: true, creditCents: true } } },
        take: 5000,
      }),
      prisma.wallet.groupBy({ by: ['balanceType'], _sum: { availableCents: true, pendingCents: true }, _count: { _all: true } }),
    ]);

    // Only the fields the judge needs; the metadata is reduced to numbers,
    // the method and the reference before it leaves this handler.
    const rows = payoutRows.map((pr) => {
      const m = pr.metadata && typeof pr.metadata === 'object' ? pr.metadata : {};
      return { idemKey: pr.idemKey, status: pr.status, requestTs: pr.requestTs, metadata: { amountCents: m.amountCents ?? null, feeCents: m.feeCents ?? null, method: m.method || null, reference: m.reference || null } };
    });

    const books = reconcilePayoutBooks({ payoutRows: rows, holds, entries, walletSums });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ ...books, supplier: { fundedCents: fundedCents(), floatKey: 'OTT_PAYOUT' } });
  } catch (error) {
    console.log(JSON.stringify({ type: 'admin_payout_reconciliation_failed', error: String(error?.message || error).slice(0, 200), timestamp: new Date().toISOString() }));
    return res.status(500).json({ error: 'BOOKS_UNAVAILABLE' });
  }
}
