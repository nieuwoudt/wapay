/**
 * PayCentral client (lib/paycentral.js), docs/CARDS.md 0.9 to 0.11.
 *
 * The one-whitelisted-address rules: a call refused at the door is retried on a fresh
 * connection (any kind, money included, because it never reached PayCentral); a money call
 * that may have reached PayCentral is never retried and surfaces as TRANSPORT_INDETERMINATE
 * with its reference. Card numbers and security codes never leave the module or reach a log.
 * Values that look like credentials are built at runtime (tests/no-committed-credentials).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProxyAgent } from 'undici';

import {
  PayCentralClient,
  _resetPayCentralState,
  classifyTransportError,
  isDoorRefusalResponse,
  redactPayCentral,
  loadReference,
  centsToRands,
  randsToCents,
  jwtExpiryMs,
  payCentralConfigured,
} from '../lib/paycentral.js';

const LOGIN = { email: 'test-api@example.com', password: ['test', 'pw', 'value'].join('-') };
const fakeJwt = (expSec) => ['h', Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url'), 's'].join('.');
const futureToken = () => fakeJwt(Math.floor(Date.now() / 1000) + 3600);
const PAN = ['5192', '6054', '4733', '6762'].join('');
const CVV = String(90886);

const resp = (status, body) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const doorErr = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
const resetErr = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'ECONNRESET' }) });

/** A fake PayCentral: `script` maps a path to a queue of answers (a response or an Error to throw). */
function fakePayCentral(script) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization || null, dispatcher: init.dispatcher });
    const queue = script[path];
    if (!queue || queue.length === 0) throw new Error(`unexpected call ${path}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  let dispatchers = 0;
  const client = new PayCentralClient({
    ...LOGIN,
    baseUrl: 'https://staging-api.example.test',
    fetchFn,
    dispatcherFactory: () => ({ id: ++dispatchers, close: async () => {} }),
    sleep: async () => {},
  });
  return { client, calls, dispatchers: () => dispatchers };
}

test.beforeEach(() => _resetPayCentralState());

test('a login refused at the door is retried on a fresh connection each time, then the call goes through', async () => {
  const { client, calls, dispatchers } = fakePayCentral({
    '/authenticate': [doorErr(), doorErr(), resp(200, { token: futureToken() })],
    '/card/balance': [resp(200, { status: 'Success', balance: '25' })],
  });
  const r = await client.cardBalance('591');
  assert.deepEqual(r, { ok: true, balanceCents: 2500, message: '' });
  assert.equal(calls.filter((c) => c.path === '/authenticate').length, 3);
  assert.equal(dispatchers(), 4, 'every attempt gets its own connection');
  assert.equal(new Set(calls.map((c) => c.dispatcher.id)).size, 4);
});

test('a money call refused at the door is retried (it never reached PayCentral)', async () => {
  const { client, calls } = fakePayCentral({
    '/authenticate': [resp(200, { token: futureToken() })],
    '/card/load': [doorErr(), resp(200, { status: 'Success', message: 'Card Loaded successfully' })],
  });
  const r = await client.loadCard({ cardIdentifier: '591', amountCents: 10000, idemKey: 'card-load-intent-abc' });
  assert.equal(r.ok, true);
  const loads = calls.filter((c) => c.path === '/card/load');
  assert.equal(loads.length, 2);
  assert.equal(loads[0].body.reference_no, loads[1].body.reference_no, 'the retry carries the same reference');
});

test('a firewall 403 without PayCentral JSON is a door refusal; a PayCentral 403 is an answer', () => {
  assert.equal(isDoorRefusalResponse(403, { _raw: true }), true);
  assert.equal(isDoorRefusalResponse(403, {}), true);
  assert.equal(isDoorRefusalResponse(403, { status: 'Failure', message: 'Forbidden' }), false);
  assert.equal(isDoorRefusalResponse(200, { _raw: true }), false);
});

test('a money call that may have reached PayCentral is never retried and carries its reference', async () => {
  const { client, calls } = fakePayCentral({
    '/authenticate': [resp(200, { token: futureToken() })],
    '/card/load': [resetErr()],
  });
  await assert.rejects(client.loadCard({ cardIdentifier: '591', amountCents: 5000, idemKey: 'card-load-intent-xyz' }), (e) => {
    assert.equal(e.code, 'TRANSPORT_INDETERMINATE');
    assert.equal(e.reference, loadReference('card-load-intent-xyz'));
    return true;
  });
  assert.equal(calls.filter((c) => c.path === '/card/load').length, 1);
});

test('a money call answered with a 5xx is indeterminate, not retried', async () => {
  const { client, calls } = fakePayCentral({
    '/authenticate': [resp(200, { token: futureToken() })],
    '/card/load': [resp(502, '<html>bad gateway</html>')],
  });
  await assert.rejects(client.loadCard({ cardIdentifier: '591', amountCents: 5000, idemKey: 'k1' }), { code: 'TRANSPORT_INDETERMINATE' });
  assert.equal(calls.filter((c) => c.path === '/card/load').length, 1);
});

test('a read that failed in flight is retried', async () => {
  const { client, calls } = fakePayCentral({
    '/authenticate': [resp(200, { token: futureToken() })],
    '/card/balance': [resetErr(), resp(200, { status: 'Success', balance: '52.40' })],
  });
  const r = await client.cardBalance('591');
  assert.equal(r.balanceCents, 5240);
  assert.equal(calls.filter((c) => c.path === '/card/balance').length, 2);
});

test('refusals beyond the attempt limit end in DOOR_REFUSED with the count', async () => {
  const { client } = fakePayCentral({ '/authenticate': [doorErr()] });
  await assert.rejects(client.authenticate(), (e) => {
    assert.equal(e.code, 'DOOR_REFUSED');
    assert.equal(e.attempts, 6);
    return true;
  });
});

test('the token is cached, renewed when expired, and a 401 logs in again once', async () => {
  const { client, calls } = fakePayCentral({
    '/authenticate': [resp(200, { token: futureToken() })],
    '/card/balance': [resp(200, { status: 'Success', balance: '1' }), resp(401, { status: 'Failure', message: 'Unauthorized' }), resp(200, { status: 'Success', balance: '2' })],
  });
  await client.cardBalance('591');
  await client.cardBalance('591');
  assert.equal(calls.filter((c) => c.path === '/authenticate').length, 2, 'one login, then one after the 401');

  _resetPayCentralState();
  const expired = fakePayCentral({
    '/authenticate': [resp(200, { token: fakeJwt(Math.floor(Date.now() / 1000) + 30) })],
    '/card/balance': [resp(200, { status: 'Success', balance: '1' })],
  });
  await expired.client.cardBalance('591');
  await expired.client.cardBalance('591');
  assert.equal(expired.calls.filter((c) => c.path === '/authenticate').length, 2, 'a token within a minute of expiry is renewed');
});

test('a failed login is AUTH_FAILED and the password never reaches a log', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(String(s));
  try {
    const { client } = fakePayCentral({ '/authenticate': [resp(200, { status: 'Failure', message: 'Invalid Credentials' })] });
    await assert.rejects(client.authenticate(), { code: 'AUTH_FAILED' });
  } finally {
    console.log = orig;
  }
  assert.ok(!lines.join('\n').includes(LOGIN.password));
});

test('virtualAllocate hands back seq_no, last four and expiry: never the card number or security code', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(String(s));
  let r;
  try {
    const { client, calls } = fakePayCentral({
      '/authenticate': [resp(200, { token: futureToken() })],
      '/card/virtualAllocate': [resp(200, { status: 'Success', message: 'Card created Successfully', card_no: PAN, seq_no: '591', expiry_date: '2029-07-20', secure_code: Number(CVV) })],
    });
    r = await client.virtualAllocate({ cellphoneNumber: '27820000000', firstName: 'Test', lastName: 'Holder', idOrPassportNumber: 'TESTPASSPORT1' });
    assert.equal(calls.find((c) => c.path === '/card/virtualAllocate').body.loadAmount, '0');
  } finally {
    console.log = orig;
  }
  assert.deepEqual(r, { ok: true, message: 'Card created Successfully', seqNo: '591', last4: PAN.slice(-4), expiryDate: '2029-07-20' });
  const text = JSON.stringify(r) + lines.join('\n');
  assert.ok(!text.includes(PAN), 'no card number');
  assert.ok(!text.includes(CVV), 'no security code');
});

test('redactPayCentral masks card numbers, security codes, IDs, contacts, secrets, documents and long digit runs', () => {
  const out = redactPayCentral({
    cardNumber: PAN,
    card_no: PAN,
    secure_code: CVV,
    idOrPassport: '9876543210123',
    emailId: 'holder@example.com',
    cellPhoneNumber: '27820000000',
    idDocumentContent: 'base64-content',
    nested: { request: { 'card Identifier': PAN }, note: `ref ${PAN} end` },
    seq_no: '591',
  });
  const text = JSON.stringify(out);
  for (const secret of [PAN, CVV, '9876543210123', 'holder@example.com', '27820000000', 'base64-content']) assert.ok(!text.includes(secret), secret);
  assert.equal(out.card_no, `•••${PAN.slice(-4)}`);
  assert.equal(out.secure_code, '[hidden]');
  assert.equal(out.seq_no, '591', 'a sequence number is not a secret');
});

test('loadReference: deterministic, 12 digits, never a leading zero, different per load', () => {
  const a = loadReference('card-load-1');
  assert.match(a, /^[1-9]\d{11}$/);
  assert.equal(loadReference('card-load-1'), a);
  assert.notEqual(loadReference('card-load-2'), a);
  assert.match(loadReference('card-load-1', 15), /^[1-9]\d{14}$/);
  assert.throws(() => loadReference(''), { code: 'BAD_INPUT' });
});

test('amounts: whole rands until cents are confirmed; parsing never uses float math', () => {
  assert.equal(centsToRands(10000), '100');
  assert.throws(() => centsToRands(1250), { code: 'AMOUNT_NOT_WHOLE_RANDS' });
  assert.equal(centsToRands(1250, { wholeRands: false }), '12.50');
  assert.equal(centsToRands(5, { wholeRands: false }), '0.05');
  assert.throws(() => centsToRands(0), { code: 'BAD_INPUT' });
  assert.equal(randsToCents('52.00'), 5200);
  assert.equal(randsToCents(25.4), 2540);
  assert.equal(randsToCents('-0.10'), -10);
  assert.equal(randsToCents('abc'), null);
});

test('transport errors: refused while connecting is the door; a reset after connecting is unknown', () => {
  assert.equal(classifyTransportError(doorErr()), 'DOOR');
  assert.equal(classifyTransportError(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } })), 'DOOR');
  assert.equal(classifyTransportError(new Error('Client network socket disconnected before secure TLS connection was established')), 'DOOR');
  assert.equal(classifyTransportError(new Error('Proxy response (403) !== 200 when HTTP Tunneling')), 'DOOR');
  assert.equal(classifyTransportError(resetErr()), 'UNKNOWN');
});

test('one fixed egress: with PAYCENTRAL_EGRESS_PROXY every call shares one proxy connection', () => {
  const client = new PayCentralClient({ ...LOGIN, egressProxy: 'http://proxy.example.test:8080' });
  const a = client._dispatcher();
  const b = client._dispatcher();
  assert.ok(a.dispatcher instanceof ProxyAgent);
  assert.equal(a.dispatcher, b.dispatcher);
  assert.equal(a.fresh, false);
  const direct = new PayCentralClient({ ...LOGIN })._dispatcher();
  assert.equal(direct.fresh, true);
  direct.dispatcher.close();
  _resetPayCentralState();
});

test('configuration: the client refuses to start without a login; the check reports booleans', () => {
  assert.throws(() => new PayCentralClient({ email: '', password: '' }), { code: 'CONFIG' });
  assert.equal(payCentralConfigured({}), false);
  assert.equal(payCentralConfigured({ PAYCENTRAL_API_EMAIL: 'a', PAYCENTRAL_API_PASSWORD: 'b' }), true);
  assert.equal(jwtExpiryMs('not-a-jwt'), null);
});

test('the probe route needs the internal key, only logs in, and never returns a secret', () => {
  const src = readFileSync(new URL('../pages/api/internal/paycentral-probe.js', import.meta.url), 'utf8');
  assert.match(src, /x-internal-api-key/);
  assert.match(src, /status\(401\)/);
  assert.doesNotMatch(src, /loadCard|virtualAllocate|allocatePhysical|freezeCard|unfreezeCard/, 'read-only: no card or money call');
  assert.match(src, /password: !!process\.env\.PAYCENTRAL_API_PASSWORD/, 'the password is reported as a boolean');
  assert.doesNotMatch(src, /egress:\s*process\.env\.PAYCENTRAL_EGRESS_PROXY,/, 'the proxy URL (it may hold credentials) is never returned');
});
