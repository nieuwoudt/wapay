/**
 * Mission Control metrics — one pre-aggregated JSON payload for the admin
 * dashboard. Read-only; session-cookie or internal-key gated; per-user data
 * never leaves this endpoint (aggregates only).
 *
 * The metrics CONTRACT lives in docs/ADMIN_DASHBOARD_DESIGN.md. Everything
 * is computed from the double-entry journal (the same postings the trial
 * balance proves), never from counters. Each block is independently
 * try/caught: one failing query nulls its section instead of 500ing the page.
 */

import prisma from '../../../lib/prisma.js';
import { requireAdmin } from '../../../lib/admin-auth.js';

export const config = { maxDuration: 55 };

const RANGES = { '7': 7, '30': 30, '90': 90, all: 3650 };

async function safe(fn, fallback = null) {
  try {
    return await fn();
  } catch (error) {
    console.error(JSON.stringify({ type: 'admin_metrics_block_error', error: error?.message }));
    return fallback;
  }
}

/** Journal flow bucketing by entry source (see lib/ledger-core.js builders). */
function bucketOf(source) {
  if (!source) return 'other';
  if (source.startsWith('LOAD_')) return 'in';
  if (source.startsWith('SPEND_') || source.startsWith('VOUCHER_GIFT_')) return 'spend';
  if (source === 'P2P_SEND') return 'transfer';
  if (source.startsWith('CASHOUT')) return 'out';
  return 'other';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });

  const days = RANGES[String(req.query.range || '30')] ?? 30;
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const prevSince = new Date(since.getTime() - days * 24 * 3600 * 1000);

  const [accounts, accountsPrev, wallets, holds, entries, revenueLines, signupWeeks] =
    await Promise.all([
      safe(() => prisma.account.count()),
      safe(() => prisma.account.count({ where: { createdAt: { lt: since } } })),
      safe(() =>
        prisma.wallet.aggregate({ _sum: { availableCents: true, pendingCents: true }, _count: true })
      ),
      safe(() => prisma.hold.count({ where: { status: 'ACTIVE' } })),
      // Money flows: entries in the window with their wallet-side lines.
      safe(() =>
        prisma.journalEntry.findMany({
          where: { createdAt: { gt: since } },
          select: {
            source: true,
            createdAt: true,
            lines: { select: { accountCode: true, debitCents: true, creditCents: true } },
          },
          orderBy: { createdAt: 'asc' },
          take: 5000,
        })
      ),
      // Revenue: credit lines into REVENUE:* accounts, window + prior window.
      safe(() =>
        prisma.journalLine.findMany({
          where: {
            accountCode: { startsWith: 'REVENUE:' },
            creditCents: { gt: 0 },
            entry: { createdAt: { gt: prevSince } },
          },
          select: { accountCode: true, creditCents: true, entry: { select: { createdAt: true } } },
          take: 10000,
        })
      ),
      safe(() =>
        prisma.$queryRaw`SELECT date_trunc('week', "createdAt") AS wk, count(*)::int AS n
                         FROM "Account" GROUP BY 1 ORDER BY 1`
      ),
    ]);

  // Funded / active: distinct wallet account-codes with credits, from journal.
  const funded = await safe(async () => {
    const rows = await prisma.$queryRaw`
      SELECT count(DISTINCT jl."accountCode")::int AS n
      FROM "JournalLine" jl
      WHERE jl."accountCode" LIKE 'WALLET:%' AND jl."creditCents" > 0`;
    return rows?.[0]?.n ?? null;
  });
  const mau = await safe(async () => {
    const rows = await prisma.$queryRaw`
      SELECT count(DISTINCT jl."accountCode")::int AS n
      FROM "JournalLine" jl JOIN "JournalEntry" je ON je.id = jl."entryId"
      WHERE jl."accountCode" LIKE 'WALLET:%'
        AND je."createdAt" > now() - interval '30 days'`;
    return rows?.[0]?.n ?? null;
  });

  // Flows + GMV from the windowed entries (wallet-perspective, per entry).
  const flows = { in: 0, spend: 0, transfer: 0, out: 0 };
  const weeklyFlows = new Map();
  for (const e of entries || []) {
    const b = bucketOf(e.source);
    if (b === 'other') continue;
    const walletMoved = e.lines
      .filter((l) => l.accountCode.startsWith('WALLET:'))
      .reduce((s, l) => s + (b === 'in' ? l.creditCents || 0 : l.debitCents || 0), 0);
    flows[b] += walletMoved;
    const wk = new Date(e.createdAt);
    wk.setUTCHours(0, 0, 0, 0);
    wk.setUTCDate(wk.getUTCDate() - ((wk.getUTCDay() + 6) % 7)); // Monday
    const key = wk.toISOString().slice(0, 10);
    if (!weeklyFlows.has(key)) weeklyFlows.set(key, { in: 0, spend: 0, transfer: 0 });
    if (b !== 'out') weeklyFlows.get(key)[b] += walletMoved;
  }
  const gmvCents = flows.in + flows.spend + flows.transfer;

  // Revenue split, current window vs prior (for the delta) + weekly series.
  const rev = { current: {}, prior: 0, weekly: new Map() };
  for (const l of revenueLines || []) {
    const inWindow = l.entry.createdAt > since;
    const kind = l.accountCode.startsWith('REVENUE:COMMISSION')
      ? 'commission'
      : l.accountCode.includes(':FEE:')
        ? l.accountCode.split(':').pop().toLowerCase()
        : 'other';
    if (inWindow) {
      rev.current[kind] = (rev.current[kind] || 0) + l.creditCents;
      const wk = new Date(l.entry.createdAt);
      wk.setUTCHours(0, 0, 0, 0);
      wk.setUTCDate(wk.getUTCDate() - ((wk.getUTCDay() + 6) % 7));
      const key = wk.toISOString().slice(0, 10);
      rev.weekly.set(key, (rev.weekly.get(key) || 0) + l.creditCents);
    } else {
      rev.prior += l.creditCents;
    }
  }
  const revenueCents = Object.values(rev.current).reduce((a, b) => a + b, 0);

  const floatCents = (wallets?._sum?.availableCents || 0) + (wallets?._sum?.pendingCents || 0);

  res.setHeader('Cache-Control', 'private, max-age=120');
  return res.status(200).json({
    generatedAt: new Date().toISOString(),
    rangeDays: days,
    vitals: {
      accounts,
      newAccounts: accounts != null && accountsPrev != null ? accounts - accountsPrev : null,
      funded,
      fundedRatePct: accounts && funded != null ? Math.round((1000 * funded) / accounts) / 10 : null,
      mau,
      gmvCents,
      revenueCents,
      revenuePriorCents: rev.prior,
      floatCents,
      takeRatePct: gmvCents > 0 ? Math.round((10000 * revenueCents) / gmvCents) / 100 : null,
      activeHolds: holds,
      walletCount: wallets?._count ?? null,
    },
    funnel: { contacts: null, accounts, funded, note: 'contacts pending acquisition-source stamping (design doc §5)' },
    flows: { ...flows, weekly: [...weeklyFlows.entries()].map(([wk, v]) => ({ wk, ...v })) },
    revenue: {
      byLine: rev.current,
      weekly: [...rev.weekly.entries()].map(([wk, cents]) => ({ wk, cents })),
    },
    signupsWeekly: (signupWeeks || []).map((r) => ({
      wk: r.wk instanceof Date ? r.wk.toISOString().slice(0, 10) : String(r.wk).slice(0, 10),
      n: r.n,
    })),
  });
}
