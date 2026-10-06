/**
 * Pay-out books (Mission Control reconciliation card, 2026-10-04).
 *
 * The judge is pure: rows in, checks and anomalies out. Each money rule from
 * lib/payouts.js has one fixture that keeps it and one that breaks it. The
 * route and the card are guarded statically like the other admin routes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { reconcilePayoutBooks, ledgerTotals, clientFunds } from '../lib/payout-books.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const NOW = new Date('2026-10-04T10:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms);
const H = 3600 * 1000;

const row = (idemKey, status, { amountCents = 5000, feeCents = 1800, method = 'NEDCASH', reference = `WP${idemKey.toUpperCase()}`, at = ago(2 * H) } = {}) =>
  ({ idemKey, status, requestTs: at, metadata: { amountCents, feeCents, method, reference } });
const hold = (base, status, amountCents = 6800) => ({ idemKey: `${base}-hold`, status, amountCents, createdAt: ago(2 * H), resolvedAt: status === 'ACTIVE' ? null : ago(H) });
const cashout = (base, amountCents = 5000, feeCents = 1800, rail = 'OTT') => ({
  idemKey: `${base}-cashout`, source: 'CASHOUT_NEDCASH', createdAt: ago(H),
  lines: [
    { accountCode: 'WALLET:acc-1:CASH', debitCents: amountCents + feeCents, creditCents: null },
    { accountCode: `CLEARING:${rail}`, debitCents: null, creditCents: amountCents },
    { accountCode: 'REVENUE:FEE:CASHOUT', debitCents: null, creditCents: feeCents },
  ],
});
const railcost = (base, railCostCents = 977) => ({
  idemKey: `${base}-railcost`, source: 'CASHOUT_COST_NEDCASH', createdAt: ago(H),
  lines: [{ accountCode: 'EXPENSE:PROVIDER:OTT', debitCents: railCostCents, creditCents: null }, { accountCode: 'CLEARING:OTT', debitCents: null, creditCents: railCostCents }],
});
const walletSums = [
  { balanceType: 'SPEND', _sum: { availableCents: 123456, pendingCents: 0 }, _count: { _all: 40 } },
  { balanceType: 'CASH', _sum: { availableCents: 6600, pendingCents: 6800 }, _count: { _all: 3 } },
];

test('clean books: the 4 October morning (one SUCCESS, one PENDING, one FAILED) passes every check', () => {
  const books = reconcilePayoutBooks({
    payoutRows: [row('ned', 'SUCCESS', { amountCents: 2000 }), row('shap', 'PENDING', { method: 'PAYSHAP', amountCents: 5000, feeCents: 800 }), row('abs', 'FAILED', { method: 'CASHSEND' })],
    holds: [hold('ned', 'SETTLED', 3800), hold('shap', 'ACTIVE', 5800), hold('abs', 'RELEASED')],
    entries: [cashout('ned', 2000), railcost('ned')],
    walletSums, now: NOW,
  });
  assert.equal(books.allOk, true, JSON.stringify(books.checks.filter((c) => !c.ok)));
  assert.deepEqual(books.anomalies, []);
  assert.equal(books.payouts.byStatus.SUCCESS.count, 1);
  assert.equal(books.payouts.openCount, 1);
  assert.equal(books.payouts.openHeldCents, 5800);
  assert.equal(books.payouts.activeHeldCents, 5800);
  assert.equal(books.ledger.paidOutCents, 2000);
  assert.equal(books.ledger.feeRevenueCents, 1800);
  assert.equal(books.ledger.railCostCents, 977);
  assert.deepEqual(books.clientFunds, { spendCents: 123456, cashCents: 6600, pendingCents: 6800, wallets: 43, totalCents: 136856 });
});

test('a SUCCESS with no cash-out entry, and one whose hold was never settled, are both named', () => {
  const books = reconcilePayoutBooks({
    payoutRows: [row('a', 'SUCCESS'), row('b', 'SUCCESS')],
    holds: [hold('a', 'SETTLED'), hold('b', 'ACTIVE')],
    entries: [cashout('b')],
    walletSums, now: NOW,
  });
  assert.equal(books.allOk, false);
  const byId = Object.fromEntries(books.checks.map((c) => [c.id, c]));
  assert.equal(byId.success_booked.ok, false);
  assert.equal(byId.success_booked.count, 2);
  assert.equal(byId.ledger_total.ok, false, 'journal 5000 vs rows 10000');
  assert.ok(books.anomalies.some((x) => x.reference === 'WPA' && /no pay-out entry/.test(x.problem)));
  assert.ok(books.anomalies.some((x) => x.reference === 'WPB' && /hold is ACTIVE/.test(x.problem)));
});

test('a FAILED pay-out that kept its hold or booked a cash-out is a customer being short-changed', () => {
  const books = reconcilePayoutBooks({
    payoutRows: [row('x', 'FAILED'), row('y', 'FAILED'), row('z', 'FAILED')],
    holds: [hold('x', 'ACTIVE'), hold('y', 'RELEASED')],
    entries: [cashout('y')],
    walletSums, now: NOW,
  });
  const byId = Object.fromEntries(books.checks.map((c) => [c.id, c]));
  assert.equal(byId.failed_clean.ok, false);
  assert.equal(byId.failed_clean.count, 2);
  assert.ok(books.anomalies.some((x) => x.reference === 'WPX' && /still ACTIVE/.test(x.problem)));
  assert.ok(books.anomalies.some((x) => x.reference === 'WPY' && /pay-out journal entry exists/.test(x.problem)));
  // z: failed before any hold was reserved (affordability) — nothing to release, nothing wrong.
  assert.ok(!books.anomalies.some((x) => x.reference === 'WPZ'));
  assert.equal(byId.no_orphans.ok, false, 'x’s ACTIVE hold has no open row');
});

test('an open pay-out without an active hold, and an orphan active hold, are both money nobody is watching', () => {
  const books = reconcilePayoutBooks({
    payoutRows: [row('p', 'PENDING'), row('q', 'INIT')],
    holds: [hold('p', 'RELEASED'), hold('q', 'ACTIVE'), hold('ghost', 'ACTIVE', 1234)],
    entries: [],
    walletSums, now: NOW,
  });
  const byId = Object.fromEntries(books.checks.map((c) => [c.id, c]));
  assert.equal(byId.open_held.ok, false);
  assert.equal(byId.no_orphans.ok, false);
  assert.equal(byId.held_total.ok, false, 'active holds 6800+1234 vs open rows 2×6800');
  assert.ok(books.anomalies.some((x) => x.reference === 'WPP' && /not parked/.test(x.problem)));
  assert.ok(books.anomalies.some((x) => x.status === 'HOLD' && x.amountCents === 1234 && /nobody chasing/.test(x.problem)));
  assert.ok(!books.anomalies.some((x) => x.reference === 'WPQ'));
});

test('two cash-out entries for one SUCCESS trip the per-success check', () => {
  const books = reconcilePayoutBooks({
    payoutRows: [row('a', 'SUCCESS', { amountCents: 2000 })],
    holds: [hold('a', 'SETTLED')],
    entries: [cashout('a', 2000), { ...cashout('a', 2000), idemKey: 'stray-cashout' }],
    walletSums, now: NOW,
  });
  const byId = Object.fromEntries(books.checks.map((c) => [c.id, c]));
  assert.equal(byId.cashout_per_success.ok, false);
  assert.equal(byId.ledger_total.ok, false);
});

test('ledgerTotals and clientFunds tolerate empty, odd and partial rows', () => {
  assert.deepEqual(ledgerTotals([]), { paidOutCents: 0, feeRevenueCents: 0, railCostCents: 0, paidOutEntries: 0, railCostEntries: 0 });
  assert.deepEqual(ledgerTotals([{ idemKey: 'k-cashout', lines: null }, { idemKey: 'other' }]).paidOutEntries, 1);
  assert.deepEqual(clientFunds([]), { spendCents: 0, cashCents: 0, pendingCents: 0, wallets: 0, totalCents: 0 });
  assert.equal(clientFunds([{ balanceType: 'cash', availableCents: 5 }]).cashCents, 5);
  const empty = reconcilePayoutBooks({ now: NOW });
  assert.equal(empty.allOk, true);
  assert.equal(empty.payouts.total, 0);
});

test('anomalies carry the reference, method and amount only: never a recipient, account id or provider text', () => {
  const books = reconcilePayoutBooks({
    payoutRows: [{ idemKey: 'a', status: 'SUCCESS', requestTs: ago(H), metadata: { amountCents: 100, feeCents: 10, method: 'PAYSHAP', reference: 'WPA', recipient: { account_number: '62001234567', mobile: '0787051175' }, providerBody: 'secret text' } }],
    holds: [], entries: [], walletSums: [], now: NOW,
  });
  const text = JSON.stringify(books.anomalies);
  assert.ok(!text.includes('62001234567') && !text.includes('0787051175') && !text.includes('secret text'));
  assert.deepEqual(Object.keys(books.anomalies[0]).sort(), ['ageMinutes', 'amountCents', 'feeCents', 'method', 'problem', 'reference', 'status']);
});

test('the route is admin-gated, GET-only, duration-capped, reads four sources in one batch and reduces metadata before judging', () => {
  const src = read('../pages/api/admin/payout-reconciliation.js');
  assert.match(src, /import \{ requireAdmin \} from '..\/..\/..\/lib\/admin-auth.js'/);
  assert.match(src, /if \(!requireAdmin\(req\)\.ok\) return res\.status\(401\)\.json\(\{ error: 'UNAUTHORIZED' \}\)/);
  assert.match(src, /if \(req\.method !== 'GET'\) return res\.status\(405\)/);
  assert.match(src, /export const config = \{ maxDuration: 25 \}/);
  assert.match(src, /where: \{ route: 'ott-payout' \}/);
  assert.match(src, /where: \{ reason: \{ startsWith: 'payout' \} \}/);
  assert.match(src, /where: \{ source: \{ startsWith: 'CASHOUT' \} \}/);
  assert.match(src, /prisma\.wallet\.groupBy\(\{ by: \['balanceType'\]/);
  assert.match(src, /metadata: \{ amountCents: m\.amountCents \?\? null, feeCents: m\.feeCents \?\? null, method: m\.method \|\| null, reference: m\.reference \|\| null \}/, 'recipient and provider body never reach the judge');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/recipient|providerBody|accountId: true/.test(code), 'no recipient, provider text or account id is selected');
  assert.match(src, /error: 'BOOKS_UNAVAILABLE'/);
  assert.ok(!src.includes('GetAPIKey'));
});

test('Mission Control renders the card from the route and compares against the supplier float', () => {
  const page = read('../pages/admin/index.js');
  assert.match(page, /<h2>Pay-out reconciliation<\/h2>/);
  assert.match(page, /fetch\('\/api\/admin\/payout-reconciliation'\)/);
  assert.match(page, /function PayoutBooks\(\)/);
  assert.match(page, /f\.key === 'OTT_PAYOUT'/, 'the float comes from the floats route, not a second supplier call');
  assert.match(page, /c\.id === 'held_total'|checks \|\| \[\]/);
});

// ---------------------------------------------------------------------------
// Prepaid electricity parked at Blu (2026-10-06, BUGLOG #88 follow-up)
// ---------------------------------------------------------------------------
import { electricityBooks, ELECTRICITY_HOLD_PREFIX } from '../lib/payout-books.js';

const erow = (id, status, meta = {}, at = ago(10 * 60000)) => ({ id, status, requestTs: at, metadata: { amountCents: 5000, ...meta } });
const ehold = (id, status, amountCents = 5000) => ({ idemKey: `${ELECTRICITY_HOLD_PREFIX}${id}`, status, amountCents, createdAt: ago(10 * 60000) });

test('electricity: a parked RECONCILE sale with its hold, a fresh EXECUTING one, and a settled SUCCESS pass every check', () => {
  const b = electricityBooks({
    rows: [erow('p1', 'RECONCILE', { indeterminateAt: ago(9 * 60000).toISOString(), lastReconcileAt: ago(3 * 60000).toISOString(), timeoutReason: 'SALE_TIMEOUT' }), erow('p2', 'EXECUTING', { executingAt: ago(30 * 1000).toISOString() }), erow('p3', 'SUCCESS'), erow('p4', 'FAILED')],
    holds: [ehold('p1', 'ACTIVE'), ehold('p2', 'ACTIVE', 7000), ehold('p3', 'SETTLED'), ehold('p4', 'RELEASED')],
    now: NOW,
  });
  assert.equal(b.allOk, true, JSON.stringify(b.checks.filter((c) => !c.ok)));
  assert.deepEqual(b.anomalies, []);
  assert.equal(b.parked, 2);
  assert.equal(b.parkedHeldCents, 12000);
  assert.equal(b.activeHolds, 2);
  assert.equal(b.lastReconcileMinutesAgo, 3);
  assert.equal(b.oldestParkedMinutes, 10);
  assert.deepEqual(b.byStatus, { RECONCILE: 1, EXECUTING: 1, SUCCESS: 1, FAILED: 1 });
});

test('electricity: a parked sale without an active hold, a stale EXECUTING, a SUCCESS still holding, a FAILED never released and an orphan hold are all named', () => {
  const b = electricityBooks({
    rows: [erow('a', 'RECONCILE'), erow('b', 'EXECUTING', { executingAt: ago(5 * 60000).toISOString() }), erow('c', 'SUCCESS'), erow('d', 'FAILED')],
    holds: [ehold('a', 'RELEASED'), ehold('b', 'ACTIVE'), ehold('c', 'ACTIVE'), ehold('d', 'SETTLED'), ehold('ghost', 'ACTIVE', 1234), { idemKey: 'payout-x-hold', status: 'ACTIVE', amountCents: 999 }],
    now: NOW,
  });
  const byId = Object.fromEntries(b.checks.map((c) => [c.id, c]));
  assert.equal(byId.elec_parked_held.ok, false);
  assert.equal(byId.elec_no_stale.ok, false);
  assert.equal(byId.elec_resolved_clean.ok, false);
  assert.equal(byId.elec_resolved_clean.count, 2);
  assert.equal(byId.elec_no_orphans.ok, false);
  assert.equal(b.activeHolds, 3, 'the pay-out hold is not counted as electricity');
  assert.ok(b.anomalies.some((x) => x.reference === 'ELEC-a' && /not parked/.test(x.problem)));
  assert.ok(b.anomalies.some((x) => x.reference === 'ELEC-b' && /invocation died/.test(x.problem)));
  assert.ok(b.anomalies.some((x) => x.reference === 'ELEC-c' && /still ACTIVE/.test(x.problem)));
  assert.ok(b.anomalies.some((x) => x.reference === 'ELEC-d' && /did not come back/.test(x.problem)));
  assert.ok(b.anomalies.some((x) => x.status === 'HOLD' && x.amountCents === 1234));
  for (const a of b.anomalies) assert.deepEqual(Object.keys(a).sort(), ['ageMinutes', 'amountCents', 'feeCents', 'method', 'problem', 'reference', 'status']);
  assert.ok(!JSON.stringify(b).includes('meter'), 'no meter field anywhere');
});

test('electricity: the route reads the Blu preview rows and the elec holds, reduces metadata to the markers, and the card renders the section', () => {
  const src = read('../pages/api/admin/payout-reconciliation.js');
  assert.match(src, /where: \{ provider: 'BLU', route: 'electricity-preview' \}/);
  assert.match(src, /idemKey: \{ startsWith: ELECTRICITY_HOLD_PREFIX \}/);
  assert.match(src, /indeterminateAt: m\.indeterminateAt \|\| null, executingAt: m\.executingAt \|\| null, lastReconcileAt: m\.lastReconcileAt \|\| null, timeoutReason: m\.timeoutReason \|\| null/);
  assert.ok(!/meterNumber|meter:/.test(src), 'the meter never leaves the row');
  assert.match(src, /electricity: electricityBooks\(/);
  const page = read('../pages/admin/index.js');
  assert.match(page, /Prepaid electricity parked at Blu/);
  assert.match(page, /b\.electricity/);
});
