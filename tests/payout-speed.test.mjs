// Two speeds for a pay-out to a bank account (founder 2026-11-07, confirmed 2026-11-11 "12 yes"): R12 on the next
// business day or R20 the same day; money that reached the balance under 2 hours ago only gets the next business
// day; cash keeps R18 / R23 / R30. The next business day never goes before 08:00 SAST on that day.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { proofFor } from './helpers/pin-proof.mjs';

process.env.WAPAY_PII_KEY ||= '7f'.repeat(32);
process.env.WAPAY_INTERNAL_API_KEY ||= 'test-internal-key-for-proofs';
const { nextBusinessDayAt, sameDayCheck, speedFor, releaseWhen, releasePending, hasSpeeds } = await import('../lib/payout-speed.js');
const { requestPayout, quotePayout } = await import('../lib/payouts.js');
const { cashoutFeeCents, cashoutMarginCents } = await import('../lib/ledger-core.js');
const { approvePayout, rejectPayout, releaseDuePayouts, listAwaitingApproval, scheduledCopy } = await import('../lib/payout-approval.js');
const { PAYOUT_APPROVAL_KEY, _resetPayoutHoldCache } = await import('../lib/payout-hold.js');
const { confirmAsk, parseSpeedChoice, notClearedCopy, scheduledRequestCopy, awaitingApprovalCopy } = await import('../lib/payout-chat.js');
const { TEMPLATE_ENVS } = await import('../lib/meta-compliance.js');

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const MIN = 60 * 1000;
const H = 60 * MIN;
// 08:00 SAST is 06:00 UTC (no daylight saving in South Africa).
const sast = (iso) => Date.parse(`${iso}+02:00`);

test('the fees: R12 on the next business day by default, R20 the same day, cash unchanged', () => {
  for (const m of ['PAYSHAP', 'RTC']) {
    assert.equal(hasSpeeds(m), true);
    assert.equal(cashoutFeeCents(m, 5000), 1200, `${m} next business day`);
    assert.equal(cashoutFeeCents(m, 300000, 'NEXT_DAY'), 1200);
    assert.equal(cashoutFeeCents(m, 300000, 'SAME_DAY'), 2000, `${m} same day`);
    assert.ok(cashoutMarginCents(m, 300000) > 0 && cashoutMarginCents(m, 300000, 'SAME_DAY') > cashoutMarginCents(m, 300000));
  }
  for (const m of ['CASHSEND', 'NEDCASH', 'EWALLET']) {
    assert.equal(hasSpeeds(m), false);
    assert.deepEqual([cashoutFeeCents(m, 70000), cashoutFeeCents(m, 150000), cashoutFeeCents(m, 300000)], [1800, 2300, 3000], `${m}: R18 / R23 / R30 as before`);
    assert.equal(cashoutFeeCents(m, 70000, 'SAME_DAY'), 1800, 'a speed never changes a cash fee');
    assert.equal(speedFor(m, 'SAME_DAY'), null);
  }
  assert.equal(speedFor('PAYSHAP', null), 'NEXT_DAY'); assert.equal(speedFor('PAYSHAP', 'same_day'), 'SAME_DAY'); assert.equal(speedFor('RTC', 'anything'), 'NEXT_DAY');
  assert.deepEqual([quotePayout({ method: 'PAYSHAP', amountCents: 50000 }).totalCents, quotePayout({ method: 'PAYSHAP', amountCents: 50000, speed: 'SAME_DAY' }).totalCents], [51200, 52000]);
});

test('the next business day: 08:00 SAST on the first weekday after the day of the request; Friday evening and the weekend go to Monday', () => {
  const cases = [
    ['2026-11-11T10:00:00', '2026-11-12T08:00:00', 'Wednesday morning → Thursday'],
    ['2026-11-09T07:00:00', '2026-11-10T08:00:00', 'Monday before 08:00 still → Tuesday (the NEXT business day)'],
    ['2026-11-12T23:30:00', '2026-11-13T08:00:00', 'Thursday 23:30 SAST → Friday'],
    ['2026-11-13T00:30:00', '2026-11-16T08:00:00', 'Friday 00:30 SAST (Thursday 22:30 UTC) → Monday'],
    ['2026-11-13T18:00:00', '2026-11-16T08:00:00', 'Friday evening → Monday'],
    ['2026-11-14T12:00:00', '2026-11-16T08:00:00', 'Saturday → Monday'],
    ['2026-11-15T23:59:00', '2026-11-16T08:00:00', 'Sunday night → Monday'],
    ['2026-12-31T15:00:00', '2027-01-01T08:00:00', 'no public-holiday list in the code: a weekday holiday counts'],
  ];
  for (const [at, want, why] of cases) assert.equal(new Date(nextBusinessDayAt(sast(at))).toISOString(), new Date(sast(want)).toISOString(), why);
  assert.equal(releaseWhen(sast('2026-11-16T08:00:00')), 'Monday 16 November, from 08:00');
  assert.equal(releaseWhen(new Date(sast('2026-11-12T08:00:00')).toISOString()), 'Thursday 12 November, from 08:00');
  assert.equal(releasePending({ speed: 'NEXT_DAY', releaseAt: new Date(sast('2026-11-12T08:00:00')).toISOString() }, sast('2026-11-12T07:59:00')), true);
  assert.equal(releasePending({ speed: 'NEXT_DAY', releaseAt: new Date(sast('2026-11-12T08:00:00')).toISOString() }, sast('2026-11-12T08:00:00')), false);
  assert.equal(releasePending({ speed: 'SAME_DAY' }), false);
});

test('same day only when the pay-out needs no money under 2 hours old; when it does, the time it clears', () => {
  const now = sast('2026-11-11T14:00:00');
  const fresh = [{ cents: 30000, at: now - 30 * MIN }];
  const blocked = sameDayCheck({ balanceCents: 40000, receipts: fresh, amountCents: 20000, feeCents: 2000, now });
  assert.equal(blocked.cleared, false); assert.equal(blocked.clearedFromAt, fresh[0].at + 2 * H);
  assert.equal(sameDayCheck({ balanceCents: 40000, receipts: fresh, amountCents: 5000, feeCents: 2000, now }).cleared, true, 'R70 fits in the R100 that was already there');
  assert.equal(sameDayCheck({ balanceCents: 40000, receipts: [{ cents: 30000, at: now - 3 * H }], amountCents: 20000, feeCents: 2000, now }).cleared, true, 'older money is cleared');
  assert.equal(sameDayCheck({ balanceCents: 40000, receipts: fresh, amountCents: 50000, feeCents: 2000, now }).clearedFromAt, null, 'more than the balance never clears');
});

// ---- requestPayout, approval and release, with stubs (the payout-approval test's shape) ----
const providers = [{ method: 'PAYSHAP', label: 'PayShap', providerCode: '66', providerName: 'PayShap Account', minCents: 5000, maxCents: 300000 }];
const recipient = { firstname: 'Lerato', surname: 'M', mobile: '073 123 4567', account_number: '62012345678', branch_code: '250655', branch_name: 'FNB', id_number: '9001015009087' };
const account = { id: 'acc-speed-0000000000001', waId: '27731234567', createdAt: new Date(Date.now() - 60 * 86400e3), profile: { kyc: { status: 'VERIFIED', fullName: 'Lerato M' } } };
function env() {
  process.env.WAPAY_PAYOUT_ENABLED = 'true';
  process.env.OTT_PAYOUT_BASE_URL = 'https://test-payoutapi.example';
  process.env.OTT_PAYOUT_USERNAME = 'u'; process.env.OTT_PAYOUT_PASSWORD = 'p'; process.env.OTT_PAYOUT_API_KEY = 'k';
  process.env.WAPAY_PAYOUT_KYC = 'off';
  delete process.env.WAPAY_PAYOUT_TEST_NUMBERS;
  _resetPayoutHoldCache();
}
function db({ approval = false, frozen = false } = {}) {
  const prs = []; const markers = new Set(approval ? [PAYOUT_APPROVAL_KEY] : []);
  const prof = () => ({ ...account.profile, ...(frozen ? { payouts: { frozen: true } } : {}) });
  const match = (r, where) => (!where.idemKey || r.idemKey === where.idemKey) && (!where.status || (typeof where.status === 'string' ? r.status === where.status : where.status.in.includes(r.status))) && (!where.metadata || r.metadata?.[where.metadata.path[0]] === where.metadata.equals) && (!where.route || r.route === where.route);
  return {
    _prs: prs, _freeze: (v) => { frozen = v; },
    processedMessage: {
      async findUnique({ where }) { return markers.has(where.waMessageId) ? { id: 'm', processedAt: new Date() } : null; },
      async upsert({ where }) { markers.add(where.waMessageId); return {}; },
      async deleteMany() { return { count: 0 }; },
      async create() { return {}; },
      async findFirst() { return null; },
    },
    account: { async findUnique() { return { ...account, profile: prof() }; }, async findMany() { return []; } },
    providerRequest: {
      async findUnique({ where }) { return prs.find((r) => r.idemKey === where.idemKey) || null; },
      async findMany({ where }) { if (where?.route === 'ott-payout' && (where.status || where.metadata)) return prs.filter((r) => match(r, where)); return []; },
      async create({ data }) { const row = { id: `pr${prs.length + 1}`, requestTs: new Date(), ...data }; prs.push(row); return row; },
      async update({ where, data }) { const r = prs.find((x) => x.idemKey === where.idemKey); Object.assign(r, data); return r; },
      async updateMany({ where, data }) { const rows = prs.filter((r) => match(r, where)); for (const r of rows) Object.assign(r, data); return { count: rows.length }; },
    },
    paymentRequest: { async findMany() { return []; } },
    journalEntry: { async findMany() { return []; } },
    wallet: { async findMany() { return [{ balanceType: 'SPEND', availableCents: 50000, pendingCents: 0 }]; } },
    auditLog: { async create({ data }) { return data; } },
  };
}
function ledger() {
  const calls = []; const holds = new Map(); const settled = [];
  return {
    calls, holds, settled,
    async ensureWallet() { calls.push('ensureWallet'); },
    async postEntry(e) { calls.push(`post:${e.source}`); return {}; },
    async reserveHold({ idemKey, amountCents }) { calls.push('reserveHold'); holds.set(idemKey, { amountCents, status: 'ACTIVE' }); },
    async settleHold({ idemKey, entry }) { calls.push(`settleHold:${entry.source}`); settled.push(entry); holds.get(idemKey).status = 'SETTLED'; },
    async releaseHold({ idemKey }) { calls.push('releaseHold'); if (holds.get(idemKey)) holds.get(idemKey).status = 'RELEASED'; },
  };
}
const rail = (seen = []) => ({ async performPayout(a) { seen.push(a); return { settlement: 'SETTLE', outcome: 'SETTLED', status: 100, paymentReference: 'OTT1' }; }, async getPaymentStatus() { return {}; } });
const ask = ({ prisma, led, client, intentId = 'intent-sp0001', amountCents = 20000, speed, receipts = [], now, alerts = [] }) =>
  requestPayout({ prisma, ledger: led, client, account, intentId, method: 'PAYSHAP', speed, amountCents, recipient, providers, readFloat: async () => null, authorization: proofFor(account, { intentId, amountCents }), receipts, now, alertRequest: async (a) => { alerts.push(a); } });

test('same day with money under 2 hours old: refused before any row, hold or rail call; the customer can take the next business day', async () => {
  env();
  const prisma = db(); const led = ledger(); const seen = []; const alerts = [];
  const now = Date.now();
  const out = await ask({ prisma, led, client: rail(seen), speed: 'SAME_DAY', receipts: [{ cents: 45000, at: now - 20 * MIN }], now, alerts });
  assert.equal(out.ok, false); assert.equal(out.error, 'NOT_CLEARED'); assert.equal(out.feeCents, 2000); assert.equal(out.nextDayFeeCents, 1200);
  assert.equal(out.clearedFromAt, now - 20 * MIN + 2 * H);
  assert.deepEqual(prisma._prs, []); assert.deepEqual(led.calls, []); assert.equal(seen.length, 0);
  assert.match(alerts[0].text, /R200 by PayShap · fee R20 · same day/); assert.match(alerts[0].text, /Result: not sent: same day needs money older than 2 hours/);
  assert.match(notClearedCopy(out), /^💸 Same day is not open for this pay-out any more: some of the money reached your balance less than 2 hours ago\. Nothing was sent and nothing has left your balance\. Say \*withdraw\* to send it on the next business day for R12 or choose the same day again from \d\d:\d\d\.$/);
  // The same request on the next business day goes through: it is set aside, never sent today.
  const next = await ask({ prisma, led, client: rail(seen), intentId: 'intent-sp0002', receipts: [{ cents: 45000, at: now - 20 * MIN }], now });
  assert.equal(next.ok, true); assert.equal(next.status, 'SCHEDULED'); assert.equal(next.feeCents, 1200); assert.equal(seen.length, 0);
  assert.ok(prisma._prs[0].metadata.triage.reasons.includes('FRESH_MONEY'), 'the fraud triage still sees money under 2 hours old');
  assert.equal(prisma._prs[0].metadata.express, undefined, 'and the fee is not doubled');
});

test('without approval mode the next business day is SCHEDULED: set aside, encrypted, released from 08:00 SAST that day and not before', async () => {
  env();
  const prisma = db(); const led = ledger(); const seen = []; const alerts = [];
  const now = sast('2026-11-13T18:00:00'); // Friday evening
  const out = await ask({ prisma, led, client: rail(seen), now, alerts });
  assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.status, 'SCHEDULED'); assert.equal(out.feeCents, 1200); assert.equal(out.speed, 'NEXT_DAY');
  assert.equal(out.releaseAt, new Date(sast('2026-11-16T08:00:00')).toISOString(), 'Monday 08:00 SAST');
  assert.deepEqual(led.calls, ['ensureWallet', 'post:BALANCE_UPGRADE', 'reserveHold']); assert.equal([...led.holds.values()][0].amountCents, 21200);
  const row = prisma._prs[0];
  assert.equal(row.status, 'SCHEDULED'); assert.equal(row.metadata.speed, 'NEXT_DAY'); assert.ok(row.metadata.approval.enc, 'the destination is kept encrypted');
  assert.ok(!JSON.stringify(row.metadata).includes('62012345678'), 'never the account number in clear');
  assert.equal(seen.length, 0, 'nothing reaches the rail today');
  assert.match(alerts[0].text, /fee R12 · next business day \(Monday 16 November, from 08:00\)/); assert.match(alerts[0].text, /Result: set aside for the next business day, nothing sent yet/);
  assert.match(scheduledRequestCopy(out), /^🗓️ \*Set aside for the next business day\.\* Your R200 and the R12 fee are set aside and go to your bank on Monday 16 November, from 08:00 \(reference WP[0-9A-F]{14}\)\. Nothing has left WaPay yet\./);
  // The weekend runs send nothing; Monday 08:00 sends it, once.
  const sat = await releaseDuePayouts({ prisma, ledger: led, client: rail(seen), now: sast('2026-11-14T08:00:00'), readFloat: async () => null, deps: { notifyCustomer: async () => ({ ok: true }) } });
  assert.deepEqual([sat.scheduled, sat.due, sat.sent], [1, 0, 0]); assert.equal(seen.length, 0);
  const told = [];
  const mon = await releaseDuePayouts({ prisma, ledger: led, client: rail(seen), now: sast('2026-11-16T08:05:00'), readFloat: async () => null, deps: { notifyCustomer: async (m) => { told.push(m); return { ok: true }; } } });
  assert.deepEqual([mon.due, mon.sent], [1, 1]); assert.equal(seen.length, 1); assert.equal(row.status, 'SUCCESS');
  assert.equal(led.settled[0].postings.find((p) => p.accountCode === 'REVENUE:FEE:CASHOUT').creditCents, 1200);
  assert.ok(!row.metadata.approval.enc, 'the encrypted details leave the row once it is sent');
  assert.equal(told.length, 1);
  const again = await releaseDuePayouts({ prisma, ledger: led, client: rail(seen), now: sast('2026-11-16T09:00:00'), readFloat: async () => null });
  assert.equal(again.due, 0); assert.equal(seen.length, 1, 'never sent twice');
});

test('with approval mode: approved before its day it is SCHEDULED; approved after 08:00 that day it goes at once; a schedule can still be rejected', async () => {
  env();
  const prisma = db({ approval: true }); const led = ledger(); const seen = []; const told = [];
  const deps = { notifyCustomer: async (m) => { told.push(m); return { ok: true }; } };
  const now = sast('2026-11-11T16:47:00'); // Wednesday
  const out = await ask({ prisma, led, client: rail(seen), now });
  assert.equal(out.status, 'AWAITING_APPROVAL'); assert.equal(out.releaseAt, new Date(sast('2026-11-12T08:00:00')).toISOString());
  assert.match(awaitingApprovalCopy(out), /Once approved, it goes on the next business day, Thursday 12 November, from 08:00\./);
  const [view] = await listAwaitingApproval({ prisma });
  assert.equal(view.speed, 'NEXT_DAY'); assert.equal(view.releaseAt, out.releaseAt);
  const approved = await approvePayout({ prisma, ledger: led, client: rail(seen), reference: out.reference, readFloat: async () => null, now: sast('2026-11-11T17:00:00'), deps });
  assert.equal(approved.ok, true); assert.equal(approved.status, 'SCHEDULED'); assert.equal(seen.length, 0, 'not sent before its business day');
  assert.equal(prisma._prs[0].status, 'SCHEDULED'); assert.ok(prisma._prs[0].metadata.approval.enc); assert.equal(prisma._prs[0].metadata.approval.approvedBy, 'founder');
  assert.equal(told[0].text, scheduledCopy({ ...approved }));
  assert.match(told[0].text, /^✅ Your pay-out of R200 by PayShap was approved\. It goes to your bank on the next business day, Thursday 12 November, from 08:00 \(reference WP[0-9A-F]{14}\)\. Until then the R200 and the R12 fee stay set aside in WaPay\.$/);
  assert.equal((await approvePayout({ prisma, ledger: led, client: rail(seen), reference: out.reference, now: sast('2026-11-11T17:01:00'), deps })).error, 'NOT_WAITING', 'approving twice does nothing');
  const listed = await listAwaitingApproval({ prisma });
  assert.equal(listed[0].status, 'SCHEDULED', 'the founder still sees it until it goes');
  // Rejected before its day: the money goes back.
  const rejected = await rejectPayout({ prisma, ledger: led, reference: out.reference, deps });
  assert.equal(rejected.ok, true); assert.equal(prisma._prs[0].status, 'FAILED'); assert.equal([...led.holds.values()][0].status, 'RELEASED');
  assert.equal((await releaseDuePayouts({ prisma, ledger: led, client: rail(seen), now: sast('2026-11-12T08:30:00') })).due, 0);
  // Asked Wednesday, approved Thursday 10:00: due already, so it goes at once.
  const late = await ask({ prisma, led, client: rail(seen), intentId: 'intent-sp0009', now });
  const sent = await approvePayout({ prisma, ledger: led, client: rail(seen), reference: late.reference, readFloat: async () => null, now: sast('2026-11-12T10:00:00'), deps });
  assert.equal(sent.status, 'SETTLED'); assert.equal(seen.length, 1);
});

test('at release a frozen account is rejected and a short float leaves it scheduled with one alert', async () => {
  env();
  const prisma = db(); const led = ledger(); const seen = []; const alerts = [];
  const out = await ask({ prisma, led, client: rail(seen), now: sast('2026-11-11T12:00:00') });
  const short = await releaseDuePayouts({ prisma, ledger: led, client: null, now: sast('2026-11-12T08:00:00'), readFloat: async () => ({ balanceCents: 100 }), deps: { opsPersonAlert: async (a) => { alerts.push(a); return { sent: 1 }; } } });
  assert.deepEqual([short.due, short.floatShort, short.sent], [1, 1, 0]); assert.equal(prisma._prs[0].status, 'SCHEDULED', 'still waiting, nothing lost');
  assert.match(alerts[0].text, /1 scheduled pay-out for today could not go: the OTT pay-out float is too low/); assert.match(alerts[0].key, /^release-float:2026-11-12$/);
  prisma._freeze(true);
  const frozen = await releaseDuePayouts({ prisma, ledger: led, client: rail(seen), now: sast('2026-11-12T09:00:00'), readFloat: async () => null, deps: { notifyCustomer: async () => ({ ok: true }) } });
  assert.equal(frozen.rejected, 1); assert.equal(prisma._prs[0].status, 'FAILED'); assert.equal(prisma._prs[0].metadata.outcome, 'REJECTED'); assert.equal(seen.length, 0);
  assert.equal(out.status, 'SCHEDULED');
});

test('the chat: the confirmation offers both speeds, or only the next business day with the reason; the choice is a number or words', () => {
  const base = { method: 'PAYSHAP', amountCents: 20000, balanceCents: 50000, limits: { PAYSHAP: { minCents: 5000, maxCents: 300000 } }, recipient: { savedLabel: 'FNB account •••678' }, kycName: 'Lerato M', intentId: 'wd-sp-0001' };
  const both = confirmAsk({ ...base, receipts: [] });
  assert.equal(both.data.speedChoice, true); assert.match(both.text, /1️⃣ \*Next business day\* \(.+, from 08:00\): R12 fee, \*R212\* leaves your balance\n2️⃣ \*Same day\*: R20 fee, \*R220\* leaves your balance/);
  const fresh = confirmAsk({ ...base, receipts: [{ cents: 45000, at: Date.now() - 10 * MIN }] });
  assert.equal(fresh.data.speedChoice, false); assert.equal(fresh.data.speed, 'NEXT_DAY'); assert.equal(fresh.data.feeCents, 1200);
  assert.match(fresh.text, /Fee: R12\. It goes on the next business day, .+, from 08:00\.\nSame day \(R20\) is not open for this one: some of this money reached your balance less than 2 hours ago\. From \d\d:\d\d you can choose the same day\./);
  assert.match(fresh.text, /Reply \*YES\* to continue to your PIN, or \*NO\* to cancel\.$/);
  const tight = confirmAsk({ ...base, balanceCents: 21500, receipts: [] });
  assert.equal(tight.data.speed, 'NEXT_DAY'); assert.match(tight.text, /Same day costs R20, which your balance does not cover for this amount\./);
  for (const t of ['1', '1️⃣', 'next', 'next business day', 'tomorrow', 'R12']) assert.equal(parseSpeedChoice(t), 'NEXT_DAY', t);
  for (const t of ['2', 'same day', 'Same', 'today', 'now', 'r20']) assert.equal(parseSpeedChoice(t), 'SAME_DAY', t);
  for (const t of ['yes', '3', 'cancel', '']) assert.equal(parseSpeedChoice(t), null, t);
  assert.ok(!/—/.test(both.text + fresh.text + tight.text), 'no em dashes in customer copy');
});

test('the wiring: every channel passes the speed, the release runs at 08:00 SAST with a daily floor, the compliance check knows the money-received template', () => {
  const vercel = JSON.parse(read('../vercel.json'));
  assert.ok(vercel.crons.some((c) => c.path === '/api/cron/payout-release' && c.schedule === '0 6 * * *'), '06:00 UTC is 08:00 SAST');
  assert.match(read('../pages/api/cron/daily-vas-sync.js'), /releaseDuePayouts\(\{ take: 10 \}\)/);
  const cron = read('../pages/api/cron/payout-release.js');
  assert.match(cron, /isCronAuthed\(req\)/); assert.match(cron, /releaseDuePayouts\(/);
  assert.match(read('../lib/payout-chat.js'), /speed: speedFor\(data\.method, data\.speed\) \}\);/);
  assert.match(read('../lib/app-money.js'), /speed: speedFor\(method, speed\) \}\);/);
  assert.match(read('../pages/api/business/payout.js'), /speed: body\.speed \|\| null,/);
  assert.match(read('../pages/api/app/payout.js'), /speed: String\(b\.speed \|\| ''\)\.toUpperCase\(\) === 'SAME_DAY' \? 'SAME_DAY' : null/);
  assert.ok(TEMPLATE_ENVS.includes('WAPAY_TEMPLATE_MONEY_RECEIVED'));
  assert.match(read('../lib/payout-books.js'), /const OPEN = new Set\(\['PENDING', 'INIT', 'AWAITING_APPROVAL', 'SCHEDULED', 'REJECTING'\]\);/);
});

test('an approved next-business-day pay-out counts toward the R3,000 in 24 hours, so it cannot be stacked past the cap', async () => {
  const { paidOutLast24h } = await import('../lib/payout-rules.js');
  let seenWhere = null;
  const prisma = { providerRequest: { async findMany({ where }) { seenWhere = where; return [{ metadata: { amountCents: 200000 } }, { metadata: { amountCents: 50000 } }]; } } };
  assert.equal(await paidOutLast24h({ prisma, accountId: 'a1' }), 250000);
  assert.deepEqual(seenWhere.status, { in: ['SUCCESS', 'PENDING', 'SCHEDULED'] });
});
