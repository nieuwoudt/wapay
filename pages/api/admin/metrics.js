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
import { trialBalance, reconcileWallets } from '../../../lib/ledger-post.js';
import { sastDayStart } from '../../../lib/payout-float.js';
import { paymentRequestFeeCents } from '../../../lib/deposits.js';
import { cashoutFeeCents } from '../../../lib/ledger-core.js';

// PayShap pay-out: the customer pays the flat fee; OTT charges R2.50 ex VAT = R2.88 incl (docs/COMMERCIALS.md, Money out).
const PAYSHAP_FEE_CENTS = cashoutFeeCents('PAYSHAP', 10000);
const PAYSHAP_RAIL_COST_CENTS = 288;

/** Journal source → the customer-facing thing that was sold. */
const SELLING_LABELS = {
  SPEND_AIRTIME: 'Airtime',
  SPEND_DATA: 'Data',
  SPEND_ELECTRICITY: 'Electricity',
  SPEND_VOUCHER: 'Vouchers',
  SPEND_FUEL: 'Fuel (wiCode)',
  SPEND_RETAIL: 'Retail (wiCode)',
  VOUCHER_GIFT_OTT: 'OTT vouchers',
  VOUCHER_GIFT_BLU: 'Blu vouchers',
  P2P_SEND: 'Requests paid',
};

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

  // Accounts = onboarding COMPLETE (OTP, PIN, consent). The row is created at
  // first contact, so a bare count overstated "accounts opened" by every
  // person who said hi and left (BUGLOG #99). Contacts keeps the old meaning.
  const ONBOARDED = { onboardingState: 'S5_COMPLETED' };
  const [accounts, accountsPrev, wallets, holds, entries, revenueLines, signupWeeks, contactsAll] =
    await Promise.all([
      safe(() => prisma.account.count({ where: ONBOARDED })),
      safe(() => prisma.account.count({ where: { ...ONBOARDED, createdAt: { lt: since } } })),
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
                         FROM "Account" WHERE "onboardingState" = 'S5_COMPLETED' GROUP BY 1 ORDER BY 1`
      ),
      safe(() => prisma.account.count()),
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
  // Made a link: the step between an account and money in (launch day showed it is where the funnel waits).
  const linked = await safe(async () => {
    const rows = await prisma.$queryRaw`SELECT count(DISTINCT "accountId")::int AS n FROM "payment_requests"`;
    return rows?.[0]?.n ?? null;
  });
  // Payment links as the key figure (founder 2026-10-19): what was created, what was paid and how,
  // what is open, the fee revenue realised, and what the open links are worth if paid by card and
  // then withdrawn by PayShap. Fees from the live schedule; rail costs from docs/COMMERCIALS.md.
  const links = await safe(async () => {
    const rows = await prisma.$queryRaw`
      SELECT status, "amountCents", "payerRef", ("expiresAt" <= now()) AS expired, ("createdAt" >= ${since}) AS in_range
      FROM "payment_requests"`;
    const fee = (c) => { try { return paymentRequestFeeCents(Number(c)); } catch { return 0; } };
    const cardCost = (c) => Math.round((Number(c) * 0.032 + 200) * 1.15); // PayFast credit card, R2.00 + 3.2% ex VAT (COMMERCIALS: Getting paid)
    const sum = (arr, f) => arr.reduce((a, r) => a + f(r), 0);
    const all = rows || [];
    const paid = all.filter((r) => r.status === 'PAID');
    const paidBalance = paid.filter((r) => String(r.payerRef || '').startsWith('WAPAY:'));
    const paidCard = paid.filter((r) => !String(r.payerRef || '').startsWith('WAPAY:'));
    const open = all.filter((r) => r.status === 'PENDING' && !r.expired);
    const lapsed = all.filter((r) => r.status === 'EXPIRED' || (r.status === 'PENDING' && r.expired));
    const inRange = all.filter((r) => r.in_range);
    const openFee = sum(open, (r) => fee(r.amountCents));
    const openMargin = sum(open, (r) => Math.max(0, fee(r.amountCents) - (fee(r.amountCents) > 0 ? cardCost(r.amountCents) : 0)));
    return {
      created: { n: all.length, cents: sum(all, (r) => Number(r.amountCents)) },
      createdInRange: { n: inRange.length, cents: sum(inRange, (r) => Number(r.amountCents)) },
      paid: { n: paid.length, cents: sum(paid, (r) => Number(r.amountCents)), fromBalance: paidBalance.length, byCard: paidCard.length },
      open: { n: open.length, cents: sum(open, (r) => Number(r.amountCents)) },
      lapsed: { n: lapsed.length, cents: sum(lapsed, (r) => Number(r.amountCents)) },
      feeRealisedCents: sum(paidCard, (r) => fee(r.amountCents)),
      ifOpenPaidByCard: { feeCents: openFee, marginCents: openMargin },
      ifThenPaidOut: { n: open.length, feeCents: open.length * PAYSHAP_FEE_CENTS, marginCents: open.length * (PAYSHAP_FEE_CENTS - PAYSHAP_RAIL_COST_CENTS) },
      paidRatePct: all.length ? Math.round((1000 * paid.length) / all.length) / 10 : null,
    };
  });
  // The viral loop: accounts whose first contact was paying someone's link (profile.acquisitionSource = paylink, stamped at creation).
  const viral = await safe(async () => {
    const rows = await prisma.$queryRaw`
      SELECT count(*) FILTER (WHERE "onboardingState" = 'S5_COMPLETED')::int AS onboarded,
             count(*)::int AS contacts,
             count(DISTINCT "profile"->'attribution'->>'referrerAccountId') FILTER (WHERE "onboardingState" = 'S5_COMPLETED')::int AS referrers
      FROM "Account" WHERE "profile"->>'acquisitionSource' = 'paylink'`;
    const r = rows?.[0] || {};
    return { accountsFromLinks: Number(r.onboarded || 0), contactsFromLinks: Number(r.contacts || 0), sendersWhoBroughtAccounts: Number(r.referrers || 0) };
  });
  // Today's money, South African day: in from outside, out to the rail, and what is waiting to be paid.
  const dayStart = sastDayStart(new Date());
  const today = await safe(async () => {
    const [inRows, outRows, paidRows, openAgg, above] = await Promise.all([
      prisma.$queryRaw`SELECT count(DISTINCT je.id)::int AS n, coalesce(sum(jl."creditCents"), 0)::int AS cents
                       FROM "JournalLine" jl JOIN "JournalEntry" je ON je.id = jl."entryId"
                       WHERE je.source LIKE 'LOAD_%' AND jl."accountCode" LIKE 'WALLET:%' AND jl."creditCents" > 0 AND je."createdAt" >= ${dayStart}`,
      prisma.$queryRaw`SELECT count(*)::int AS n, coalesce(sum((metadata->>'amountCents')::int), 0)::int AS cents FROM "ProviderRequest"
                       WHERE route = 'ott-payout' AND status = 'SUCCESS' AND "requestTs" >= ${dayStart}`,
      prisma.$queryRaw`SELECT count(*)::int AS n, coalesce(sum("amountCents"), 0)::int AS cents FROM "payment_requests" WHERE status = 'PAID' AND "paidAt" >= ${dayStart}`,
      prisma.paymentRequest.aggregate({ where: { status: 'PENDING' }, _sum: { amountCents: true }, _count: true }),
      prisma.wallet.count({ where: { balanceType: 'SPEND', availableCents: { gte: 2000 } } }),
    ]);
    return {
      moneyInCents: Number(inRows?.[0]?.cents || 0), moneyInCount: Number(inRows?.[0]?.n || 0),
      payoutsCents: Number(outRows?.[0]?.cents || 0), payoutsCount: Number(outRows?.[0]?.n || 0),
      linksPaidCents: Number(paidRows?.[0]?.cents || 0), linksPaidCount: Number(paidRows?.[0]?.n || 0),
      openLinksCents: openAgg?._sum?.amountCents || 0, openLinksCount: openAgg?._count || 0,
      walletsAbove20: above,
    };
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

  // WHAT'S BEING SOLD — rand + transaction count per category in the window.
  // Sourced from the journal (entry source → category), so it can never
  // disagree with GMV. NOTE: the journal carries no product reference, so
  // product-level detail is deliberately not offered rather than guessed.
  const selling = await safe(async () => {
    const rows = await prisma.$queryRaw`
      SELECT je.source AS source,
             sum(coalesce(jl."debitCents", 0))::bigint AS cents,
             count(DISTINCT je.id)::int AS n
      FROM "JournalEntry" je
      JOIN "JournalLine" jl ON jl."entryId" = je.id AND jl."accountCode" LIKE 'WALLET:%'
      WHERE je."createdAt" > ${since} AND jl."debitCents" > 0
      GROUP BY 1 ORDER BY 2 DESC`;
    return rows
      .filter((r) => SELLING_LABELS[r.source])
      .map((r) => ({
        category: SELLING_LABELS[r.source],
        cents: typeof r.cents === 'bigint' ? Number(r.cents) : Number(r.cents || 0),
        count: r.n,
      }));
  }, []);

  // MONEY-ENGINE HEALTH — the tripwires that say whether the numbers above
  // can be trusted at all. Each is independently guarded: a failing check
  // reports unknown rather than a false green.
  const ops = await safe(async () => {
    const [tb, recon, stuck] = await Promise.all([
      trialBalance().catch(() => null),
      reconcileWallets({ limit: 200 }).catch(() => null),
      prisma.hold
        .count({ where: { status: 'ACTIVE', createdAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } } })
        .catch(() => null),
    ]);
    const driftCents = recon
      ? recon.mismatches.reduce((s, m) => s + Math.abs(m.differenceCents), 0)
      : null;
    return {
      trialBalanced: tb ? tb.balanced : null,
      trialDifferenceCents: tb ? tb.differenceCents : null,
      walletsChecked: recon ? recon.checked : null,
      walletDriftCents: driftCents,
      walletMismatches: recon ? recon.mismatches.length : null,
      activeHolds: holds,
      stuckHolds: stuck,
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
      // 2026-10-19: what customers hold is a liability, not a float; the pay-out float is read live by /api/admin/floats.
      balancesCents: floatCents,
      walletsAbove20: today?.walletsAbove20 ?? null,
      today,
      takeRatePct: gmvCents > 0 ? Math.round((10000 * revenueCents) / gmvCents) / 100 : null,
      activeHolds: holds,
      walletCount: wallets?._count ?? null,
    },
    links,
    viral: viral ? { ...viral, payersCapturedNotYetOnWaPay: capturedPayers ?? null, shareOfAccountsPct: accounts ? Math.round((1000 * viral.accountsFromLinks) / accounts) / 10 : null } : null,
    funnel: {
      contacts: contactsAll != null ? contactsAll + (capturedPayers || 0) : null,
      contactsStarted: contactsAll,
      accounts,
      linked,
      funded,
      transacting,
      repeat,
      capturedPayers,
    },
    signupsBySource,
    cohorts,
    selling,
    ops,
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
