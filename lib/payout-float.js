/**
 * The OTT pay-out float, read the way the floats panel reads it, with a short
 * in-process cache so an alert or a dashboard tile never hammers the rail.
 * Aggregates only. Never throws: an unreadable float is { balanceCents: null, error }.
 */
import prisma from './prisma.js';
import { OttPayoutClient, payoutAmountToCents } from './ott-payout.js';
import { payoutConfigured } from './payouts.js';

const CACHE_MS = 60_000;
let cache = { at: 0, value: null };

export function floatWarnCents(env = process.env) {
  const per = Number(env.WAPAY_FLOAT_WARN_CENTS_OTT_PAYOUT);
  if (Number.isFinite(per) && per > 0) return Math.round(per);
  const global = Number(env.WAPAY_FLOAT_WARN_CENTS);
  if (Number.isFinite(global) && global > 0) return Math.round(global);
  return 150000; // R1,500: the level agreed on launch day (2026-10-18)
}

/** { configured, balanceCents|null, error|null, at } */
export async function readPayoutFloat({ timeoutMs = 6000, now = Date.now(), fetchBalance = null } = {}) {
  if (cache.value && now - cache.at < CACHE_MS) return cache.value;
  let value;
  if (!payoutConfigured()) value = { configured: false, balanceCents: null, error: 'NOT_CONFIGURED', at: new Date(now).toISOString() };
  else {
    try {
      const body = fetchBalance
        ? await fetchBalance()
        : await new OttPayoutClient({ timeoutMs }).getBalance({ yourUniqueReference: `flt${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}` });
      const raw = body?.balance ?? body?.availableBalance ?? body?.available_balance ?? body?.Balance;
      const balanceCents = raw != null ? payoutAmountToCents(raw) : null;
      value = balanceCents == null
        ? { configured: true, balanceCents: null, error: 'REJECTED', at: new Date(now).toISOString() }
        : { configured: true, balanceCents, error: null, at: new Date(now).toISOString() };
    } catch (error) {
      value = { configured: true, balanceCents: null, error: String(error?.code || error?.message || 'ERROR').slice(0, 60), at: new Date(now).toISOString() };
    }
  }
  cache = { at: now, value };
  return value;
}

/** Start of today in South Africa, as a Date. */
export function sastDayStart(now = new Date()) {
  const shifted = new Date(now.getTime() + 2 * 3600_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 2 * 3600_000);
}

/**
 * Where the money stands: what customers hold, what the float holds, how
 * many days the float covers at the trailing week's pay-out pace.
 */
export async function floatPosition({ prisma: db = prisma, now = new Date(), fetchBalance = null } = {}) {
  const [agg, above, payouts7d, payoutsToday, openLinks] = await Promise.all([
    db.wallet.aggregate({ where: { balanceType: 'SPEND' }, _sum: { availableCents: true }, _count: true }).catch(() => null),
    db.wallet.count({ where: { balanceType: 'SPEND', availableCents: { gte: 2000 } } }).catch(() => null),
    db.$queryRaw`SELECT count(*)::int AS n, coalesce(sum((metadata->>'amountCents')::int), 0)::int AS cents FROM "ProviderRequest"
                 WHERE route = 'ott-payout' AND status = 'SUCCESS' AND "requestTs" > now() - interval '7 days'`.then((r) => r?.[0]).catch(() => null),
    db.$queryRaw`SELECT count(*)::int AS n, coalesce(sum((metadata->>'amountCents')::int), 0)::int AS cents FROM "ProviderRequest"
                 WHERE route = 'ott-payout' AND status = 'SUCCESS' AND "requestTs" >= ${sastDayStart(now)}`.then((r) => r?.[0]).catch(() => null),
    db.paymentRequest.aggregate({ where: { status: 'PENDING' }, _sum: { amountCents: true }, _count: true }).catch(() => null),
  ]);
  const fl = await readPayoutFloat({ now: now.getTime(), fetchBalance });
  const balancesCents = agg?._sum?.availableCents || 0;
  const warnCents = floatWarnCents();
  const perDay = payouts7d ? Number(payouts7d.cents || 0) / 7 : 0;
  return {
    balancesCents,
    wallets: agg?._count ?? null,
    walletsAbove20: above,
    floatCents: fl.balanceCents,
    floatError: fl.error,
    floatConfigured: fl.configured,
    warnCents,
    coverX: fl.balanceCents != null && balancesCents > 0 ? Math.round((10 * fl.balanceCents) / balancesCents) / 10 : null,
    daysOfCover: fl.balanceCents != null && perDay > 0 ? Math.round((10 * fl.balanceCents) / perDay) / 10 : null,
    payouts7d: payouts7d ? { n: Number(payouts7d.n || 0), cents: Number(payouts7d.cents || 0) } : null,
    payoutsToday: payoutsToday ? { n: Number(payoutsToday.n || 0), cents: Number(payoutsToday.cents || 0) } : null,
    openLinks: openLinks ? { n: openLinks._count || 0, cents: openLinks._sum?.amountCents || 0 } : null,
    low: fl.balanceCents != null ? fl.balanceCents < warnCents : null,
  };
}
