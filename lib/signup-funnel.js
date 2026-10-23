/**
 * The sign-up funnel (D, always on; docs/ONBOARDING.md §5, 2026-10-22). Per day
 * and for the whole window: accounts opened, finished sign-up, finished within
 * 10 minutes, a first payment link within 24 hours, a first link paid within 72
 * hours, a pay-out within 72 hours, each split by the path the account was
 * opened on (profile.onboarding.path: ONE_STEP | CLASSIC; an account older than
 * the stamp reads CLASSIC), with rates over the accounts opened. A day "had the
 * one-step switch on" when any account was opened ONE_STEP that day.
 *
 * Definitions, stated once:
 *   opened      the account row's createdAt; a payer pre-registered at a receipt
 *               (C, profile.origin.kind PAYER) opens when they first write
 *               (profile.onboarding.startedAt) and is not counted before that
 *   finished    onboardingState S5_COMPLETED; the moment is profile.onboarding.
 *               completedAt, else attribution.onboardedAt, else the first consent
 *   link        the account's first payment_requests row (createdAt)
 *   paid        the account's first PAID link (paidAt)
 *   pay-out     the account's first ott-payout request that reached the rail and
 *               did not fail (SUCCESS or PENDING), by its request time
 * Every window is measured from the moment the account opened, and a day whose
 * window has not closed yet is marked incomplete for that measure, so a young
 * day is never read as a bad one. The day is the UTC date.
 *
 * Aggregates only: no number, name or account id leaves this module.
 */
export const PATHS = Object.freeze(['ONE_STEP', 'CLASSIC']);
const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
export const WINDOWS = Object.freeze({ finished10m: 10 * MIN_MS, firstLink24h: 24 * HOUR_MS, firstPaid72h: 72 * HOUR_MS, genuinePaid72h: 72 * HOUR_MS, payout72h: 72 * HOUR_MS });
// genuinePaid72h (2026-10-23): the first link paid by SOMEONE ELSE (payer number given and not the
// account's own); firstPaid72h counts any paid link, which self-funded card payments inflate.
const MEASURES = ['finished', 'finished10m', 'firstLink24h', 'firstPaid72h', 'genuinePaid72h', 'payout72h'];
export const MAX_WINDOW_DAYS = 366;

const time = (v) => {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const asObject = (p) => (p && typeof p === 'object' ? p : {});

/** ONE_STEP or CLASSIC from the profile; anything else (older accounts included) is CLASSIC. Pure. */
export function accountPath(profile) {
  return asObject(profile).onboarding?.path === 'ONE_STEP' ? 'ONE_STEP' : 'CLASSIC';
}

/** When the account opened, in ms, or null (a pre-registered payer who never wrote). Pure. */
export function openedAtMs(account) {
  const p = asObject(account?.profile);
  if (p.origin?.kind === 'PAYER') return time(p.onboarding?.startedAt);
  return time(account?.createdAt);
}

/** When sign-up finished, in ms; null when not finished or the moment is unknown. Pure. */
export function finishedAtMs(account, firstConsentAt = null) {
  if (account?.onboardingState !== 'S5_COMPLETED') return null;
  const p = asObject(account?.profile);
  return time(p.onboarding?.completedAt) ?? time(p.attribution?.onboardedAt) ?? time(firstConsentAt);
}

function emptyCounts() {
  return { opened: 0, finished: 0, finished10m: 0, firstLink24h: 0, firstPaid72h: 0, genuinePaid72h: 0, payout72h: 0 };
}
const rate = (n, of) => (of > 0 ? Math.round((1000 * n) / of) / 10 : null);
function withRates(c) {
  return { ...c, rates: Object.fromEntries(MEASURES.map((m) => [m, rate(c[m], c.opened)])) };
}
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The funnel from per-account facts. Pure.
 * @param {object} a
 * @param {Array<{ id, createdAt, onboardingState, profile }>} a.accounts
 * @param {Record<string, Date|string>} [a.firstLinkAt]   by account id
 * @param {Record<string, Date|string>} [a.firstPaidAt]
 * @param {Record<string, Date|string>} [a.firstPayoutAt]
 * @param {Record<string, Date|string>} [a.firstConsentAt]
 * @param {Date|string} a.since  first day included (UTC midnight)
 * @param {Date|string} a.until  first day NOT included (UTC midnight)
 */
export function computeFunnel({ accounts = [], firstLinkAt = {}, firstPaidAt = {}, firstGenuinePaidAt = {}, firstPayoutAt = {}, firstConsentAt = {}, since, until, now = new Date() } = {}) {
  const from = time(since);
  const to = time(until);
  const nowMs = time(now) ?? Date.now();
  const days = new Map();
  for (let d = from; d < to; d += DAY_MS) {
    days.set(dayKey(d), { total: emptyCounts(), byPath: { ONE_STEP: emptyCounts(), CLASSIC: emptyCounts() } });
  }
  const within = (eventAt, openedAt, windowMs) => {
    const t = time(eventAt);
    return t != null && t - openedAt <= windowMs;
  };
  for (const acc of accounts) {
    const opened = openedAtMs(acc);
    if (opened == null || opened < from || opened >= to) continue;
    const row = days.get(dayKey(opened));
    if (!row) continue;
    const path = accountPath(acc.profile);
    const finished = acc.onboardingState === 'S5_COMPLETED';
    const finishedAt = finishedAtMs(acc, firstConsentAt[acc.id]);
    const facts = {
      opened: 1,
      finished: finished ? 1 : 0,
      finished10m: finished && finishedAt != null && finishedAt - opened <= WINDOWS.finished10m ? 1 : 0,
      firstLink24h: within(firstLinkAt[acc.id], opened, WINDOWS.firstLink24h) ? 1 : 0,
      firstPaid72h: within(firstPaidAt[acc.id], opened, WINDOWS.firstPaid72h) ? 1 : 0,
      genuinePaid72h: within(firstGenuinePaidAt[acc.id], opened, WINDOWS.genuinePaid72h) ? 1 : 0,
      payout72h: within(firstPayoutAt[acc.id], opened, WINDOWS.payout72h) ? 1 : 0,
    };
    for (const [k, v] of Object.entries(facts)) {
      row.total[k] += v;
      row.byPath[path][k] += v;
    }
  }
  const out = [];
  const summary = { total: emptyCounts(), byPath: { ONE_STEP: emptyCounts(), CLASSIC: emptyCounts() } };
  let oneStepDays = 0;
  for (const [date, row] of days) {
    const dayEnd = time(`${date}T00:00:00.000Z`) + DAY_MS;
    const oneStepOn = row.byPath.ONE_STEP.opened > 0;
    if (oneStepOn) oneStepDays += 1;
    for (const k of Object.keys(summary.total)) {
      summary.total[k] += row.total[k];
      for (const p of PATHS) summary.byPath[p][k] += row.byPath[p][k];
    }
    out.push({
      date,
      oneStepOn,
      complete: {
        finished10m: dayEnd + WINDOWS.finished10m <= nowMs,
        firstLink24h: dayEnd + WINDOWS.firstLink24h <= nowMs,
        firstPaid72h: dayEnd + WINDOWS.firstPaid72h <= nowMs,
        genuinePaid72h: dayEnd + WINDOWS.genuinePaid72h <= nowMs,
        payout72h: dayEnd + WINDOWS.payout72h <= nowMs,
      },
      total: withRates(row.total),
      byPath: { ONE_STEP: withRates(row.byPath.ONE_STEP), CLASSIC: withRates(row.byPath.CLASSIC) },
    });
  }
  return {
    since: new Date(from).toISOString().slice(0, 10),
    until: new Date(to).toISOString().slice(0, 10),
    days: out,
    summary: { oneStepDays, total: withRates(summary.total), byPath: { ONE_STEP: withRates(summary.byPath.ONE_STEP), CLASSIC: withRates(summary.byPath.CLASSIC) } },
  };
}

/**
 * The window from query strings: since and until as YYYY-MM-DD, both days
 * included (until defaults to today, since to 13 days before until). Pure.
 * @returns {{ ok: true, since: Date, until: Date } | { ok: false, error: string }}
 */
export function parseWindow({ since = null, until = null, now = new Date() } = {}) {
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (since != null && since !== '' && !ymd.test(String(since))) return { ok: false, error: 'BAD_SINCE' };
  if (until != null && until !== '' && !ymd.test(String(until))) return { ok: false, error: 'BAD_UNTIL' };
  const today = Date.parse(`${new Date(time(now) ?? Date.now()).toISOString().slice(0, 10)}T00:00:00.000Z`);
  const untilDay = until ? Date.parse(`${until}T00:00:00.000Z`) : today;
  const sinceDay = since ? Date.parse(`${since}T00:00:00.000Z`) : untilDay - 13 * DAY_MS;
  if (!Number.isFinite(untilDay) || !Number.isFinite(sinceDay)) return { ok: false, error: 'BAD_DATE' };
  if (sinceDay > untilDay) return { ok: false, error: 'SINCE_AFTER_UNTIL' };
  if ((untilDay - sinceDay) / DAY_MS + 1 > MAX_WINDOW_DAYS) return { ok: false, error: 'WINDOW_TOO_LONG' };
  return { ok: true, since: new Date(sinceDay), until: new Date(untilDay + DAY_MS) };
}

const chunks = (arr, n = 1000) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/**
 * Read the facts for a window and compute the funnel. Reads only: accounts
 * opened in the window (plus pre-registered payers, whose opening is the first
 * message), then each one's first link, first paid link, first pay-out and
 * first consent. Nothing is written. `since` inclusive, `until` exclusive.
 */
export async function loadFunnel({ prisma, since, until, now = new Date() }) {
  const accounts = await prisma.account.findMany({
    where: { OR: [{ createdAt: { gte: since, lt: until } }, { profile: { path: ['origin', 'kind'], equals: 'PAYER' } }] },
    select: { id: true, waId: true, createdAt: true, onboardingState: true, profile: true },
  });
  const inWindow = (accounts || []).filter((a) => {
    const t = openedAtMs(a);
    return t != null && t >= since.getTime() && t < until.getTime();
  });
  const firstLinkAt = {};
  const firstPaidAt = {};
  const firstGenuinePaidAt = {};
  const firstPayoutAt = {};
  const firstConsentAt = {};
  for (const ids of chunks(inWindow.map((a) => a.id))) {
    if (!ids.length) continue;
    const [links, paid, payouts, consents] = await Promise.all([
      prisma.paymentRequest.groupBy({ by: ['accountId'], where: { accountId: { in: ids } }, _min: { createdAt: true } }),
      prisma.paymentRequest.groupBy({ by: ['accountId'], where: { accountId: { in: ids }, status: 'PAID' }, _min: { paidAt: true } }),
      prisma.providerRequest.groupBy({ by: ['accountId'], where: { accountId: { in: ids }, route: 'ott-payout', status: { in: ['SUCCESS', 'PENDING'] } }, _min: { requestTs: true } }),
      prisma.consent.groupBy({ by: ['accountId'], where: { accountId: { in: ids }, granted: true }, _min: { grantedAt: true } }),
    ]);
    for (const r of links || []) firstLinkAt[r.accountId] = r._min?.createdAt || null;
    for (const r of paid || []) firstPaidAt[r.accountId] = r._min?.paidAt || null;
    for (const r of payouts || []) firstPayoutAt[r.accountId] = r._min?.requestTs || null;
    for (const r of consents || []) firstConsentAt[r.accountId] = r._min?.grantedAt || null;
    // The first GENUINE paid link: the payer's number (bound to the PayFast session, intent
    // pfreq-<code>) is known and is not the account's own; a balance payment from another account.
    if (typeof prisma.paymentRequest.findMany === 'function' && typeof prisma.providerRequest.findMany === 'function') {
      const paidRows = await prisma.paymentRequest.findMany({ where: { accountId: { in: ids }, status: 'PAID' }, select: { id: true, accountId: true, paidAt: true, payerRef: true } }).catch(() => []);
      const intents = paidRows.length ? await prisma.providerRequest.findMany({ where: { id: { in: paidRows.map((p) => `pfreq-${p.id}`) } }, select: { id: true, metadata: true } }).catch(() => []) : [];
      const payerOf = new Map((intents || []).map((i) => [String(i.id).replace(/^pfreq-/, ''), i.metadata?.payerMsisdn || null]));
      const own = new Map(inWindow.map((a) => [a.id, String(a.waId || '').replace(/\D/g, '').slice(-9)]));
      for (const p of paidRows || []) {
        const ref = String(p.payerRef || '');
        const genuine = ref.startsWith('WAPAY:') ? ref.slice(6) !== p.accountId
          : (() => { const n = String(payerOf.get(p.id) || '').replace(/\D/g, '').slice(-9); return n.length === 9 && n !== own.get(p.accountId); })();
        if (genuine && p.paidAt && (!firstGenuinePaidAt[p.accountId] || p.paidAt < firstGenuinePaidAt[p.accountId])) firstGenuinePaidAt[p.accountId] = p.paidAt;
      }
    }
  }
  return computeFunnel({ accounts: inWindow, firstLinkAt, firstPaidAt, firstGenuinePaidAt, firstPayoutAt, firstConsentAt, since, until, now });
}

/**
 * The nightly audit's line: yesterday's finished rate by path, e.g.
 * "Sign-up 2026-10-21: one-step 4 of 5 finished (80%); classic 12 of 20 finished (60%)." Pure.
 */
export function signupAuditLine(funnel) {
  const day = funnel?.days?.[funnel.days.length - 1];
  if (!day) return null;
  const part = (label, c) => (c.opened ? `${label} ${c.finished} of ${c.opened} finished (${c.rates.finished}%)` : `${label} none opened`);
  return `Sign-up ${day.date}: ${part('one-step', day.byPath.ONE_STEP)}; ${part('classic', day.byPath.CLASSIC)}.`;
}

/** Yesterday (UTC) for the nightly audit: the funnel of that one day, then its line. Best effort: null on any failure. */
export async function yesterdaySignupLine({ prisma, now = new Date() } = {}) {
  try {
    const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`);
    const funnel = await loadFunnel({ prisma, since: new Date(today - DAY_MS), until: new Date(today), now });
    return signupAuditLine(funnel);
  } catch (error) {
    console.error(JSON.stringify({ type: 'signup_funnel_line_error', error: String(error?.message || error).slice(0, 200) }));
    return null;
  }
}
