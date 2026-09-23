/**
 * The PerformPayout wire format (BUGLOG #80). OTT's payout API is a .NET
 * service: an empty string in an integer-typed field (bank_id) is rejected at
 * model binding with HTTP 400 and an RFC 7807 problem document, before any
 * payout exists. Both of the founder's live pay-outs (2026-09-15 PayShap,
 * 2026-09-17 Nedbank) died that way, and the document's `status: 400` was
 * read as an OTT payout status and parked the money.
 *
 * Locks: empty optionals never reach the wire and bank_id goes as a number
 * while the hash is unchanged; a 400 problem document that names fields is
 * REQUEST_INVALID → RELEASE (nothing paid); any other problem document keeps
 * the hold; requestPayout records the HTTP status and the masked body on the
 * FAILED row; the customer copy owns the fault; the sandbox probe route is
 * gated, sandbox-only, ledger-free and masks everything it returns.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { OttPayoutClient, wireRecipient, isProblemDetails, problemPaths, payoutHash, plainAmountString, DEFAULT_HASH_STYLE } from '../lib/ott-payout.js';
import { requestPayout, cleanRecipient } from '../lib/payouts.js';
import { executeWithdraw } from '../lib/payout-chat.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const API_KEY = 'ace4e782-e953-45d5-9f2a-aa1498c830ed';
const BASE = 'https://test-payoutapi.ott-mobile.com';
const client = () => new OttPayoutClient({ baseUrl: BASE, username: 'u', password: 'p', apiKey: API_KEY, timeoutMs: 2000 });

/** Stub fetch for one call; returns what the client sent. */
async function withFetch(reply, fn) {
  const seen = {};
  const prev = global.fetch;
  global.fetch = async (url, init) => { seen.url = url; seen.init = init; seen.body = JSON.parse(init.body); return { status: reply.status, text: async () => JSON.stringify(reply.body) }; };
  try { return { seen, out: await fn() }; } finally { global.fetch = prev; }
}

const problem400 = {
  type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1',
  title: 'One or more validation errors occurred.',
  status: 400,
  errors: { purchase: ['The purchase field is required.'], '$.recipient.bank_id': ['The JSON value could not be converted to System.Int32. Path: $.recipient.bank_id | LineNumber: 0 | BytePositionInLine: 351.'] },
};

test('wireRecipient: empty optionals are dropped, bank_id becomes a number, digit strings stay strings', () => {
  const cleaned = cleanRecipient('NEDCASH', { firstname: 'Nieuwoudt', surname: 'Nieuwoudt', id_number: '9001185079083', mobile: '0787051175' }, ['firstname', 'surname', 'id_number', 'mobile']);
  assert.equal(cleaned.bank_id, '', 'cleanRecipient still returns every field (the hash needs the "" convention)');
  const wire = wireRecipient(cleaned);
  assert.deepEqual(Object.keys(wire).sort(), ['firstname', 'id_number', 'mobile', 'surname']);
  assert.equal(wire.mobile, '27787051175');
  assert.deepEqual(wireRecipient({ bank_id: '12', account_number: '62525898394', email: '', title: null, x: undefined }), { bank_id: 12, account_number: '62525898394' });
});

test('performPayout: the wire body carries no empty fields and the hash is the spec hash over "" for absents', async () => {
  const recipient = cleanRecipient('PAYSHAP', { firstname: 'Nieuwoudt', surname: 'Nieuwoudt', id_number: '9001185079083', mobile: '0787051175', account_number: '62525898394', branch_code: '250655', branch_name: 'FNB' }, ['firstname', 'surname', 'id_number', 'mobile', 'account_number', 'branch_code']);
  const { seen, out } = await withFetch({ status: 200, body: { status: 100, paymentReference: 'OTT-1' } }, () =>
    client().performPayout({ amountCents: 5000, providerCode: '127', providerName: 'PayShap Account', recipient, yourUniqueReference: 'WPC15800A7BD6637' }));
  assert.equal(seen.url, `${BASE}/api/purchase/v1/PerformPayout`);
  assert.equal(seen.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(Object.keys(seen.body.recipient).sort(), ['account_number', 'branch_code', 'branch_name', 'firstname', 'id_number', 'mobile', 'surname']);
  assert.ok(!('bank_id' in seen.body.recipient) && !('email' in seen.body.recipient), 'no "" on the wire');
  assert.equal(seen.body.amount, '50.00');
  const expected = payoutHash([
    '', '62525898394', '50.00', '0', 'FNB', '250655', '', '', '', 'Nieuwoudt', '9001185079083', '', '', '27787051175', '', '127', 'PayShap Account', 'Nieuwoudt', '', '', 'WPC15800A7BD6637',
  ], API_KEY);
  assert.equal(seen.body.hashcheck, expected, 'absent string optionals hash as "", the absent bank_id as "0" (OTT sandbox, 2026-09-23)');
  assert.equal(out.settlement, 'SETTLE'); assert.equal(out.wire.url, seen.url); assert.equal(out.wire.body.hashcheck, expected);
});

test('a 400 problem document that names fields is REQUEST_INVALID → RELEASE; its status is never an OTT status', async () => {
  assert.equal(isProblemDetails(400, problem400), true);
  assert.equal(isProblemDetails(200, { status: 100 }), false);
  assert.equal(isProblemDetails(400, { status: 0, message: 'Provider inactive' }), false, 'a real OTT status body is not a problem document');
  assert.deepEqual(problemPaths(problem400), ['purchase', '$.recipient.bank_id']);
  const { out } = await withFetch({ status: 400, body: problem400 }, () =>
    client().performPayout({ amountCents: 2000, providerCode: '4', providerName: 'Nedbank Cardless Withdrawal', recipient: { firstname: 'A', surname: 'B', id_number: '9001185079083', mobile: '27787051175' }, yourUniqueReference: 'WP801A17C629E860' }));
  assert.equal(out.outcome, 'REQUEST_INVALID'); assert.equal(out.settlement, 'RELEASE'); assert.equal(out.status, null); assert.equal(out.httpStatus, 400);
  assert.deepEqual(out.errors, ['purchase', '$.recipient.bank_id']);
});

test('any other problem document (no field list, or not 400) keeps the hold and asks for reconcile', async () => {
  for (const reply of [{ status: 500, body: { type: 'about:blank', title: 'Internal Server Error', status: 500 } }, { status: 400, body: { title: 'Bad Request', status: 400 } }]) {
    const { out } = await withFetch(reply, () =>
      client().performPayout({ amountCents: 2000, providerCode: '4', recipient: { firstname: 'A', surname: 'B' }, yourUniqueReference: 'WPX' }));
    assert.equal(out.settlement, 'PENDING'); assert.equal(out.reconcileRequired, true); assert.equal(out.outcome, `HTTP_${reply.status}`); assert.equal(out.status, null);
  }
});

test('requestPayout on REQUEST_INVALID: released, money back, FAILED row keeps the HTTP status and the masked body', async () => {
  process.env.WAPAY_PAYOUT_ENABLED = 'true'; process.env.WAPAY_PAYOUT_KYC = 'off';
  process.env.OTT_PAYOUT_BASE_URL = BASE; process.env.OTT_PAYOUT_USERNAME = 'u'; process.env.OTT_PAYOUT_PASSWORD = 'p'; process.env.OTT_PAYOUT_API_KEY = 'k';
  const prs = [];
  const prisma = { providerRequest: {
    async findUnique({ where }) { return prs.find((x) => x.idemKey === where.idemKey) || null; },
    async create({ data }) { const row = { id: 'pr1', requestTs: new Date(), providerRef: null, ...data }; prs.push(row); return row; },
    async update({ where, data }) { const r = prs.find((x) => x.idemKey === where.idemKey); Object.assign(r, data); return r; },
  } };
  const calls = []; let spend = 10000; let cash = 0; const holds = new Map();
  const ledger = {
    async ensureWallet() {}, async postEntry(e) { calls.push(e.source); const amt = e.postings[0].debitCents; if (e.source === 'BALANCE_UPGRADE') { spend -= amt; cash += amt; } if (e.source === 'BALANCE_DOWNGRADE') { cash -= amt; spend += amt; } return {}; },
    async reserveHold({ idemKey, amountCents }) { calls.push('reserveHold'); holds.set(idemKey, 'ACTIVE'); cash -= amountCents; return {}; },
    async settleHold() { calls.push('settleHold'); }, async releaseHold({ idemKey }) { calls.push('releaseHold'); holds.set(idemKey, 'RELEASED'); cash += 2000 + 1800; },
  };
  const c = { async performPayout() { return { httpStatus: 400, status: null, outcome: 'REQUEST_INVALID', settlement: 'RELEASE', retriable: false, paymentReference: null, body: problem400, errors: ['purchase', '$.recipient.bank_id'] }; } };
  const providers = [{ method: 'NEDCASH', providerCode: '4', providerName: 'Nedbank Cardless Withdrawal', requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] }];
  const r = await requestPayout({ prisma, ledger, client: c, account: { id: 'acc-1', profile: {} }, intentId: 'intent-9001', method: 'NEDCASH', amountCents: 2000, recipient: { firstname: 'A', surname: 'B', id_number: '9001185079083', mobile: '0787051175' }, providers });
  assert.equal(r.ok, false); assert.equal(r.error, 'REQUEST_INVALID');
  assert.ok(calls.includes('releaseHold') && calls.includes('BALANCE_DOWNGRADE'), 'released and moved back');
  assert.equal(spend, 10000, 'the customer is whole'); assert.equal(cash, 0);
  assert.equal(prs[0].status, 'FAILED'); assert.equal(prs[0].metadata.httpStatus, 400);
  assert.match(prs[0].metadata.providerBody, /bank_id/); assert.ok(!/9001185079083/.test(prs[0].metadata.providerBody), 'no ID number in the row');
  delete process.env.WAPAY_PAYOUT_KYC;
});

test('the customer hears that the fault is ours, and nothing left the balance', async () => {
  const out = await executeWithdraw({ account: { id: 'acc-1', displayName: 'Nieuwoudt Gresse', profile: {} }, data: { intentId: 'wa-x', method: 'NEDCASH', amountCents: 2000, recipient: {} }, deps: { requestPayout: async () => ({ ok: false, status: 'FAILED', error: 'REQUEST_INVALID', reference: 'WPX' }) } });
  assert.match(out.text, /could not read our request \(our side, not yours\)/);
  assert.match(out.text, /Nothing has left your balance/);
});

test('static: the sandbox probe route is gated, sandbox-only, ledger-free, single-shot and masked', () => {
  const src = read('../pages/api/internal/payout-probe.js');
  assert.match(src, /if \(req\.method !== 'POST' && req\.method !== 'GET'\) return res\.status\(405\)/);
  const getBranch = src.slice(src.indexOf("if (req.method === 'GET')"), src.indexOf('const { method ='));
  assert.match(getBranch, /getPaymentStatus\(/); assert.ok(!/performPayout/.test(getBranch), 'GET only reads a status, never pays');
  assert.match(getBranch, /\^WP\[0-9A-F\]\{14\}\$/, 'GET takes only a well-formed reference');
  assert.match(src, /accepted: last\.response\.status != null && last\.response\.outcome !== 'INVALID_HASH'/, 'a transport failure is never reported as an accepted hash');
  assert.match(src, /if \(!keyOk\(req\)\) return res\.status\(401\)/); assert.match(src, /timingSafeEqual/);
  assert.match(src, /if \(!host\.startsWith\('test-'\)\) return res\.status\(403\)\.json\(\{ error: 'SANDBOX_ONLY'/);
  assert.match(src, /amountCents > 5000/);
  const imports = src.split('\n').filter((l) => l.startsWith('import '));
  assert.ok(!imports.some((l) => /prisma\.js|ledger-post|ledger-core/.test(l)), 'no ledger, no customer row');
  assert.ok(!/requestPayout\(|reserveHold\(|finalisePayout\(/.test(src), 'never moves money');
  assert.equal((src.match(/performPayout\(/g) || []).length, 1, 'one pay-out request per hash variant, in one loop');
  assert.match(src, /variants\.slice\(0, 4\)/, 'at most four variants per call'); assert.match(src, /if \(result\.outcome !== 'INVALID_HASH'\) break;/, 'stops at the first accepted hash');
  assert.match(src, /cleanRecipient\(method, recipient, provider\.requiredFields\)/, 'the same recipient cleaning as the withdraw flow');
  assert.match(src, /request: maskDeep\(result\.wire\)/); assert.match(src, /body: maskDeep\(result\.body\)/);
  assert.match(src, /k === 'hashcheck' \?/, 'the hash never leaves whole');
});

test('hash styles: plain amount renders like double.ToString, bank_id defaults to "0"; the proven style is the default', async () => {
  assert.equal(plainAmountString(2000), '20'); assert.equal(plainAmountString(2050), '20.5'); assert.equal(plainAmountString(2005), '20.05'); assert.equal(plainAmountString(300000), '3000');
  assert.deepEqual(DEFAULT_HASH_STYLE, { amount: '2dp', bankId: 'zero' }, 'the proven convention is the default');
  const recipient = { firstname: 'A', surname: 'B', id_number: '9001185079083', mobile: '27787051175' };
  const order = (amt, bank) => ['', '', amt, bank, '', '', '', '', '', 'A', '9001185079083', '', '', '27787051175', '', '4', 'Nedbank Cardless Withdrawal', 'B', '', '', 'WPX'];
  for (const [style, amt, bank] of [[{ amount: '2dp', bankId: 'empty' }, '20.00', ''], [{ amount: 'plain', bankId: 'empty' }, '20', ''], [{ amount: '2dp', bankId: 'zero' }, '20.00', '0'], [{ amount: 'plain', bankId: 'zero' }, '20', '0']]) {
    const { seen, out } = await withFetch({ status: 401, body: { status: 2, message: 'Invalid Hash' } }, () =>
      client().performPayout({ amountCents: 2000, providerCode: '4', providerName: 'Nedbank Cardless Withdrawal', recipient, yourUniqueReference: 'WPX', hashStyle: style }));
    assert.equal(seen.body.hashcheck, payoutHash(order(amt, bank), API_KEY), `style ${JSON.stringify(style)}`);
    assert.equal(seen.body.amount, '20.00', 'the wire amount never changes with the hash style');
    assert.ok(!('bank_id' in seen.body.recipient), 'and an absent bank_id stays absent on the wire');
    assert.equal(out.outcome, 'INVALID_HASH'); assert.deepEqual(out.wire.hashStyle, style);
  }
});

