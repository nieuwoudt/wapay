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
      // Money flows AGGREGATED IN SQL (review 2026-08-28: the old row-fetch
      // truncated at 5000 rows and silently understated GMV). One row per
      // (source, week) — bounded — with wallet credit/debit summed.
      safe(() =>
        prisma.$queryRaw`
          SELECT je.source AS source,
                 date_trunc('week', je."createdAt") AS wk,
                 sum(coalesce(jl."creditCents", 0))::bigint AS credit,
                 sum(coalesce(jl."debitCents", 0))::bigint AS debit
          FROM "JournalEntry" je
          JOIN "JournalLine" jl ON jl."entryId" = je.id AND jl."accountCode" LIKE 'WALLET:%'
          WHERE je."createdAt" > ${since}
          GROUP BY 1, 2`
      ),
      // Revenue AGGREGATED: net (credit − debit) per REVENUE account × week,
      // so reversals net out and nothing truncates.
      safe(() =>
        prisma.$queryRaw`
          SELECT jl."accountCode" AS code,
                 date_trunc('week', je."createdAt") AS wk,
                 (sum(coalesce(jl."creditCents", 0)) - sum(coalesce(jl."debitCents", 0)))::bigint AS net
          FROM "JournalLine" jl
          JOIN "JournalEntry" je ON je.id = jl."entryId"
          WHERE jl."accountCode" LIKE 'REVENUE:%' AND je."createdAt" > ${prevSince}
          GROUP BY 1, 2`
      ),
      safe(() =>
        prisma.$queryRaw`SELECT date_trunc('week', "createdAt") AS wk, count(*)::int AS n
                         FROM "Account" GROUP BY 1 ORDER BY 1`
      ),
    ]);

  // Funnel stages from the journal (the contract in the design doc §2).
  const funded = await safe(async () => {
    const rows = await prisma.$queryRaw`
      SELECT count(DISTINCT split_part(jl."accountCode", ':', 2))::int AS n
      FROM "JournalLine" jl
      WHERE jl."accountCode" LIKE 'WALLET:%' AND jl."creditCents" > 0`;
    return rows?.[0]?.n ?? null;
  });
  const transacting = await safe(async () => {
    const rows = await prisma.$queryRaw`
      SELECT count(DISTINCT split_part(jl."accountCode", ':', 2))::int AS n
      FROM "JournalLine" jl
      WHERE jl."accountCode" LIKE 'WALLET:%' AND jl."debitCents" > 0`;
    return rows?.[0]?.n ?? null;
  });
  const repeat = await safe(async () => {
    const rows = await prisma.$queryRaw`
      SELECT count(*)::int AS n FROM (
        SELECT split_part(jl."accountCode", ':', 2) AS acct
        FROM "JournalLine" jl JOIN "JournalEntry" je ON je.id = jl."entryId"
        WHERE jl."accountCode" LIKE 'WALLET:%'
          AND je."createdAt" > now() - interval '30 days'
        GROUP BY 1
        HAVING count(DISTINCT je.id) >= 2
      ) t`;
    return rows?.[0]?.n ?? null;
  });
  const mau = await safe(async () => {
    const rows = await prisma.$queryRaw`
      SELECT count(DISTINCT split_part(jl."accountCode", ':', 2))::int AS n
      FROM "JournalLine" jl JOIN "JournalEntry" je ON je.id = jl."entryId"
      WHERE jl."accountCode" LIKE 'WALLET:%'
        AND je."createdAt" > now() - interval '30 days'`;
    return rows?.[0]?.n ?? null;
  });
  // Contacts = accounts + captured pay-link payers who never onboarded.
  const capturedPayers = await safe(async () => {
    const rows = await prisma.$queryRaw`
      SELECT count(DISTINCT p) AS n FROM (
        SELECT pr."metadata"->>'payerMsisdn' AS p
        FROM "ProviderRequest" pr
        WHERE pr.provider = 'PAYFAST' AND pr."metadata"->>'payerMsisdn' IS NOT NULL
      ) x
      WHERE NOT EXISTS (
        SELECT 1 FROM "Account" a WHERE right(a."waId", 9) = right(x.p, 9)
      )`;
    return Number(rows?.[0]?.n ?? 0);
  }, 0);
  // Acquisition-source split of weekly signups (profile.acquisitionSource,
  // stamped at creation since 2026-08-28 + backfilled).
  const signupsBySource = await safe(async () => {
    const rows = await prisma.$queryRaw`
      SELECT date_trunc('week', "createdAt") AS wk,
             coalesce("profile"->>'acquisitionSource', 'organic') AS src,
             count(*)::int AS n
      FROM "Account" GROUP BY 1, 2 ORDER BY 1`;
    return rows.map((r) => ({
      wk: r.wk instanceof Date ? r.wk.toISOString().slice(0, 10) : String(r.wk).slice(0, 10),
      src: r.src,
      n: r.n,
    }));
  }, []);
  // Retention cohorts: weekly signup cohorts × weeks-since with a money event.
  const cohorts = await safe(async () => {
    const sizes = await prisma.$queryRaw`
      SELECT date_trunc('week', "createdAt") AS wk, count(*)::int AS n
      FROM "Account" GROUP BY 1 ORDER BY 1`;
    const activity = await prisma.$queryRaw`
      SELECT date_trunc('week', a."createdAt") AS cohort,
             greatest(0, floor(extract(epoch FROM (date_trunc('week', je."createdAt") - date_trunc('week', a."createdAt"))) / 604800))::int AS offset_wk,
             count(DISTINCT a.id)::int AS n
      FROM "Account" a
      JOIN "JournalLine" jl ON jl."accountCode" = 'WALLET:' || a.id || ':SPEND'
      JOIN "JournalEntry" je ON je.id = jl."entryId"
      GROUP BY 1, 2 ORDER BY 1, 2`;
    const key = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
    return {
      sizes: sizes.map((r) => ({ wk: key(r.wk), n: r.n })),
      activity: activity.map((r) => ({ cohort: key(r.cohort), offsetWk: r.offset_wk, n: r.n })),
    };
  });

  // Week key from a DB date_trunc('week', ...) value (Postgres weeks start
  // Monday — the JS bucketing below matched that; now the DB does it).
  const wkKey = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v || 0));

  // Flows + GMV from the SQL aggregate. REVERSAL_<X> nets against bucketOf(X).
  const flows = { in: 0, spend: 0, transfer: 0, out: 0 };
  const weeklyFlows = new Map();
  for (const r of entries || []) {
    let source = r.source, sign = 1;
    if (source && source.startsWith('REVERSAL_')) { source = source.slice('REVERSAL_'.length); sign = -1; }
    const b = bucketOf(source);
    if (b === 'other') continue;
    const moved = sign * (b === 'in' ? num(r.credit) : num(r.debit));
    flows[b] += moved;
    if (b !== 'out') {
      const key = wkKey(r.wk);
      if (!weeklyFlows.has(key)) weeklyFlows.set(key, { in: 0, spend: 0, transfer: 0 });
      weeklyFlows.get(key)[b] += moved;
    }
  }
  const gmvCents = flows.in + flows.spend + flows.transfer;

  // Revenue split, current window vs prior (for the delta) + weekly series.
  // `net` already subtracts reversal debits.
  const rev = { current: {}, prior: 0, weekly: new Map() };
  for (const r of revenueLines || []) {
    const net = num(r.net);
    // Week-granular current-vs-prior split (the query spans two windows for
    // the delta). A week bucket at/after `since` counts as current.
    const isCurrent = new Date(r.wk).getTime() >= since.getTime();
    const kind = r.code.startsWith('REVENUE:COMMISSION')
      ? 'commission'
      : r.code.includes(':FEE:')
        ? r.code.split(':').pop().toLowerCase()
        : 'other';
    if (isCurrent) {
      rev.current[kind] = (rev.current[kind] || 0) + net;
      const key = wkKey(r.wk);
      rev.weekly.set(key, (rev.weekly.get(key) || 0) + net);
    } else {
      rev.prior += net;
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
    funnel: {
      contacts: accounts != null ? accounts + (capturedPayers || 0) : null,
      accounts,
      funded,
      transacting,
      repeat,
      capturedPayers,
    },
    signupsBySource,
    cohorts,
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
