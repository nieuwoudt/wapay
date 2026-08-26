/**
 * OTT Payout API client (lib/ott-payout.js) — spec docs/OTT_PAYOUT_API.md.
 *
 * Anchored on the two GOLDEN VECTORS the spec publishes, so our crypto is
 * provably byte-identical to OTT's:
 *   - Basic auth: "Aladdin:OpenSesame" → "QWxhZGRpbjpPcGVuU2VzYW1l"
 *   - Hash:       "11123456789012" + apiKey → 9576e5e8…708e2ee
 * Plus: the PerformPayout hash ORDER, the webhook hash order, the money-safe
 * status→settlement mapping, amount/absent-optional formatting, and that no
 * bearer PIN or full account/id number is ever logged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  payoutHash,
  basicAuthHeader,
  verifyPayoutWebhook,
  classifyPayoutStatus,
  centsToAmountString,
  payoutAmountToCents,
  OttPayoutClient,
} from '../lib/ott-payout.js';

const API_KEY = 'ace4e782-e953-45d5-9f2a-aa1498c830ed';
const BASE = 'https://test-payoutapi.ott-mobile.com';

// ---------------------------------------------------------------------------
// Golden vectors from the spec
// ---------------------------------------------------------------------------

test('golden: Basic auth header matches the spec example', () => {
  assert.equal(basicAuthHeader('Aladdin', 'OpenSesame'), 'Basic QWxhZGRpbjpPcGVuU2VzYW1l');
});

test('golden: request hash matches the spec example (VendorID + VoucherPin + apiKey)', () => {
  // "11" + "123456789012" + apiKey → documented sha-256.
  assert.equal(
    payoutHash(['11', '123456789012'], API_KEY),
    '9576e5e8ad6a28cd78a192aa875fa84063038481dc97a7fc87ccf7167708e2ee'
  );
});

test('hash: absent optionals concatenate as empty string, key appended last', () => {
  assert.equal(payoutHash(['a', null, 'b', undefined], 'K'), payoutHash(['a', '', 'b', ''], 'K'));
  // Equivalent to a manual sha of "ab" + "K" is not asserted here; the golden
  // vector above proves the concatenation+suffix scheme.
});

// ---------------------------------------------------------------------------
// Amount formatting (money-safety: integer cents in, no float math)
// ---------------------------------------------------------------------------

test('centsToAmountString: 2dp, exact across the legal range', () => {
  assert.equal(centsToAmountString(1), '0.01');
  assert.equal(centsToAmountString(5099), '50.99');
  assert.equal(centsToAmountString(300000), '3000.00');
  assert.throws(() => centsToAmountString(50.5), /integer/);
  assert.throws(() => centsToAmountString(-1), /non-negative/);
});

test('payoutAmountToCents: grouped, comma-decimal, and plain all parse exactly', () => {
  assert.equal(payoutAmountToCents('400,00'), 40000);
  assert.equal(payoutAmountToCents('400.00'), 40000);
  assert.equal(payoutAmountToCents('100,000.00'), 10000000);
  assert.equal(payoutAmountToCents('50.99'), 5099);
  assert.equal(payoutAmountToCents('junk'), null);
});

// ---------------------------------------------------------------------------
// Status → settlement (money-safety)
// ---------------------------------------------------------------------------

test('classifyPayoutStatus: SETTLE only on 100; PENDING never releases; failures release', () => {
  assert.deepEqual(classifyPayoutStatus('100').settlement, 'SETTLE');
  assert.deepEqual(classifyPayoutStatus('99').settlement, 'PENDING');
  assert.deepEqual(classifyPayoutStatus('98').settlement, 'PENDING');
  // NOTE: '3' is deliberately absent — a duplicate reference can mean the
  // ORIGINAL succeeded, so it reconciles rather than releasing (see its own
  // test below). These are the definitively-nothing-was-paid codes.
  for (const s of ['-1', '1', '2', '0', '4', '9', '10', '11', '12', '97']) {
    assert.equal(classifyPayoutStatus(s).settlement, 'RELEASE', `status ${s} must release the hold`);
  }
  // An UNKNOWN status must NOT release — we might have paid (safe default).
  assert.equal(classifyPayoutStatus('777').settlement, 'PENDING');
});

// ---------------------------------------------------------------------------
// Webhook verification (spec: merchantUniqueReference+message+status+transactionId+utctimestamp+apiKey)
// ---------------------------------------------------------------------------

test('verifyPayoutWebhook: accepts a correctly-hashed payload, rejects tampering', () => {
  const base = {
    utctimestamp: '2025-12-11T13:31:15Z',
    transactionId: '3460396',
    merchantUniqueReference: 'Test123',
    message: 'Pending',
    status: '99',
    secret: '00000000-0000-0000-0000-000000000000',
  };
  const good = {
    ...base,
    hashcheck: payoutHash(
      [base.merchantUniqueReference, base.message, base.status, base.transactionId, base.utctimestamp],
      API_KEY
    ),
  };
  assert.equal(verifyPayoutWebhook(good, API_KEY), true);
  // Tamper with the amount-bearing status → hash no longer matches.
  assert.equal(verifyPayoutWebhook({ ...good, status: '100' }, API_KEY), false);
  assert.equal(verifyPayoutWebhook({ ...good, hashcheck: 'deadbeef' }, API_KEY), false);
  assert.equal(verifyPayoutWebhook(null, API_KEY), false);
});

// ---------------------------------------------------------------------------
// PerformPayout over a mocked transport
// ---------------------------------------------------------------------------

function mockClient(handler) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const pool = agent.get(BASE);
  handler(pool);
  return new OttPayoutClient({
    baseUrl: BASE,
    username: 'WAPAYVIT',
    password: 'pw',
    apiKey: API_KEY,
    bodyEncoding: 'json',
  });
}

test('performPayout: sends Basic auth + JSON, hashes the documented field order, maps success', async () => {
  let seen = null;
  const client = mockClient((pool) => {
    pool
      .intercept({ path: '/api/purchase/v1/PerformPayout', method: 'POST' })
      .reply(200, (req) => {
        seen = { headers: req.headers, body: JSON.parse(req.body) };
        return {
          status: '100',
          message: 'Payment successful',
          paymentReference: 'PR-OTT-1',
          voucherdata: { amount: '50.00', serialNumber: 'S1', pin: 'SECRET-PIN', instructions: 'x' },
        };
      });
  });

  const recipient = {
    firstname: 'Thabo',
    surname: 'M',
    id_number: '9001015800088',
    mobile: '0726252243',
    account_number: '12345678',
    account_name: 'Thabo M',
    branch_code: '470010',
    branch_name: 'Capitec',
  };
  const res = await client.performPayout({
    amountCents: 5000,
    providerCode: 5,
    providerName: 'PAYSHAP',
    recipient,
    yourUniqueReference: 'WAPAY-PO-ABC123',
  });

  // Auth + content type
  const auth = seen.headers.authorization || seen.headers.Authorization;
  assert.equal(auth, 'Basic ' + Buffer.from('WAPAYVIT:pw').toString('base64'));
  // Body carries the computed hash in the documented order.
  const expectedHash = payoutHash(
    [
      recipient.account_name, recipient.account_number, '50.00', undefined /*bank_id*/,
      recipient.branch_name, recipient.branch_code, undefined, undefined, undefined,
      recipient.firstname, recipient.id_number, undefined, undefined, recipient.mobile,
      undefined, 5, 'PAYSHAP', recipient.surname, undefined, undefined, 'WAPAY-PO-ABC123',
    ],
    API_KEY
  );
  assert.equal(seen.body.hashcheck, expectedHash, 'hash must follow the spec value order');
  // The wire amount MUST be the exact 2dp string that was hashed. Sending
  // Number("50.00") → 50 made OTT hash "50" and every round-rand payout would
  // have failed with status 2 Invalid Hash (review 2026-08-26).
  assert.equal(seen.body.amount, '50.00', 'wire amount must equal the hashed amount, byte for byte');
  assert.equal(res.outcome, 'SUCCESS');
  assert.equal(res.settlement, 'SETTLE');
  assert.equal(res.paymentReference, 'PR-OTT-1');
});

test('performPayout: a PENDING (99) result never signals RELEASE', async () => {
  const client = mockClient((pool) => {
    pool
      .intercept({ path: '/api/purchase/v1/PerformPayout', method: 'POST' })
      .reply(200, { status: '99', message: 'Payment loaded pending finalisation', paymentReference: 'PR2' });
  });
  const res = await client.performPayout({
    amountCents: 10000,
    providerCode: 5,
    recipient: { firstname: 'A', surname: 'B' },
    yourUniqueReference: 'WAPAY-PO-PEND',
  });
  assert.equal(res.settlement, 'PENDING');
});

test('performPayout: rejects non-positive/non-integer amount and missing name before any call', async () => {
  const client = new OttPayoutClient({ baseUrl: BASE, username: 'u', password: 'p', apiKey: API_KEY });
  await assert.rejects(
    () => client.performPayout({ amountCents: 0, providerCode: 5, recipient: { firstname: 'A', surname: 'B' }, yourUniqueReference: 'r' }),
    /positive integer/
  );
  await assert.rejects(
    () => client.performPayout({ amountCents: 100, providerCode: 5, recipient: { firstname: 'A' }, yourUniqueReference: 'r' }),
    /surname/
  );
});

test('getBalance: hashes requestdate+ref+apiKey and returns the envelope', async () => {
  let seen;
  const client = mockClient((pool) => {
    pool.intercept({ path: '/api/purchase/v1/GetBalance', method: 'POST' }).reply(200, (req) => {
      seen = JSON.parse(req.body);
      return { status: 'Success', balance: '400,00', responsedate: 'x' };
    });
  });
  const out = await client.getBalance({ requestdate: '2025-05-31 00:00:00', yourUniqueReference: 'REF1' });
  assert.equal(seen.hashcheck, payoutHash(['2025-05-31 00:00:00', 'REF1'], API_KEY));
  assert.equal(out.balance, '400,00');
  assert.equal(payoutAmountToCents(out.balance), 40000);
});

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------

test('static: the client never logs the voucher PIN or a full account/id number', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/ott-payout.js', import.meta.url)), 'utf8');
  // The perform log masks mobile/account and never reads the pin.
  assert.match(src, /mobile: mask\(recipient\?\.mobile\)/);
  assert.match(src, /account: mask\(recipient\?\.account_number\)/);
  // Isolate the log() call bodies and prove no secret field is inside them.
  const logCalls = [...src.matchAll(/log\('ott_payout[^;]*?\}\s*\)/gs)].map((m) => m[0]).join('\n');
  assert.ok(logCalls.length > 0, 'there are structured log calls to check');
  assert.ok(!/\.pin\b/.test(logCalls), 'no voucher pin in any log line');
  assert.ok(!/id_number/.test(logCalls), 'no id number in any log line');
  assert.ok(!/account_number(?!\))/.test(logCalls.replace(/mask\(recipient\?\.account_number\)/g, '')), 'no raw account number in any log line');
});

// ---------------------------------------------------------------------------
// Review fixes 2026-08-26 — the failure paths that could double-spend
// ---------------------------------------------------------------------------

test('wire amount equals hashed amount for EVERY amount shape (round rands included)', async () => {
  for (const cents of [5000, 5010, 5099, 300000, 1]) {
    let seen;
    const client = mockClient((pool) => {
      pool.intercept({ path: '/api/purchase/v1/PerformPayout', method: 'POST' }).reply(200, (req) => {
        seen = JSON.parse(req.body);
        return { status: '100', paymentReference: 'x' };
      });
    });
    await client.performPayout({
      amountCents: cents,
      providerCode: 5,
      recipient: { firstname: 'A', surname: 'B' },
      yourUniqueReference: `REF-${cents}`,
    });
    const expected = centsToAmountString(cents);
    assert.equal(seen.amount, expected, `${cents}c must go on the wire as "${expected}"`);
    assert.equal(typeof seen.amount, 'string', 'never a JS number — JSON would drop trailing zeros');
  }
});

test('transport failure returns an INDETERMINATE PENDING outcome — it never throws a false failure', async () => {
  const client = mockClient((pool) => {
    pool
      .intercept({ path: '/api/purchase/v1/PerformPayout', method: 'POST' })
      .replyWithError(new Error('socket hang up'));
  });
  const res = await client.performPayout({
    amountCents: 5000,
    providerCode: 5,
    recipient: { firstname: 'A', surname: 'B' },
    yourUniqueReference: 'REF-TIMEOUT',
  });
  // The payout MAY have reached OTT — releasing the hold here would double-spend.
  assert.equal(res.settlement, 'PENDING');
  assert.equal(res.outcome, 'TRANSPORT_INDETERMINATE');
  assert.equal(res.reconcileRequired, true);
  assert.equal(res.status, null);
});

test('status 3 (duplicate reference) reconciles — it must NEVER release the hold', () => {
  const k = classifyPayoutStatus('3');
  // Our reference is deterministic, so "not unique" means an earlier attempt
  // already reached OTT and may have succeeded.
  assert.equal(k.settlement, 'PENDING');
  assert.equal(k.reconcileRequired, true);
});

test('getPaymentStatus is the reconcile path and maps through the same safety table', async () => {
  const client = mockClient((pool) => {
    pool
      .intercept({ path: '/api/purchase/v1/GetPaymentStatus', method: 'POST' })
      .reply(200, { status: 100, message: 'Success', paymentReference: 'PR9' });
  });
  const out = await client.getPaymentStatus({ requestdate: '2025-05-31 00:00:00', yourUniqueReference: 'REF-RECON' });
  assert.equal(out.settlement, 'SETTLE');
  assert.equal(out.outcome, 'SUCCESS');
});
