/**
 * PayCentral client (lib/paycentral.js), docs/CARDS.md 0.9 to 0.11.
 *
 * One whitelisted address: a call is retried only when it never reached PayCentral (its
 * connection never connected, or a READ got a 403 without PayCentral's JSON). A money or state
 * call goes once per connection, after a door check on that same connection; anything unclear
 * after it was sent is 'unknown' or TRANSPORT_INDETERMINATE, never a resend. Redirects are not
 * followed. Card numbers and security codes never leave the module or reach a log.
 * Review 2026-11-16 found the cases marked "review": each is locked here.
 * Values that look like credentials are built at runtime (tests/no-committed-credentials).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProxyAgent } from 'undici';

import {
  PayCentralClient,
  _resetPayCentralState,
  isDoorRefusalResponse,
  isTunnelRefusal,
  writeOutcome,
  redactPayCentral,
  safeMessage,
  loadReference,
  centsToRands,
  randsToCents,
  statementDate,
  jwtExpiryMs,
  payCentralConfigured,
} from '../lib/paycentral.js';

const LOGIN = { email: 'test-api@example.com', password: ['test', 'pw', 'value'].join('-') };
const fakeJwt = (expSec) => ['h', Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url'), 's'].join('.');
const futureToken = () => fakeJwt(Math.floor(Date.now() / 1000) + 3600);
const PAN = ['5192', '6054', '4733', '6762'].join('');
const PAN_GROUPED = ['5192', '6054', '4733', '6762'].join(' ');
const CVV = String(90886);

const resp = (status, body) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const ok = (extra = {}) => resp(200, { status: 'Success', ...extra });
const notFoundCard = () => resp(200, { status: 'Failure', message: 'Could not find the card' });
const LOGIN_OK = () => resp(200, { token: futureToken() });
// Script steps the fake understands besides responses:
const REFUSE = Symbol('connect refused before any socket came up');
const RESET = Symbol('socket reset after connecting');

/** A fake PayCentral. Each path has a queue of steps; the last step repeats. */
function fakePayCentral(script, config = {}) {
  const calls = [];
  let connections = 0;
  const connectionFactory = () => {
    const state = { connects: 0, connectFailures: 0 };
    const id = ++connections;
    return { dispatcher: { id, state, close: () => {} }, state };
  };
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    const st = init.dispatcher.state;
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), body: init.body ? JSON.parse(init.body) : null, conn: init.dispatcher.id, redirect: init.redirect });
    const queue = script[u.pathname];
    if (!queue || queue.length === 0) throw new Error(`unexpected call ${u.pathname}`);
    const step = queue.length > 1 ? queue.shift() : queue[0];
    if (step === REFUSE) {
      st.connectFailures += 1;
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    }
    if (st.connects === 0) st.connects = 1;
    if (step === RESET) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'ECONNRESET' }) });
    return typeof step === 'function' ? step() : step;
  };
  const client = new PayCentralClient({ ...LOGIN, baseUrl: 'https://staging-api.example.test', fetchFn, connectionFactory, sleep: async () => {}, ...config });
  const count = (path) => calls.filter((c) => c.path === path).length;
  return { client, calls, count, connections: () => connections };
}

const captureLogs = async (fn) => {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(String(s));
  try {
    return { result: await fn(), logs: lines.join('\n') };
  } finally {
    console.log = orig;
  }
};

test.beforeEach(() => _resetPayCentralState());

// --- The door ---------------------------------------------------------------

test('a login refused while connecting is retried on a fresh connection each time', async () => {
  const { client, count, connections } = fakePayCentral({
    '/authenticate': [REFUSE, REFUSE, LOGIN_OK()],
    '/card/balance': [ok({ balance: '25' })],
  });
  const r = await client.cardBalance('591');
  assert.equal(r.balanceCents, 2500);
  assert.equal(count('/authenticate'), 3);
  assert.equal(connections(), 4, 'one connection per attempt');
});

test('a read refused with a firewall 403 is retried; a PayCentral 403 is an answer', async () => {
  const { client, count } = fakePayCentral({
    '/authenticate': [LOGIN_OK()],
    '/card/balance': [resp(403, '<html>Forbidden</html>'), resp(403, { status: 'Failure', message: 'Not your card' })],
  });
  const r = await client.cardBalance('591');
  assert.equal(r.ok, false);
  assert.equal(count('/card/balance'), 2);
  assert.equal(isDoorRefusalResponse(403, null), true);
  assert.equal(isDoorRefusalResponse(403, { Status: 'Failure' }), false, 'keys in any case');
  assert.equal(isDoorRefusalResponse(403, { success: false }), false);
});

test('refusals beyond the attempt limit end in DOOR_REFUSED with the count', async () => {
  const { client } = fakePayCentral({ '/authenticate': [REFUSE] });
  await assert.rejects(client.authenticate(), (e) => e.code === 'DOOR_REFUSED' && e.attempts === 6);
});

test('a load: door check first, then the load once, on the same connection', async () => {
  const { client, calls, count } = fakePayCentral({
    '/authenticate': [LOGIN_OK()],
    '/card/balance': [REFUSE, resp(403, '<html>denied</html>'), notFoundCard()],
    '/card/load': [ok({ message: 'Card Loaded successfully' })],
  });
  const r = await client.loadCard({ cardIdentifier: '591', amountCents: 10000, idemKey: 'card-load-a' });
  assert.equal(r.outcome, 'loaded');
  assert.equal(r.reference, loadReference('card-load-a'));
  assert.equal(count('/card/load'), 1, 'sent once');
  const load = calls.find((c) => c.path === '/card/load');
  const lastCheck = calls.filter((c) => c.path === '/card/balance').at(-1);
  assert.equal(load.conn, lastCheck.conn, 'the load rides the connection whose door check got through');
  assert.equal(load.redirect, 'manual');
});

test('review: a 403 page after a load was sent is never a door refusal: outcome unknown, sent once', async () => {
  const { client, count } = fakePayCentral({
    '/authenticate': [LOGIN_OK()],
    '/card/balance': [notFoundCard()],
    '/card/load': [resp(403, '<html>blocked by response inspection</html>')],
  });
  const r = await client.loadCard({ cardIdentifier: '591', amountCents: 5000, idemKey: 'card-load-b' });
  assert.equal(r.outcome, 'unknown');
  assert.equal(count('/card/load'), 1);
});

test('review: a redirect after a load is never followed or resent: indeterminate with the reference', async () => {
  const { client, count } = fakePayCentral({
    '/authenticate': [LOGIN_OK()],
    '/card/balance': [notFoundCard()],
    '/card/load': [resp(303, '')],
  });
  await assert.rejects(client.loadCard({ cardIdentifier: '591', amountCents: 5000, idemKey: 'card-load-c' }), (e) => {
    assert.equal(e.code, 'TRANSPORT_INDETERMINATE');
    assert.equal(e.indeterminate, true);
    assert.equal(e.reference, loadReference('card-load-c'));
    return true;
  });
  assert.equal(count('/card/load'), 1);
});

test('a load reset after connecting is indeterminate, never resent', async () => {
  const { client, count } = fakePayCentral({
    '/authenticate': [LOGIN_OK()],
    '/card/balance': [notFoundCard()],
    '/card/load': [RESET],
  });
  await assert.rejects(client.loadCard({ cardIdentifier: '591', amountCents: 5000, idemKey: 'k-reset' }), (e) => e.code === 'TRANSPORT_INDETERMINATE' && e.indeterminate === true);
  assert.equal(count('/card/load'), 1);
});

test('review: a 5xx on a load is indeterminate and says so', async () => {
  const { client, count } = fakePayCentral({
    '/authenticate': [LOGIN_OK()],
    '/card/balance': [notFoundCard()],
    '/card/load': [resp(502, '<html>bad gateway</html>')],
  });
  await assert.rejects(client.loadCard({ cardIdentifier: '591', amountCents: 5000, idemKey: 'k-5xx' }), (e) => e.code === 'TRANSPORT_INDETERMINATE' && e.indeterminate === true);
  assert.equal(count('/card/load'), 1);
});

test('a load whose own reconnect failed before connecting is safely retried on a new connection', async () => {
  const { client, calls, count } = fakePayCentral({
    '/authenticate': [LOGIN_OK()],
    '/card/balance': [notFoundCard()],
    '/card/load': [REFUSE, ok({ message: 'Card Loaded successfully' })],
  });
  const r = await client.loadCard({ cardIdentifier: '591', amountCents: 5000, idemKey: 'k-reconnect' });
  assert.equal(r.outcome, 'loaded');
  assert.equal(count('/card/load'), 2, 'the first never left: its socket never connected');
  const loads = calls.filter((c) => c.path === '/card/load');
  assert.notEqual(loads[0].conn, loads[1].conn);
  assert.equal(loads[0].body.reference_no, loads[1].body.reference_no);
});

test('review: unreadable or unexpected answers to a write are unknown, only a plain failure is declined', () => {
  assert.equal(writeOutcome(null), 'unknown', 'non-JSON body');
  assert.equal(writeOutcome({ status: 'Successful' }), 'unknown');
  assert.equal(writeOutcome({ status: 'Failure', message: 'Card must be in allocated state to load.' }), 'declined');
  assert.equal(writeOutcome({ status: 'Failure', message: 'Duplicate reference number' }), 'unknown', 'may mean done already');
  assert.equal(writeOutcome({ Status: 'SUCCESS' }), 'ok');
  assert.equal(writeOutcome([1, 2]), 'unknown');
});

test('a 401 on a write logs in again and sends it once more (it was rejected)', async () => {
  const { client, count } = fakePayCentral({
    '/authenticate': [LOGIN_OK()],
    '/card/balance': [notFoundCard()],
    '/card/load': [resp(401, { status: 'Failure', message: 'Unauthorized' }), ok({ message: 'Card Loaded successfully' })],
  });
  const r = await client.loadCard({ cardIdentifier: '591', amountCents: 5000, idemKey: 'k-401' });
  assert.equal(r.outcome, 'loaded');
  assert.equal(count('/card/load'), 2);
  assert.equal(count('/authenticate'), 2);
});

// --- checkReference -----------------------------------------------------------

test('checkReference: not found, loaded (matching card and amount), declined, and the unclear cases', async () => {
  const run = async (body, opts) => {
    _resetPayCentralState();
    const { client } = fakePayCentral({ '/authenticate': [LOGIN_OK()], '/get/auditlog': [resp(200, body)] });
    return client.checkReference('123456789012', opts);
  };
  assert.equal((await run({ status: 'Failure', message: { success: false, message: 'Reference Number Not Found' } })).outcome, 'not_found');
  const loaded = { status: 'Success', message: { request: { cardIdentifier: '591', amount: '50' }, response: { success: 'true', message: 'Card Loaded successfully' }, success: true } };
  assert.equal((await run(loaded, { cardIdentifier: '591', amountCents: 5000 })).outcome, 'loaded');
  assert.equal((await run(loaded, { cardIdentifier: '592', amountCents: 5000 })).outcome, 'unknown', 'a different card');
  assert.equal((await run(loaded, { cardIdentifier: '591', amountCents: 9900 })).outcome, 'unknown', 'a different amount');
  const asString = { status: 'Success', message: JSON.stringify(loaded.message) };
  assert.equal((await run(asString, { cardIdentifier: '591' })).outcome, 'loaded', 'review: a record held as a JSON string');
  const specExample = { status: 'Success', message: { request: { 'card Identifier': PAN }, response: { success: 'true', message: 'Could not find the card' }, success: true } };
  assert.equal((await run(specExample)).outcome, 'unknown', "the spec's contradictory example");
  assert.equal((await run({ status: 'Success', message: [1] })).outcome, 'unknown', 'review: an array');
  assert.equal((await run({ status: 'Success', message: { request: {}, response: { success: false, message: 'Card must be in allocated state to load.' } } })).outcome, 'declined');
});

// --- Tokens -------------------------------------------------------------------

test('the token is cached, renewed near expiry, and concurrent calls share one login', async () => {
  const { client, count } = fakePayCentral({ '/authenticate': [LOGIN_OK()], '/card/balance': [ok({ balance: '1' })] });
  await Promise.all([client.cardBalance('1'), client.cardBalance('2'), client.cardBalance('3')]);
  assert.equal(count('/authenticate'), 1);

  _resetPayCentralState();
  const soon = fakePayCentral({ '/authenticate': [resp(200, { token: fakeJwt(Math.floor(Date.now() / 1000) + 30) })], '/card/balance': [ok({ balance: '1' })] });
  await soon.client.cardBalance('1');
  await soon.client.cardBalance('1');
  assert.equal(soon.count('/authenticate'), 2);
});

test('a failed login is AUTH_FAILED, without PayCentral text or the password in message or logs', async () => {
  const { logs } = await captureLogs(async () => {
    const { client } = fakePayCentral({ '/authenticate': [resp(200, { status: 'Failure', message: `Invalid Credentials for ${LOGIN.email}` })] });
    await assert.rejects(client.authenticate(), (e) => e.code === 'AUTH_FAILED' && !e.message.includes(LOGIN.email));
  });
  assert.ok(!logs.includes(LOGIN.password));
});

// --- Card data ------------------------------------------------------------------

test('virtualAllocate hands back seq_no, last four and expiry: never the card number or security code', async () => {
  const { result, logs } = await captureLogs(async () => {
    const { client, calls } = fakePayCentral({
      '/authenticate': [LOGIN_OK()],
      '/card/balance': [notFoundCard()],
      '/card/virtualAllocate': [ok({ message: `Card ${PAN_GROUPED} issued, CVV ${CVV}`, card_no: PAN, seq_no: '591', expiry_date: '2029-07-20', secure_code: Number(CVV) })],
    });
    const r = await client.virtualAllocate({ cellphoneNumber: '27820000000', firstName: 'Test', lastName: 'Holder', idOrPassportNumber: 'TESTPASSPORT1' });
    assert.equal(calls.find((c) => c.path === '/card/virtualAllocate').body.loadAmount, '0');
    return r;
  });
  assert.deepEqual(result, { outcome: 'created', ok: true, message: 'Card created', seqNo: '591', last4: PAN.slice(-4), expiryDate: '2029-07-20' });
  const text = JSON.stringify(result) + logs;
  assert.ok(!text.includes(PAN) && !text.includes(PAN_GROUPED), 'no card number');
  assert.ok(!text.includes(CVV), 'no security code');
});

test('review: a failure message carrying a card number comes back masked', async () => {
  const { client } = fakePayCentral({
    '/authenticate': [LOGIN_OK()],
    '/card/balance': [notFoundCard()],
    '/card/virtualAllocate': [resp(200, { status: 'Failure', message: `Card ${PAN_GROUPED} could not be issued` })],
  });
  const r = await client.virtualAllocate({ cellphoneNumber: '27820000000', firstName: 'T' });
  assert.equal(r.outcome, 'declined');
  assert.ok(!r.message.includes(PAN_GROUPED));
});

test('review: bad load amounts on virtualAllocate are refused, not silently zero', async () => {
  const { client } = fakePayCentral({ '/authenticate': [LOGIN_OK()] });
  await assert.rejects(client.virtualAllocate({ cellphoneNumber: '27820000000', firstName: 'T', loadCents: -100 }), { code: 'BAD_INPUT' });
  await assert.rejects(client.virtualAllocate({ cellphoneNumber: '27820000000', firstName: 'T', loadCents: Number.NaN }), { code: 'BAD_INPUT' });
});

test('cardInfo returns a fixed safe set, never the raw record', async () => {
  const { client } = fakePayCentral({
    '/authenticate': [LOGIN_OK()],
    '/card/info': [ok({ cardNumber: PAN, firstName: 'Steve', idOrPassport: '9876543210', emailId: 'x@example.com', cellPhoneNumber: '27112340859', cardStatusId: '1', currentbalance: 0 })],
  });
  const r = await client.cardInfo('591');
  assert.deepEqual(r, { ok: true, statusId: '1', last4: PAN.slice(-4), balanceCents: 0 });
});

test('review: redaction covers dashed and grouped card numbers, numbers, JSON in strings and more keys', () => {
  const out = redactPayCentral({
    card_no: PAN.replace(/(\d{4})(?=\d)/g, '$1-'),
    cardNo: Number(PAN),
    note: `paid with ${PAN_GROUPED}, call 082 123 4567`,
    secureCode: CVV,
    Authorization: 'Bearer abc',
    cellNumber: '27820000000',
    mobile: '0821234567',
    'Email Address': 'holder@example.com',
    firstName: 'Steve',
    addressLine1: '1 Main Road',
    idDocument: 'base64-content',
    record: JSON.stringify({ cellPhoneNumber: '27112340859', secure_code: CVV, idOrPassport: 'A1234567' }),
    seq_no: '591',
    when: '2021-07-20 17:39:15',
  });
  const text = JSON.stringify(out);
  for (const secret of [PAN, PAN_GROUPED, CVV, 'Bearer abc', '27820000000', '0821234567', '082 123 4567', 'holder@example.com', 'Steve', '1 Main Road', 'base64-content', '27112340859', 'A1234567']) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.equal(out.seq_no, '591');
  assert.equal(out.when, '2021-07-20 17:39:15', 'dates survive');
  assert.equal(safeMessage(`card ${PAN}`), `card •••${PAN.slice(-4)}`);
});

// --- Pure helpers ---------------------------------------------------------------

test('loadReference: deterministic, 12 digits, no leading zero, lengths that look like timestamps refused', () => {
  const a = loadReference('card-load-1');
  assert.match(a, /^[1-9]\d{11}$/);
  assert.equal(loadReference('card-load-1'), a);
  assert.notEqual(loadReference('card-load-2'), a);
  assert.match(loadReference('card-load-1', 15), /^[1-9]\d{14}$/);
  assert.throws(() => loadReference('k', 13), { code: 'BAD_INPUT' });
  assert.throws(() => loadReference('k', 10), { code: 'BAD_INPUT' });
  assert.throws(() => loadReference(''), { code: 'BAD_INPUT' });
});

test('amounts: whole rands until cents are confirmed; safe integers only; parsing without float math', () => {
  assert.equal(centsToRands(10000), '100');
  assert.throws(() => centsToRands(1250), { code: 'AMOUNT_NOT_WHOLE_RANDS' });
  assert.equal(centsToRands(1250, { wholeRands: false }), '12.50');
  assert.equal(centsToRands(5, { wholeRands: false }), '0.05');
  assert.throws(() => centsToRands(0), { code: 'BAD_INPUT' });
  assert.throws(() => centsToRands(1e21), { code: 'BAD_INPUT' });
  assert.equal(randsToCents('52.00'), 5200);
  assert.equal(randsToCents(25.4), 2540);
  assert.equal(randsToCents('25,40'), 2540, 'review: decimal comma');
  assert.equal(randsToCents('1,250.00'), 125000);
  assert.ok(Object.is(randsToCents('-0.00'), 0), 'review: no negative zero');
  assert.equal(randsToCents('-0.10'), -10);
  assert.equal(randsToCents('abc'), null);
  assert.throws(() => statementDate('not a date'), { code: 'BAD_INPUT' });
});

test('a proxy refusing the tunnel is recognised as never sent', () => {
  assert.equal(isTunnelRefusal(Object.assign(new Error('fetch failed'), { cause: new Error('Proxy response (403) !== 200 when HTTP Tunneling') })), true);
  assert.equal(isTunnelRefusal(new Error('other side closed')), false);
});

test('one fixed egress: one shared proxy connection; a bad proxy URL is refused without echoing it', () => {
  const client = new PayCentralClient({ ...LOGIN, egressProxy: 'http://proxy.example.test:8080' });
  const a = client._connection();
  const b = client._connection();
  assert.ok(a.dispatcher instanceof ProxyAgent);
  assert.equal(a.dispatcher, b.dispatcher);
  assert.equal(a.shared, true);
  const secretish = ['http://user', 'hunter2-test@:bad'].join(':');
  assert.throws(() => new PayCentralClient({ ...LOGIN, egressProxy: secretish }), (e) => e.code === 'CONFIG' && !e.message.includes('hunter2-test'));
  const direct = new PayCentralClient({ ...LOGIN })._connection();
  assert.equal(direct.shared, false);
  assert.deepEqual(direct.state, { connects: 0, connectFailures: 0 });
  direct.dispatcher.close();
  _resetPayCentralState();
});

test('review: a call has one time budget; past it nothing more is sent', async () => {
  const { client, count } = fakePayCentral({ '/authenticate': [LOGIN_OK()] }, { callBudgetMs: 0 });
  await assert.rejects(client.authenticate(), { code: 'TRANSPORT_FAILED' });
  assert.equal(count('/authenticate'), 0);
});

test('configuration: no login, no client; the check reports booleans', () => {
  assert.throws(() => new PayCentralClient({ email: '', password: '' }), { code: 'CONFIG' });
  assert.equal(payCentralConfigured({}), false);
  assert.equal(payCentralConfigured({ PAYCENTRAL_API_EMAIL: 'a', PAYCENTRAL_API_PASSWORD: 'b' }), true);
  assert.equal(jwtExpiryMs('not-a-jwt'), null);
});

test('the probe needs the internal key, stays read-only and bounded, and never resets shared state', () => {
  const src = readFileSync(new URL('../pages/api/internal/paycentral-probe.js', import.meta.url), 'utf8');
  assert.match(src, /x-internal-api-key/);
  assert.match(src, /status\(401\)/);
  assert.doesNotMatch(src, /loadCard|virtualAllocate|allocatePhysical|freezeCard|unfreezeCard/, 'no card or money call');
  assert.doesNotMatch(src, /_resetPayCentralState/, 'review: never closes connections other requests use');
  assert.match(src, /WALL_BUDGET_MS/);
  assert.match(src, /readAttempts: 1/);
  assert.match(src, /password: !!process\.env\.PAYCENTRAL_API_PASSWORD/);
});
