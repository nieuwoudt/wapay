// The global pay-out hold (founder 2026-10-24, after the stolen-card cash-out of BUGLOG #140: "don't do
// any more payouts until I say we can"). One switch in the database stops every pay-out route before any
// rule, replay, ledger move or rail call. A frozen account keeps its own words. The hold fails closed, and
// every switch is logged with who and why. Getting paid and sends between members are not touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.WAPAY_INTERNAL_API_KEY ||= 'test-internal-key-for-proofs';
process.env.WAPAY_PIN_PROOF_SECRET ||= 'test-pin-proof-secret';
delete process.env.WAPAY_PAYOUT_KYC;

const { PAYOUT_HOLD_KEY, PAYOUT_HOLD_COPY, isPayoutHeld, readPayoutHold, setPayoutHold, parseHoldLog, _resetPayoutHoldCache } = await import('../lib/payout-hold.js');
const { requestPayout } = await import('../lib/payouts.js');
const { startWithdraw, handleWithdrawReply, executeWithdraw } = await import('../lib/payout-chat.js');
const { FROZEN_PAYOUT_COPY } = await import('../lib/payout-freeze.js');
const { opsPayout } = await import('../lib/ops-payout.js');
const { createFixtureDeps, FIXTURE_CELL } = await import('../lib/app-dev-fixture.js');
const { payoutContext, payoutCheck, payoutRequest, newIntentId } = await import('../lib/app-money.js');
const { webLine } = await import('../lib/app-portal.js');
const { issuePinProof } = await import('@wapay/auth/pin-proof');
const holdRoute = (await import('../pages/api/internal/payout-hold.js')).default;

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const ACC = 'cmvgbprub00holdabcdefghij';

/** processed_messages in memory: the marker row, the log rows, and how often the switch was read. */
function markerDb({ held = false, throws = false } = {}) {
  const rows = new Map();
  let seq = 0;
  const stamp = () => new Date(Date.parse('2026-10-24T00:00:00Z') + (seq += 1) * 1000);
  if (held) rows.set(PAYOUT_HOLD_KEY, { id: 'h0', waMessageId: PAYOUT_HOLD_KEY, processedAt: stamp() });
  let reads = 0;
  const processedMessage = {
    findUnique: async ({ where }) => { reads += 1; if (throws) throw new Error('db down'); return rows.get(where.waMessageId) || null; },
    findFirst: async ({ where }) => [...rows.values()].filter((r) => r.waMessageId.startsWith(where.waMessageId.startsWith)).sort((a, b) => b.processedAt - a.processedAt)[0] || null,
    upsert: async ({ where, create }) => { if (!rows.has(where.waMessageId)) rows.set(where.waMessageId, { id: `r${rows.size}`, ...create, processedAt: stamp() }); return rows.get(where.waMessageId); },
    deleteMany: async ({ where }) => ({ count: rows.delete(where.waMessageId) ? 1 : 0 }),
    create: async ({ data }) => { if (rows.has(data.waMessageId)) throw new Error('unique'); const r = { id: `r${rows.size}`, ...data, processedAt: stamp() }; rows.set(data.waMessageId, r); return r; },
  };
  return { db: { processedMessage }, rows, reads: () => reads };
}

test('the switch: no row is open, the marker row is held, a client without the table is never held, a failed read is held', async () => {
  _resetPayoutHoldCache();
  assert.equal(await isPayoutHeld({ prisma: {} }), false, 'a stub without the table (unit tests elsewhere)');
  assert.equal(await isPayoutHeld({ prisma: markerDb().db }), false);
  assert.equal(await isPayoutHeld({ prisma: markerDb({ held: true }).db }), true);
  assert.equal(await isPayoutHeld({ prisma: markerDb({ throws: true }).db }), true, 'fails closed');
  const r = await readPayoutHold({ prisma: markerDb({ throws: true }).db });
  assert.equal(r.held, true);
  assert.equal(r.readable, false);
});

test('the read is cached per database client for five seconds; the client that switches sees it at once', async () => {
  _resetPayoutHoldCache();
  const t0 = Date.parse('2026-10-24T00:00:00Z');
  const m = markerDb();
  assert.equal(await isPayoutHeld({ prisma: m.db, now: t0 }), false);
  assert.equal(await isPayoutHeld({ prisma: m.db, now: t0 + 1000 }), false);
  assert.equal(m.reads(), 1, 'one read inside the window');
  await setPayoutHold({ prisma: m.db, held: true, by: 'founder', reason: 'card fraud' });
  assert.equal(await isPayoutHeld({ prisma: m.db, now: t0 + 2000 }), true, 'the switching client sees it at once');
  const lagging = markerDb();
  assert.equal(await isPayoutHeld({ prisma: lagging.db, now: t0 }), false);
  lagging.rows.set(PAYOUT_HOLD_KEY, { id: 'x', waMessageId: PAYOUT_HOLD_KEY, processedAt: new Date() });
  assert.equal(await isPayoutHeld({ prisma: lagging.db, now: t0 + 4000 }), false, 'another instance may lag inside the window');
  assert.equal(await isPayoutHeld({ prisma: lagging.db, now: t0 + 6000 }), true, 'and catches up after it');
});

test('switching needs held, by and reason; every switch leaves a log row with who and why', async () => {
  const m = markerDb();
  await assert.rejects(setPayoutHold({ prisma: m.db, held: 'yes', by: 'founder', reason: 'r' }), { code: 'BAD_HELD' });
  await assert.rejects(setPayoutHold({ prisma: m.db, held: true, by: '', reason: 'r' }), { code: 'NEED_REASON' });
  await assert.rejects(setPayoutHold({ prisma: m.db, held: true, by: 'founder', reason: '   ' }), { code: 'NEED_REASON' });
  assert.equal(m.rows.size, 0, 'a refused switch writes nothing');
  const on = await setPayoutHold({ prisma: m.db, held: true, by: 'founder', reason: 'stolen cards | BUGLOG #140', now: new Date('2026-10-24T01:00:00Z') });
  assert.equal(on.held, true);
  assert.ok(on.since);
  assert.deepEqual(on.last, { at: '2026-10-24T01:00:00.000Z', held: true, by: 'founder', reason: 'stolen cards BUGLOG #140' });
  const again = await setPayoutHold({ prisma: m.db, held: true, by: 'founder', reason: 'still on', now: new Date('2026-10-24T02:00:00Z') });
  assert.equal(again.since, on.since, 'switching on twice keeps the first time');
  const off = await setPayoutHold({ prisma: m.db, held: false, by: 'founder', reason: 'fraud sorted', now: new Date('2026-10-30T08:00:00Z') });
  assert.equal(off.held, false);
  assert.equal(off.since, null);
  assert.deepEqual(off.last, { at: '2026-10-30T08:00:00.000Z', held: false, by: 'founder', reason: 'fraud sorted' });
  assert.equal([...m.rows.keys()].filter((k) => k.startsWith('payout-hold:log:')).length, 3);
  assert.equal(parseHoldLog('status-delivered:2026-10-24T01:00'), null);
  assert.equal(parseHoldLog('payout-hold:log:2026-10-24T01:00:00.000Z|maybe|x|y'), null);
});

function payoutDb({ frozen = false } = {}) {
  const touched = [];
  const trap = (name) => async () => { touched.push(name); throw new Error(`${name} must not run under the hold`); };
  const m = markerDb({ held: true });
  const prisma = {
    ...m.db,
    account: { findUnique: async () => ({ id: ACC, profile: frozen ? { payouts: { frozen: true, reason: 'card check' } } : {} }) },
    providerRequest: { findUnique: trap('replay'), findFirst: trap('providerRequest.findFirst'), findMany: trap('providerRequest.findMany'), create: trap('providerRequest.create'), count: trap('providerRequest.count') },
    journalEntry: { findMany: trap('journal'), findFirst: trap('journal'), findUnique: trap('journal') },
    journalLine: { findMany: trap('journalLine'), aggregate: trap('journalLine'), groupBy: trap('journalLine') },
    wallet: { findMany: trap('wallet'), findFirst: trap('wallet') },
    hold: { findUnique: trap('hold'), findMany: trap('hold') },
  };
  const client = { performPayout: trap('rail'), getActiveProviders: trap('providers'), getActiveProviderLimits: trap('limits') };
  const ledger = { postEntry: trap('ledger'), createHold: trap('ledger'), settleHold: trap('ledger'), releaseHold: trap('ledger') };
  return { prisma, client, ledger, touched };
}

test('requestPayout: the hold refuses before any rule, replay, ledger move or rail call; a frozen account still hears FROZEN', async () => {
  _resetPayoutHoldCache();
  process.env.WAPAY_PAYOUT_ENABLED = 'true';
  const args = { account: { id: ACC, waId: '27600000919', profile: {} }, intentId: 'pi-hold-1', method: 'PAYSHAP', amountCents: 5000, recipient: { mobile: '0760000000' } };
  const h = payoutDb();
  assert.deepEqual(await requestPayout({ prisma: h.prisma, client: h.client, ledger: h.ledger, ...args }), { ok: false, error: 'PAYOUT_HOLD' });
  assert.deepEqual(h.touched, []);
  const f = payoutDb({ frozen: true });
  const out = await requestPayout({ prisma: f.prisma, client: f.client, ledger: f.ledger, ...args });
  assert.equal(out.error, 'FROZEN');
  assert.deepEqual(f.touched, []);
});

test('the chat: withdraw does not start, a flow in progress ends at its next reply, the last step names the pause', async () => {
  _resetPayoutHoldCache();
  process.env.WAPAY_PAYOUT_ENABLED = 'true';
  const m = markerDb({ held: true });
  const prisma = { ...m.db, account: { findUnique: async () => ({ id: ACC, profile: {} }) } };
  const account = { id: ACC, waId: '27600000919', msisdn: '27600000919', displayName: 'Test', profile: { kyc: { status: 'VERIFIED', fullName: 'Test Person' } } };
  assert.deepEqual(await startWithdraw({ prisma, account, ask: {} }), { state: null, text: PAYOUT_HOLD_COPY });
  const frozenPrisma = { ...m.db, account: { findUnique: async () => ({ id: ACC, profile: { payouts: { frozen: true } } }) } };
  assert.deepEqual(await startWithdraw({ prisma: frozenPrisma, account, ask: {} }), { state: null, text: FROZEN_PAYOUT_COPY }, 'a frozen account keeps its own words');
  assert.deepEqual(await handleWithdrawReply({ prisma, account, state: 'PAYOUT_AMOUNT', data: { method: 'PAYSHAP' }, text: '200' }), { state: null, text: PAYOUT_HOLD_COPY });
  const save = await handleWithdrawReply({ prisma, account, state: 'PAYOUT_SAVE', data: {}, text: 'no' });
  assert.notEqual(save?.text, PAYOUT_HOLD_COPY, 'saving details after a pay-out the rail accepted is not a pay-out');
  const data = { intentId: 'wd-hold-1', amountCents: 20000, method: 'PAYSHAP', recipient: { mobile: '0760000000', id_number: '9001015009087' } };
  const last = await executeWithdraw({ prisma, account, data, pinProof: issuePinProof({ accountId: ACC, intentId: data.intentId, amountCents: data.amountCents }), deps: { requestPayout: async () => ({ ok: false, error: 'PAYOUT_HOLD' }), pinResetCoolOff: () => null, loadIdentity: async () => null } });
  assert.equal(last.text, PAYOUT_HOLD_COPY);
  assert.equal(last.state, null);
});

test('the web app: the pay-out screen shows the pause, and the check and the request refuse with 423 before the rail', async () => {
  _resetPayoutHoldCache();
  const deps = createFixtureDeps();
  const account = deps.prisma._tables.account.find((a) => a.msisdn === FIXTURE_CELL);
  assert.ok(account, 'the fixture account');
  const open = await payoutContext(deps, { account });
  assert.equal(open.frozen, null, 'no notice while pay-outs are open');
  await deps.prisma.processedMessage.create({ data: { waMessageId: PAYOUT_HOLD_KEY } });
  _resetPayoutHoldCache();
  const ctx = await payoutContext(deps, { account });
  assert.deepEqual(ctx.frozen, { line: webLine(PAYOUT_HOLD_COPY) });
  const check = await payoutCheck(deps, { account, method: 'PAYSHAP', amountCents: 5000 });
  assert.equal(check.error, 'PAYOUT_HOLD');
  assert.equal(check.status, 423);
  let railCalls = 0;
  const intentId = newIntentId('payout');
  const pin = await deps.verifyPIN({ accountId: account.id, pin: deps.fixture.pin, approves: { intentId, amountCents: 5000 } });
  assert.equal(pin.ok, true);
  const req = await payoutRequest({ ...deps, requestPayout: async () => { railCalls += 1; return { ok: true, status: 'SETTLED' }; } }, { account, intentId, method: 'PAYSHAP', amountCents: 5000, details: { mine: true }, proof: pin.proof });
  assert.equal(req.error, 'PAYOUT_HOLD', JSON.stringify(req));
  assert.equal(req.status, 423);
  assert.equal(railCalls, 0);
});

test('the operator pay-out: the hold is the first blocker in the dry run, and the live run calls nothing', async () => {
  const account = { id: 'acc1', waId: '27830000000', displayName: 'Thandi', profile: {} };
  const db = { account: { findUnique: async ({ where }) => (where.id === 'acc1' ? account : null) }, auditLog: { create: async () => ({}) } };
  let rail = 0;
  const d = {
    listDestinations: async () => [{ id: 'd1', method: 'PAYSHAP', label: 'TymeBank account •••595', timesUsed: 4 }],
    loadDestination: async () => ({ id: 'd1', method: 'PAYSHAP', account_number: '1234567595', branch_code: '678000', branch_name: 'TymeBank' }),
    loadIdentity: async () => ({ fullName: 'Ncamsile Jele', idType: 'RSAID', idNumber: '9001010000083' }),
    identityOnFile: async () => ({ fullName: 'Ncamsile Jele', idType: 'RSAID', idLast3: '083' }),
    touchDestination: async () => {},
    requestPayout: async () => { rail += 1; return { ok: true, status: 'SETTLED', reference: 'REF1' }; },
    balances: async () => ({ spendCents: 287240, cashCents: 0, totalCents: 287240 }),
    rules: async () => ({ ok: true }),
    freeze: async () => null,
    held: async () => true,
    float: async () => ({ balanceCents: 1765652 }),
    enabled: () => true,
    configured: () => true,
    audit: async () => {},
    send: async () => ({ ok: true }),
  };
  const dry = await opsPayout({ prisma: db, accountId: 'acc1', amountCents: 100000, deps: d });
  assert.equal(dry.ok, false);
  assert.equal(dry.blockers[0], 'PAYOUT_HOLD');
  assert.equal(dry.payoutHold, true);
  const live = await opsPayout({ prisma: db, accountId: 'acc1', amountCents: 100000, by: 'founder', reason: 'restriction period', dryRun: false, deps: d });
  assert.equal(live.ok, false);
  assert.equal(live.error, 'PAYOUT_HOLD');
  assert.equal(rail, 0);
});

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  return res;
}

test('the switch route: internal key required; held must be a boolean; by and reason required (refused before any write)', async () => {
  const key = process.env.WAPAY_INTERNAL_API_KEY;
  const noKey = fakeRes();
  // Bodies here are always refused or only ever switch the hold ON: the route uses the default client,
  // which reads production through Prisma's .env, so no regression can ever lift the real hold.
  await holdRoute({ method: 'POST', headers: {}, body: { held: 'x' } }, noKey);
  assert.equal(noKey.statusCode, 401);
  const badHeld = fakeRes();
  await holdRoute({ method: 'POST', headers: { 'x-internal-api-key': key }, body: { held: 'off', by: 'founder', reason: 'x' } }, badHeld);
  assert.equal(badHeld.statusCode, 400);
  assert.equal(badHeld.body.error, 'BAD_HELD');
  const noReason = fakeRes();
  await holdRoute({ method: 'POST', headers: { 'x-internal-api-key': key }, body: { held: true } }, noReason);
  assert.equal(noReason.statusCode, 400);
  assert.equal(noReason.body.error, 'NEED_REASON');
  const wrongMethod = fakeRes();
  await holdRoute({ method: 'DELETE', headers: { 'x-internal-api-key': key } }, wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
});

test('source locks: the order inside requestPayout, the readouts, the copy, and the test pin never used by application code', () => {
  const payouts = read('../lib/payouts.js');
  const body = payouts.slice(payouts.indexOf('export async function requestPayout('));
  const at = (s) => body.indexOf(s);
  assert.ok(at("error: 'FROZEN'") > 0, 'freeze');
  assert.ok(at("error: 'FROZEN'") < at("error: 'PAYOUT_HOLD'"), 'a frozen account hears its own words first');
  assert.ok(at("error: 'PAYOUT_HOLD'") < at('checkPayoutRules('), 'the hold comes before the rules');
  assert.ok(at('checkPayoutRules(') < at('providerRequest.findUnique'), 'and so before the replay');
  assert.ok(at('providerRequest.findUnique') < at('performPayout('), 'and the rail');
  assert.match(read('../pages/api/internal/flags.js'), /payoutHold: hold \?/);
  assert.match(read('../pages/api/internal/payout-hold.js'), /requireInternalAuth\(req, res\)/);
  assert.match(read('../pages/api/business/payout.js'), /'PAYOUT_HOLD'\]\.includes\(out\.error\) \? 503/);
  assert.match(read('../pages/business/index.js'), /r\.error === 'PAYOUT_HOLD' \? 'Pay-outs are paused while we run safety checks\./);
  assert.ok(!/—/.test(PAYOUT_HOLD_COPY), 'no em dash');
  assert.ok(!/\b(tomorrow|today|hours?|minutes?|soon|shortly|within|short while)\b/i.test(PAYOUT_HOLD_COPY), 'no time promise');
  assert.match(PAYOUT_HOLD_COPY, /safe in your WaPay balance/);
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const dir of ['lib', 'pages']) {
    for (const f of readdirSync(`${root}${dir}`, { recursive: true })) {
      if (!/\.(m?js|tsx?)$/.test(f)) continue;
      const src = readFileSync(`${root}${dir}/${f}`, 'utf8');
      if (`${dir}/${f}` === 'lib/payout-hold.js') continue;
      assert.ok(!src.includes('_pinPayoutHoldForTests'), `${dir}/${f} must never pin the hold`);
    }
  }
});
