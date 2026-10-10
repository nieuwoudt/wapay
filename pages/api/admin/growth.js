/**
 * Mission Control — Growth (2026-10-10). The Scale Model's inputs, measured.
 *
 * One admin-gated JSON payload: the ad account's spend and started
 * conversations per day (from `ad_insights_daily`, snapshotted from Meta),
 * the funnel per acquisition source and per ad (accounts = onboarding
 * complete, never the row created at first contact), the loop's three parts,
 * monthly funded cohorts, message counts, and every Scale Model input with
 * its measured value, sample size and where it sits against the great /
 * plan / stop bounds. `scenarioUrl` opens the Scale Model artifact with the
 * measured inputs (sample of 20 or more) in place of the assumed ones.
 *
 * Aggregates only; no customer identifier leaves this route. Every block is
 * independently guarded so one failing query nulls its section.
 */

import prisma from '../../../lib/prisma.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { INPUTS, preset, boundStatus, measuredToInputs, scenarioUrl, SCALE_MODEL_URL } from '../../../lib/scale-model.js';
import { adsConfigured, snapshotAdInsights } from '../../../lib/meta-ads.js';
import { capiConfigured } from '../../../lib/meta-capi.js';

export const config = { maxDuration: 55 };

const RANGES = { '7': 7, '30': 30, '90': 90, all: 3650 };
const MIN_SAMPLE = 20;
const DAY_MS = 86400000;
const MSG_PRICE_RAND = 0.13;

async function safe(fn, fallback = null) {
  try {
    return await fn();
  } catch (error) {
    console.error(JSON.stringify({ type: 'admin_growth_block_error', error: error?.message }));
    return fallback;
  }
}
const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v || 0));
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const month = (d) => (d ? new Date(d).toISOString().slice(0, 7) : null);
const ratio = (a, b) => (b > 0 ? a / b : null);
const pct = (a, b) => (b > 0 ? Math.round((1000 * a) / b) / 10 : null);
const perCents = (cents, n) => (n > 0 ? Math.round(cents / n) : null);

function bucketOf(source) {
  if (!source) return 'other';
  if (source.startsWith('LOAD_')) return 'in';
  if (source.startsWith('SPEND_') || source.startsWith('VOUCHER_GIFT_')) return 'spend';
  if (source === 'P2P_SEND') return 'transfer';
  return 'other';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });

  const now = new Date();
  const days = RANGES[String(req.query.range || '30')] ?? 30;
  const since = new Date(now.getTime() - days * DAY_MS);
  const scale = 30 / Math.min(days, 365); // window → per-month

  // Optional refresh of the ad numbers (founder's button); at most every 10 minutes.
  let adsRefresh = null;
  if (String(req.query.refresh) === '1' && adsConfigured()) {
    const newest = await safe(() => prisma.adInsightDaily.findFirst({ orderBy: { fetchedAt: 'desc' }, select: { fetchedAt: true } }));
    if (!newest?.fetchedAt || now.getTime() - new Date(newest.fetchedAt).getTime() > 10 * 60 * 1000) {
      adsRefresh = await safe(() => snapshotAdInsights({ prisma, days: 3, now }), { errors: ['refresh failed'] });
    } else {
      adsRefresh = { skipped: 'RECENT' };
    }
  }

  // ---- per-account facts (one bounded query; aggregated here, never returned) ----
  const accounts = await safe(
    () => prisma.$queryRaw`
      SELECT a.id,
             a."createdAt" AS first_contact,
             (a."onboardingState" = 'S5_COMPLETED') AS onboarded,
             coalesce(a."profile"->>'acquisitionSource', 'organic') AS src,
             a."profile"->'attribution'->>'adId' AS ad_id,
             a."profile"->'attribution'->>'referrerAccountId' AS referrer,
             (a."profile"->'attribution'->>'ctwaClid') IS NOT NULL AS attributed,
             (a."profile"->'attribution'->'capi'->>'lead') IS NOT NULL AS capi_lead,
             (a."profile"->'attribution'->'capi'->>'purchase') IS NOT NULL AS capi_purchase,
             c.onboarded_at, l.first_link_at, l.links_total, l.first_paid_at, f.first_funded_at, m.last_money_at
      FROM "Account" a
      LEFT JOIN (SELECT "accountId", min("grantedAt") AS onboarded_at FROM consents GROUP BY 1) c ON c."accountId" = a.id
      LEFT JOIN (SELECT "accountId", min("createdAt") AS first_link_at, count(*)::int AS links_total,
                        min(CASE WHEN status = 'PAID' THEN "paidAt" END) AS first_paid_at
                 FROM payment_requests GROUP BY 1) l ON l."accountId" = a.id
      LEFT JOIN (SELECT split_part(jl."accountCode", ':', 2) AS account_id, min(je."createdAt") AS first_funded_at
                 FROM "JournalLine" jl JOIN "JournalEntry" je ON je.id = jl."entryId"
                 WHERE jl."accountCode" LIKE 'WALLET:%' AND jl."creditCents" > 0 GROUP BY 1) f ON f.account_id = a.id
      LEFT JOIN (SELECT split_part(jl."accountCode", ':', 2) AS account_id, max(je."createdAt") AS last_money_at
                 FROM "JournalLine" jl JOIN "JournalEntry" je ON je.id = jl."entryId"
                 WHERE jl."accountCode" LIKE 'WALLET:%' GROUP BY 1) m ON m.account_id = a.id
      LIMIT 200000`,
    []
  );
  const rows = (accounts || []).map((r) => ({
    id: r.id,
    firstContact: r.first_contact ? new Date(r.first_contact) : null,
    onboarded: Boolean(r.onboarded),
    src: r.src || 'organic',
    adId: r.ad_id || null,
    referrer: r.referrer || null,
    attributed: Boolean(r.attributed),
    capiLead: Boolean(r.capi_lead),
    capiPurchase: Boolean(r.capi_purchase),
    onboardedAt: r.onboarded_at ? new Date(r.onboarded_at) : null,
    firstLinkAt: r.first_link_at ? new Date(r.first_link_at) : null,
    linksTotal: num(r.links_total),
    firstPaidAt: r.first_paid_at ? new Date(r.first_paid_at) : null,
    firstFundedAt: r.first_funded_at ? new Date(r.first_funded_at) : null,
    lastMoneyAt: r.last_money_at ? new Date(r.last_money_at) : null,
  }));
  const thirtyAgo = new Date(now.getTime() - 30 * DAY_MS);
  const isActive30 = (a) => Boolean(a.lastMoneyAt && a.lastMoneyAt > thirtyAgo);
  const inWindow = (d) => Boolean(d && d > since);

  // ---- window aggregates from the journal ----
  const moneyEvents = await safe(
    () => prisma.$queryRaw`
      SELECT split_part(jl."accountCode", ':', 2) AS account_id, count(DISTINCT je.id)::int AS events
      FROM "JournalLine" jl JOIN "JournalEntry" je ON je.id = jl."entryId"
      WHERE jl."accountCode" LIKE 'WALLET:%' AND je."createdAt" > ${since}
      GROUP BY 1`,
    []
  );
  const activeInWindow = new Set((moneyEvents || []).map((r) => r.account_id));
  const eventsInWindow = (moneyEvents || []).reduce((s, r) => s + num(r.events), 0);
  const mau = rows.filter(isActive30).length;

  const revenueCents = await safe(async () => {
    const r = await prisma.$queryRaw`
      SELECT (sum(coalesce(jl."creditCents", 0)) - sum(coalesce(jl."debitCents", 0)))::bigint AS net
      FROM "JournalLine" jl JOIN "JournalEntry" je ON je.id = jl."entryId"
      WHERE jl."accountCode" LIKE 'REVENUE:%' AND je."createdAt" > ${since}`;
    return num(r?.[0]?.net);
  }, 0);
  const gmvCents = await safe(async () => {
    const r = await prisma.$queryRaw`
      SELECT je.source AS source, sum(coalesce(jl."creditCents", 0))::bigint AS credit, sum(coalesce(jl."debitCents", 0))::bigint AS debit
      FROM "JournalEntry" je JOIN "JournalLine" jl ON jl."entryId" = je.id AND jl."accountCode" LIKE 'WALLET:%'
      WHERE je."createdAt" > ${since} GROUP BY 1`;
    let total = 0;
    for (const x of r || []) {
      let source = x.source, sign = 1;
      if (source && source.startsWith('REVERSAL_')) { source = source.slice(9); sign = -1; }
      const b = bucketOf(source);
      if (b === 'in') total += sign * num(x.credit);
      else if (b === 'spend' || b === 'transfer') total += sign * num(x.debit);
    }
    return total;
  }, 0);
  const balanceCents = await safe(async () => {
    const ids = rows.filter(isActive30).map((a) => a.id);
    if (!ids.length) return 0;
    const agg = await prisma.wallet.aggregate({ _sum: { availableCents: true }, where: { accountId: { in: ids.slice(0, 20000) } } });
    return num(agg?._sum?.availableCents);
  }, 0);
  const assistantTurns = await safe(() => prisma.conversationTurn.count({ where: { role: 'assistant', createdAt: { gt: since } } }), null);
  const links = await safe(async () => {
    const r = await prisma.$queryRaw`
      SELECT count(*)::int AS created,
             count(*) FILTER (WHERE status = 'PAID')::int AS paid,
             count(DISTINCT "payerRef") FILTER (WHERE status = 'PAID')::int AS payers
      FROM payment_requests WHERE "createdAt" > ${since}`;
    return { created: num(r?.[0]?.created), paid: num(r?.[0]?.paid), payers: num(r?.[0]?.payers) };
  }, { created: 0, paid: 0, payers: 0 });
  const capturedPayers = await safe(async () => {
    const r = await prisma.$queryRaw`
      SELECT count(DISTINCT pr."metadata"->>'payerMsisdn')::int AS n
      FROM "ProviderRequest" pr
      WHERE pr.provider IN ('PAYFAST', 'ADUMO') AND pr."metadata"->>'payerMsisdn' IS NOT NULL`;
    return num(r?.[0]?.n);
  }, 0);

  // ---- monthly cohorts (funded month × months since, share with a money event) ----
  const monthly = await safe(
    () => prisma.$queryRaw`
      SELECT split_part(jl."accountCode", ':', 2) AS account_id, to_char(date_trunc('month', je."createdAt"), 'YYYY-MM') AS mon
      FROM "JournalLine" jl JOIN "JournalEntry" je ON je.id = jl."entryId"
      WHERE jl."accountCode" LIKE 'WALLET:%' AND je."createdAt" > now() - interval '13 months'
      GROUP BY 1, 2`,
    []
  );
  const activeMonths = new Map();
  for (const r of monthly || []) {
    if (!activeMonths.has(r.account_id)) activeMonths.set(r.account_id, new Set());
    activeMonths.get(r.account_id).add(r.mon);
  }
  const addMonths = (ym, k) => {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + k, 1));
    return d.toISOString().slice(0, 7);
  };
  const cohortMap = new Map();
  for (const a of rows) {
    if (!a.firstFundedAt) continue;
    const c = month(a.firstFundedAt);
    if (!cohortMap.has(c)) cohortMap.set(c, { month: c, size: 0, ages: [0, 0, 0, 0, 0, 0, 0] });
    const row = cohortMap.get(c);
    row.size += 1;
    const months = activeMonths.get(a.id) || new Set();
    for (let k = 1; k <= 6; k++) if (months.has(addMonths(c, k))) row.ages[k] += 1;
  }
  const thisMonth = month(now);
  const cohorts = [...cohortMap.values()].sort((x, y) => (x.month < y.month ? -1 : 1)).slice(-12).map((c) => {
    const elapsed = (Number(thisMonth.slice(0, 4)) - Number(c.month.slice(0, 4))) * 12 + (Number(thisMonth.slice(5)) - Number(c.month.slice(5)));
    const at = (k) => (elapsed > k && c.size > 0 ? Math.round((100 * c.ages[k]) / c.size) : null);
    return { month: c.month, size: c.size, m1: at(1), m2: at(2), m3: at(3), m6: at(6) };
  });
  const matured = (k) => cohorts.filter((c) => c[`m${k}`] !== null);
  const weighted = (k) => {
    const cs = matured(k);
    const n = cs.reduce((s, c) => s + c.size, 0);
    return { value: n > 0 ? cs.reduce((s, c) => s + (c[`m${k}`] * c.size) / 100, 0) / n * 100 : null, n };
  };

  // ---- ads: window totals per ad and per day ----
  const adsWindow = await safe(
    () => prisma.$queryRaw`
      SELECT "adId", max("adName") AS ad_name, max("campaignName") AS campaign_name,
             sum("spendCents")::bigint AS spend, sum(impressions)::bigint AS impressions, sum(clicks)::bigint AS clicks,
             sum(conversations)::bigint AS conversations, sum(connections)::bigint AS connections
      FROM ad_insights_daily WHERE date >= ${day(since)}::date GROUP BY 1 ORDER BY 3 DESC`,
    []
  );
  const adsDaily = await safe(
    () => prisma.$queryRaw`
      SELECT to_char(date, 'YYYY-MM-DD') AS d, sum("spendCents")::bigint AS spend, sum(impressions)::bigint AS impressions,
             sum(clicks)::bigint AS clicks, sum(conversations)::bigint AS conversations
      FROM ad_insights_daily WHERE date >= ${day(since)}::date GROUP BY 1 ORDER BY 1`,
    []
  );
  const adsLast = await safe(() => prisma.adInsightDaily.findFirst({ orderBy: { fetchedAt: 'desc' }, select: { fetchedAt: true } }));
  const catalog = await safe(() => prisma.adCatalog.findMany({ take: 500 }), []);
  const catalogById = new Map((catalog || []).map((c) => [c.adId, c]));
  const spendCents = (adsWindow || []).reduce((s, r) => s + num(r.spend), 0);
  const conversations = (adsWindow || []).reduce((s, r) => s + num(r.conversations), 0);

  // ---- funnel by source + per ad ----
  const sources = ['organic', 'paylink', 'ad', 'partner'];
  const funnelBySource = sources.map((src) => {
    const rs = rows.filter((a) => a.src === src);
    const onboarded = rs.filter((a) => a.onboarded);
    return {
      src,
      contacts: rs.length,
      onboarded: onboarded.length,
      activated: onboarded.filter((a) => a.firstLinkAt).length,
      funded: onboarded.filter((a) => a.firstFundedAt).length,
      active30: onboarded.filter(isActive30).length,
      newInWindow: rs.filter((a) => inWindow(a.onboardedAt)).length,
    };
  }).filter((f) => f.contacts > 0 || f.src !== 'partner');
  const adRows = rows.filter((a) => a.src === 'ad');
  const adOnboardedW = adRows.filter((a) => a.onboarded && inWindow(a.onboardedAt)).length;
  const adFundedW = adRows.filter((a) => a.onboarded && inWindow(a.firstFundedAt)).length;
  const ads = (adsWindow || []).map((r) => {
    const cat = catalogById.get(r.adId);
    const mine = adRows.filter((a) => a.adId === r.adId);
    const onboarded = mine.filter((a) => a.onboarded && inWindow(a.onboardedAt)).length;
    const funded = mine.filter((a) => a.onboarded && inWindow(a.firstFundedAt)).length;
    const spend = num(r.spend), conv = num(r.conversations);
    return {
      adId: r.adId,
      name: cat?.name || r.ad_name || r.adId,
      campaign: cat?.campaignName || r.campaign_name || null,
      headline: cat?.headline || null,
      status: cat?.status || null,
      spendCents: spend,
      impressions: num(r.impressions),
      clicks: num(r.clicks),
      conversations: conv,
      connections: num(r.connections),
      contacts: mine.length,
      onboarded,
      funded,
      costPerConversationCents: perCents(spend, conv),
      costPerAccountCents: perCents(spend, onboarded),
      costPerFundedCents: perCents(spend, funded),
      convToAccountPct: pct(onboarded, conv),
    };
  });

  // ---- daily series: Meta columns + our funnel columns ----
  const dayMap = new Map();
  const dayRow = (d) => {
    if (!dayMap.has(d)) dayMap.set(d, { date: d, spendCents: 0, impressions: 0, clicks: 0, conversations: 0, contacts: 0, onboarded: 0, funded: 0, adOnboarded: 0 });
    return dayMap.get(d);
  };
  for (const r of adsDaily || []) {
    const x = dayRow(r.d);
    x.spendCents += num(r.spend); x.impressions += num(r.impressions); x.clicks += num(r.clicks); x.conversations += num(r.conversations);
  }
  for (const a of rows) {
    if (inWindow(a.firstContact)) dayRow(day(a.firstContact)).contacts += 1;
    if (inWindow(a.onboardedAt)) { dayRow(day(a.onboardedAt)).onboarded += 1; if (a.src === 'ad') dayRow(day(a.onboardedAt)).adOnboarded += 1; }
    if (inWindow(a.firstFundedAt)) dayRow(day(a.firstFundedAt)).funded += 1;
  }
  const daily = [...dayMap.values()].sort((x, y) => (x.date < y.date ? -1 : 1)).slice(-Math.min(days, 120));

  // ---- the loop ----
  const adSet = new Set(adRows.map((a) => a.id));
  const level1 = rows.filter((a) => a.referrer && adSet.has(a.referrer));
  const level1Set = new Set(level1.map((a) => a.id));
  const level2 = rows.filter((a) => a.referrer && level1Set.has(a.referrer));
  const paylinkAccounts = rows.filter((a) => a.src === 'paylink' && a.onboarded).length;
  const loop = {
    linksCreated: links.created,
    paidLinks: links.paid,
    payers: links.payers,
    capturedPayers,
    paylinkAccounts,
    linksPerActive: mau > 0 ? (links.created * scale) / mau : null,
    payersPerLink: links.created > 0 ? links.payers / links.created : null,
    payerToOnbPct: pct(paylinkAccounts, capturedPayers),
    adAcquired: adRows.filter((a) => a.onboarded).length,
    downstream1: level1.length,
    downstream2: level2.length,
    treeFactor: adRows.length > 0 ? (level1.length + level2.length) / adRows.filter((a) => a.onboarded).length || null : null,
  };
  loop.K = loop.linksPerActive != null && loop.payersPerLink != null && loop.payerToOnbPct != null
    ? loop.linksPerActive * loop.payersPerLink * (loop.payerToOnbPct / 100) : null;

  // ---- measured Scale Model inputs ----
  // Funnel hops use a MATURE cohort: onboarded 14 to 44 days ago, so each
  // person had two weeks to act before being judged.
  const matureFrom = new Date(now.getTime() - 44 * DAY_MS), matureTo = new Date(now.getTime() - 14 * DAY_MS);
  const mature = rows.filter((a) => a.onboarded && a.onboardedAt && a.onboardedAt > matureFrom && a.onboardedAt < matureTo);
  const matureAct = mature.filter((a) => a.firstLinkAt);
  const matureNoAct = mature.filter((a) => !a.firstLinkAt);
  const m1 = weighted(1), m3 = weighted(3);
  const measuredRaw = {
    cpConv: { value: conversations > 0 ? spendCents / 100 / conversations : null, n: conversations },
    convToOnb: { value: conversations > 0 ? (100 * adOnboardedW) / conversations : null, n: conversations },
    onbToAct: { value: mature.length > 0 ? (100 * matureAct.length) / mature.length : null, n: mature.length },
    actToFund: { value: matureAct.length > 0 ? (100 * matureAct.filter((a) => a.firstFundedAt).length) / matureAct.length : null, n: matureAct.length },
    selfLoad: { value: matureNoAct.length > 0 ? (100 * matureNoAct.filter((a) => a.firstFundedAt).length) / matureNoAct.length : null, n: matureNoAct.length },
    linksPerActive: { value: loop.linksPerActive, n: mau },
    payersPerLink: { value: loop.payersPerLink, n: links.created },
    payerToOnb: { value: loop.payerToOnbPct, n: capturedPayers },
    m1Active: { value: m1.value, n: m1.n },
    m3Ret: { value: m3.value, n: m3.n },
    arpu: { value: mau > 0 ? ((revenueCents / 100) * scale) / mau : null, n: mau },
    gmvPerActive: { value: mau > 0 ? ((gmvCents / 100) * scale) / mau : null, n: mau },
    repliesPerEvent: { value: assistantTurns != null && eventsInWindow > 0 ? assistantTurns / eventsInWindow : null, n: eventsInWindow },
    eventsPerActive: { value: mau > 0 ? (eventsInWindow * scale) / mau : null, n: mau },
    avgBalance: { value: mau > 0 ? balanceCents / 100 / mau : null, n: mau },
    msgPrice: { value: MSG_PRICE_RAND, n: MIN_SAMPLE },
  };
  const plan = preset('plan');
  const measured = {};
  for (const i of INPUTS) {
    const m = measuredRaw[i.k];
    measured[i.k] = {
      key: i.k, label: i.l, unit: i.u, group: i.g,
      plan: i.plan, great: i.great, stop: i.stop, lowerIsBetter: Boolean(i.lowerIsBetter),
      value: m && m.value != null && isFinite(m.value) ? Math.round(m.value * 100) / 100 : null,
      n: m ? m.n : 0,
      measurable: Boolean(m),
      status: m && (m.n ?? 0) >= MIN_SAMPLE ? boundStatus(i, m.value) : 'unknown',
      used: Boolean(m && m.value != null && isFinite(m.value) && (m.n ?? 0) >= MIN_SAMPLE),
    };
  }
  const inputs = measuredToInputs(measuredRaw, { minN: MIN_SAMPLE });
  const scenario = scenarioUrl({ inputs }, process.env.WAPAY_SCALE_MODEL_URL || SCALE_MODEL_URL);

  res.setHeader('Cache-Control', 'private, max-age=60');
  return res.status(200).json({
    generatedAt: now.toISOString(),
    rangeDays: days,
    minSample: MIN_SAMPLE,
    status: {
      attribution: true,
      adsConfigured: adsConfigured(),
      capiConfigured: capiConfigured(),
      adsLastFetchedAt: adsLast?.fetchedAt || null,
      adsRefresh,
      attributedAccounts: rows.filter((a) => a.attributed).length,
      capiLeadSent: rows.filter((a) => a.capiLead).length,
      capiPurchaseSent: rows.filter((a) => a.capiPurchase).length,
    },
    kpis: {
      spendCents,
      conversations,
      costPerConversationCents: perCents(spendCents, conversations),
      adContacts: adRows.filter((a) => inWindow(a.firstContact)).length,
      adOnboarded: adOnboardedW,
      costPerAccountCents: perCents(spendCents, adOnboardedW),
      adFunded: adFundedW,
      costPerFundedCents: perCents(spendCents, adFundedW),
      convToAccountPct: pct(adOnboardedW, conversations),
      accountsTotal: rows.filter((a) => a.onboarded).length,
      contactsTotal: rows.length,
      mau,
      activeInWindow: activeInWindow.size,
      revenueCents,
      gmvCents,
    },
    funnelBySource,
    ads,
    daily,
    cohorts,
    loop,
    messages: {
      assistantTurns,
      perActive: assistantTurns != null && mau > 0 ? Math.round((assistantTurns * scale) / mau * 10) / 10 : null,
      perEvent: measured.repliesPerEvent.value,
      costPerActiveCents: assistantTurns != null && mau > 0 ? Math.round(((assistantTurns * scale) / mau) * MSG_PRICE_RAND * 100) : null,
    },
    measured,
    inputs,
    plan,
    scenarioUrl: scenario,
  });
}
