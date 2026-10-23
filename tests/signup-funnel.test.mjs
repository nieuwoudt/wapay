/**
 * D. The sign-up funnel (always on, 2026-10-22; lib/signup-funnel.js,
 * GET /api/internal/funnel, the Growth tab's "Sign-up funnel" card, the nightly
 * audit's line).
 *
 * Locks: the maths on fixture data (per day, per path, the summary, the
 * windows, the young-day marks), the definitions (an older account is CLASSIC; a
 * pre-registered payer opens when they write and not before), the query window,
 * aggregates only, and the wiring of the routes, the card and the audit line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { computeFunnel, loadFunnel, parseWindow, signupAuditLine, yesterdaySignupLine, accountPath, openedAtMs, finishedAtMs, WINDOWS } from '../lib/signup-funnel.js';
import { opsSummary } from '../lib/audit/run.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const H = 3600 * 1000;
const at = (iso, plusMs = 0) => new Date(Date.parse(iso) + plusMs);

// Two days, both paths. Day 1 (2026-10-20) is classic only; day 2 (2026-10-21) has both.
const D1 = '2026-10-20T08:00:00.000Z';
const D2 = '2026-10-21T08:00:00.000Z';
const ACCOUNTS = [
  // day 1, classic: finished in 30 min (not within 10), a link at 2 h, paid at 30 h, a pay-out at 80 h (outside 72)
  { id: 'c1', createdAt: at(D1), onboardingState: 'S5_COMPLETED', profile: { onboarding: { path: 'CLASSIC' }, attribution: { onboardedAt: at(D1, 0.5 * H).toISOString() } } },
  // day 1, classic, an account older than the stamp (no profile at all): stopped at the PIN step
  { id: 'c2', createdAt: at(D1, 2 * H), onboardingState: 'S3_OTP_VERIFIED', profile: null },
  // day 2, classic: finished in 5 min by its consent row (no stamps)
  { id: 'c3', createdAt: at(D2), onboardingState: 'S5_COMPLETED', profile: {} },
  // day 2, one-step: finished at once, a link at 1 h, paid at 10 h, a pay-out at 20 h
  { id: 'o1', createdAt: at(D2, H), onboardingState: 'S5_COMPLETED', profile: { onboarding: { path: 'ONE_STEP', startedAt: at(D2, H).toISOString(), completedAt: at(D2, H + 2000).toISOString() } } },
  // day 2, one-step: finished, the moment unknown (counts as finished, not within 10 min); a link at 30 h (outside 24)
  { id: 'o2', createdAt: at(D2, 2 * H), onboardingState: 'S5_COMPLETED', profile: { onboarding: { path: 'ONE_STEP' } } },
  // a payer pre-registered on day 1 who wrote on day 2: opens on day 2, one-step
  { id: 'p1', createdAt: at(D1, 3 * H), onboardingState: 'S5_COMPLETED', profile: { origin: { kind: 'PAYER', requestCode: 'PRKWXQZM' }, onboarding: { path: 'ONE_STEP', startedAt: at(D2, 5 * H).toISOString(), completedAt: at(D2, 5 * H + 1000).toISOString() } } },
  // a payer pre-registered who never wrote: opened nothing
  { id: 'p2', createdAt: at(D1, 4 * H), onboardingState: 'S0_INITIAL', profile: { origin: { kind: 'PAYER', requestCode: 'PRMDCUQA' } } },
  // outside the window
  { id: 'x1', createdAt: at('2026-10-19T08:00:00.000Z'), onboardingState: 'S5_COMPLETED', profile: {} },
];
const FACTS = {
  firstLinkAt: { c1: at(D1, 2 * H), o1: at(D2, 2 * H), o2: at(D2, 32 * H) },
  firstPaidAt: { c1: at(D1, 30 * H), o1: at(D2, 11 * H) },
  firstPayoutAt: { c1: at(D1, 80 * H), o1: at(D2, 21 * H) },
  firstConsentAt: { c3: at(D2, 5 * 60 * 1000), c1: at(D1, 0.5 * H) },
};
const WINDOW = { since: new Date('2026-10-20T00:00:00.000Z'), until: new Date('2026-10-22T00:00:00.000Z') };

test('the definitions: CLASSIC unless stamped ONE_STEP; a pre-registered payer opens when they write; the finish moment by precedence', () => {
  assert.equal(accountPath(null), 'CLASSIC');
  assert.equal(accountPath({ onboarding: { path: 'ONE_STEP' } }), 'ONE_STEP');
  assert.equal(accountPath({ onboarding: { path: 'weird' } }), 'CLASSIC');
  assert.equal(openedAtMs(ACCOUNTS[5]), Date.parse(at(D2, 5 * H)));
  assert.equal(openedAtMs(ACCOUNTS[6]), null);
  assert.equal(finishedAtMs(ACCOUNTS[1]), null, 'not finished');
  assert.equal(finishedAtMs(ACCOUNTS[0]), Date.parse(at(D1, 0.5 * H)));
  assert.equal(finishedAtMs(ACCOUNTS[2], FACTS.firstConsentAt.c3), Date.parse(FACTS.firstConsentAt.c3));
  assert.equal(finishedAtMs(ACCOUNTS[4]), null, 'finished, moment unknown');
  assert.equal(WINDOWS.finished10m, 10 * 60 * 1000);
});

test('the funnel on fixture data: per day, per path, the rates and the summary', () => {
  const f = computeFunnel({ accounts: ACCOUNTS, ...FACTS, ...WINDOW, now: new Date('2026-10-28T00:00:00.000Z') });
  assert.equal(f.since, '2026-10-20');
  assert.equal(f.until, '2026-10-22');
  assert.deepEqual(f.days.map((d) => d.date), ['2026-10-20', '2026-10-21']);
  const [d1, d2] = f.days;
  assert.equal(d1.oneStepOn, false);
  assert.equal(d2.oneStepOn, true);
  const pick = (c) => [c.opened, c.finished, c.finished10m, c.firstLink24h, c.firstPaid72h, c.payout72h];
  assert.deepEqual(pick(d1.byPath.CLASSIC), [2, 1, 0, 1, 1, 0], 'c1 + c2; the pay-out at 80 h is outside 72 h');
  assert.deepEqual(pick(d1.byPath.ONE_STEP), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(pick(d2.byPath.CLASSIC), [1, 1, 1, 0, 0, 0], 'c3 finished in 5 min by its consent');
  assert.deepEqual(pick(d2.byPath.ONE_STEP), [3, 3, 2, 1, 1, 1], 'o1, o2, p1; o2 has no finish moment and a late link');
  assert.deepEqual(pick(d2.total), [4, 4, 3, 1, 1, 1]);
  assert.deepEqual(d1.byPath.CLASSIC.rates, { finished: 50, finished10m: 0, firstLink24h: 50, firstPaid72h: 50, genuinePaid72h: 0, payout72h: 0 });
  assert.deepEqual(d2.byPath.ONE_STEP.rates, { finished: 100, finished10m: 66.7, firstLink24h: 33.3, firstPaid72h: 33.3, genuinePaid72h: 0, payout72h: 33.3 });
  assert.deepEqual(d1.byPath.ONE_STEP.rates, { finished: null, finished10m: null, firstLink24h: null, firstPaid72h: null, genuinePaid72h: null, payout72h: null }, 'nothing opened: no rate, never 0%');
  assert.deepEqual(pick(f.summary.byPath.CLASSIC), [3, 2, 1, 1, 1, 0]);
  assert.deepEqual(pick(f.summary.byPath.ONE_STEP), [3, 3, 2, 1, 1, 1]);
  assert.deepEqual(pick(f.summary.total), [6, 5, 3, 2, 2, 1]);
  assert.equal(f.summary.oneStepDays, 1);
  assert.equal(f.summary.total.rates.finished, 83.3);
  const json = JSON.stringify(f);
  for (const id of ['c1', 'c2', 'c3', 'o1', 'o2', 'p1', 'p2', 'PRKWXQZM']) assert.ok(!json.includes(`"${id}"`), `no identifier leaves: ${id}`);
});

test('a young day is marked, so it is never read as a bad one', () => {
  const f = computeFunnel({ accounts: ACCOUNTS, ...FACTS, ...WINDOW, now: new Date('2026-10-22T12:00:00.000Z') });
  const d2 = f.days[1];
  assert.deepEqual(d2.complete, { finished10m: true, firstLink24h: false, firstPaid72h: false, genuinePaid72h: false, payout72h: false });
  assert.deepEqual(f.days[0].complete, { finished10m: true, firstLink24h: true, firstPaid72h: false, genuinePaid72h: false, payout72h: false });
});

test('the window: YYYY-MM-DD, both days included, 14 days by default, a year at most', () => {
  const now = new Date('2026-10-22T15:00:00.000Z');
  const d = parseWindow({ now });
  assert.equal(d.since.toISOString(), '2026-10-09T00:00:00.000Z');
  assert.equal(d.until.toISOString(), '2026-10-23T00:00:00.000Z', 'today included');
  const w = parseWindow({ since: '2026-10-18', until: '2026-10-21', now });
  assert.deepEqual([w.since.toISOString(), w.until.toISOString()], ['2026-10-18T00:00:00.000Z', '2026-10-22T00:00:00.000Z']);
  assert.equal(parseWindow({ since: '18 Oct', now }).error, 'BAD_SINCE');
  assert.equal(parseWindow({ until: '2026/10/21', now }).error, 'BAD_UNTIL');
  assert.equal(parseWindow({ since: '2026-10-21', until: '2026-10-18', now }).error, 'SINCE_AFTER_UNTIL');
  assert.equal(parseWindow({ since: '2024-01-01', until: '2026-10-21', now }).error, 'WINDOW_TOO_LONG');
  assert.equal(parseWindow({ since: '2026-02-30', now }).ok, true, 'a calendar slip is read as JavaScript reads it, never a crash');
});

function funnelDb(accounts, facts) {
  const reads = [];
  const groupBy = (map, field) => async ({ where }) => {
    reads.push(where);
    return where.accountId.in.filter((id) => map[id]).map((id) => ({ accountId: id, _min: { [field]: map[id] } }));
  };
  return {
    reads,
    account: { findMany: async (args) => { reads.push(args.where); return accounts; } },
    paymentRequest: {
      groupBy: async (args) => (args.where.status === 'PAID' ? groupBy(facts.firstPaidAt, 'paidAt')(args) : groupBy(facts.firstLinkAt, 'createdAt')(args)),
    },
    providerRequest: { groupBy: async (args) => { assert.equal(args.where.route, 'ott-payout'); assert.deepEqual(args.where.status, { in: ['SUCCESS', 'PENDING'] }); return groupBy(facts.firstPayoutAt, 'requestTs')(args); } },
    consent: { groupBy: groupBy(facts.firstConsentAt, 'grantedAt') },
  };
}

test('loadFunnel reads only (accounts in the window plus pre-registered payers, then four first-events) and computes the same funnel', async () => {
  const db = funnelDb(ACCOUNTS, FACTS);
  const f = await loadFunnel({ prisma: db, ...WINDOW, now: new Date('2026-10-28T00:00:00.000Z') });
  const direct = computeFunnel({ accounts: ACCOUNTS, ...FACTS, ...WINDOW, now: new Date('2026-10-28T00:00:00.000Z') });
  assert.deepEqual(f, direct);
  const where = db.reads[0];
  assert.deepEqual(where.OR[0], { createdAt: { gte: WINDOW.since, lt: WINDOW.until } });
  assert.deepEqual(where.OR[1], { profile: { path: ['origin', 'kind'], equals: 'PAYER' } });
  const ids = db.reads[1].accountId.in;
  assert.ok(!ids.includes('p2') && !ids.includes('x1'), 'only accounts opened in the window are read further');
  const lib = read('../lib/signup-funnel.js');
  assert.ok(!/\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(|\$executeRaw/.test(lib), 'the funnel writes nothing');
});

test('the nightly audit line: yesterday\'s finished rate by path, in the ops summary', async () => {
  const f = computeFunnel({ accounts: ACCOUNTS, ...FACTS, since: new Date('2026-10-21T00:00:00.000Z'), until: new Date('2026-10-22T00:00:00.000Z'), now: new Date('2026-10-22T02:00:00.000Z') });
  const line = signupAuditLine(f);
  assert.equal(line, 'Sign-up 2026-10-21: one-step 3 of 3 finished (100%); classic 1 of 1 finished (100%).');
  assert.equal(signupAuditLine(computeFunnel({ accounts: [], since: new Date('2026-10-21T00:00:00.000Z'), until: new Date('2026-10-22T00:00:00.000Z') })), 'Sign-up 2026-10-21: one-step none opened; classic none opened.');
  const db = funnelDb(ACCOUNTS, FACTS);
  assert.equal(await yesterdaySignupLine({ prisma: db, now: new Date('2026-10-22T02:00:00.000Z') }), line);
  assert.equal(await yesterdaySignupLine({ prisma: { account: { findMany: async () => { throw new Error('down'); } } } }), null, 'best effort');
  const base = { since: new Date('2026-10-21T02:00:00Z'), until: new Date('2026-10-22T02:00:00Z'), accounts: 3, turns: 40, counts: { p1: 0, p2: 0, p3: 0, distinct: 0, hits: 0 }, status: { open: 0, recurring: 0, resolved: 0 }, resolvedInRun: 0, reviewed: true, review: {}, topRecurring: [], url: 'https://x/admin' };
  const s = opsSummary({ ...base, signupLine: line });
  assert.ok(s.text.split('\n').includes(line));
  assert.ok(s.detailsHtml.includes('Sign-up 2026-10-21'));
  assert.ok(!opsSummary(base).text.includes('Sign-up'), 'no line, nothing added');
  const run = read('../lib/audit/run.js');
  assert.match(run, /\(deps\.signupLine \|\| yesterdaySignupLine\)\(\{ prisma, now: new Date\(now\) \}\)/);
  assert.match(run, /setTimeout\(\(\) => resolve\(null\), SIGNUP_LINE_CAP_MS\)/, 'a slow read leaves the line out, never the summary');
});

test('the routes and the card: internal key on the funnel, the admin session on the card, aggregates only', () => {
  const internal = read('../pages/api/internal/funnel.js');
  const auth = internal.indexOf('if (!requireInternalAuth(req, res)) return;');
  assert.ok(auth > 0 && auth < internal.indexOf('loadFunnel('), 'the key before any read');
  assert.match(internal, /parseWindow\(\{ since: req\.query\?\.since \|\| null, until: req\.query\?\.until \|\| null \}\)/);
  assert.match(internal, /res\.status\(400\)\.json\(\{ ok: false, error: w\.error \}\)/);
  const admin = read('../pages/api/admin/signup-funnel.js');
  assert.ok(admin.indexOf('if (!requireAdmin(req).ok)') < admin.indexOf('loadFunnel('));
  const page = read('../pages/admin/index.js');
  assert.match(page, /function SignupFunnelCard\(\{ range \}\)/);
  assert.match(page, /fetch\(`\/api\/admin\/signup-funnel\?range=\$\{range\}`\)/);
  assert.match(page, /<DailyLines rows=\{rows\} series=\{\[/, 'the existing chart component');
  const growth = page.slice(page.indexOf('function Growth() {'));
  assert.ok(growth.indexOf('<SignupFunnelCard range={range} />') > 0, 'on the Growth tab, with its range');
  for (const src of [internal, admin]) assert.ok(!/msisdn|waId|displayName/.test(src), 'no customer identifier in the routes');
  // Pre-registered payers who never wrote are not counted as contacts on the Growth tab.
  assert.match(read('../pages/api/admin/growth.js'), /WHERE coalesce\(a\."profile"->'origin'->>'kind', ''\) <> 'PAYER' OR \(a\."profile"->'onboarding'->>'startedAt'\) IS NOT NULL/);
});

test('genuinePaid72h counts only a first link paid by someone else (2026-10-23): own number and unknown payers do not count', async () => {
  const day = '2026-10-20T08:00:00.000Z';
  const accounts = [
    { id: 'g1', waId: '27831110001', createdAt: new Date(day), onboardingState: 'S5_COMPLETED', profile: {} },
    { id: 'g2', waId: '27831110002', createdAt: new Date(day), onboardingState: 'S5_COMPLETED', profile: {} },
    { id: 'g3', waId: '27831110003', createdAt: new Date(day), onboardingState: 'S5_COMPLETED', profile: {} },
  ];
  const paidAt = new Date('2026-10-20T10:00:00.000Z');
  const prisma = {
    account: { findMany: async () => accounts },
    paymentRequest: {
      groupBy: async (args) => (args.where.status === 'PAID' ? accounts.map((a) => ({ accountId: a.id, _min: { paidAt } })) : accounts.map((a) => ({ accountId: a.id, _min: { createdAt: new Date(day) } }))),
      findMany: async () => [
        { id: 'PRAAAAAA', accountId: 'g1', paidAt, payerRef: 'PAYFAST:1' },
        { id: 'PRBBBBBB', accountId: 'g2', paidAt, payerRef: 'PAYFAST:2' },
        { id: 'PRCCCCCC', accountId: 'g3', paidAt, payerRef: 'PAYFAST:3' },
      ],
    },
    providerRequest: {
      groupBy: async () => [],
      findMany: async () => [
        { id: 'pfreq-PRAAAAAA', metadata: { payerMsisdn: '0729990001' } },
        { id: 'pfreq-PRBBBBBB', metadata: { payerMsisdn: '0831110002' } },
        { id: 'pfreq-PRCCCCCC', metadata: { payerMsisdn: null } },
      ],
    },
    consent: { groupBy: async () => [] },
  };
  const f = await loadFunnel({ prisma, since: new Date('2026-10-20T00:00:00Z'), until: new Date('2026-10-21T00:00:00Z'), now: new Date('2026-10-25T00:00:00Z') });
  assert.equal(f.summary.total.firstPaid72h, 3, 'any paid link');
  assert.equal(f.summary.total.genuinePaid72h, 1, 'only g1: someone else paid; g2 gave its own number, g3 none');
});
