/**
 * OTT Redemption rail (spec v6, received 2026-09-04).
 *
 * Locks the money-safety contract BEFORE any live credential exists:
 * - the hash matches OTT's published golden vector (same rule as issuing);
 * - amounts convert with exact string math, never floats;
 * - a timeout is INDETERMINATE (TIMEOUT_CHECK_REQUIRED), never a failure,
 *   and the recovery is CheckRemitVoucher — never a second RemitVoucher
 *   (the spec says so explicitly on page 13);
 * - epoch-shaped references are refused (they poison derived ledger keys);
 * - GetAPIKey is not implemented anywhere (it ROTATES the live key);
 * - voucher PINs never reach a log line.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  OttRedemptionClient,
  hashParams,
  randToCents,
  centsToRand,
  maskPin,
} from '../lib/ott-redemption.js';

const source = readFileSync(
  fileURLToPath(new URL('../lib/ott-redemption.js', import.meta.url)),
  'utf8'
);

const ENV = {
  OTT_MERCHANT_BASE_URL: 'https://test-api.ott-mobile.com',
  OTT_MERCHANT_API_USERNAME: 'WAPAYVMT',
  OTT_MERCHANT_API_PASSWORD: 'pw',
  OTT_MERCHANT_API_KEY: 'ace4e782-e953-45d5-9f2a-aa1498c830ed',
  OTT_VENDOR_CODE: '11',
};

function withEnv(fn) {
  const prev = {};
  for (const [k, v] of Object.entries(ENV)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k] of Object.entries(ENV)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// ---------------------------------------------------------------------------
// Crypto + money math
// ---------------------------------------------------------------------------

test('hash matches OTT published golden vector (values, alphabetical by name)', () => {
  const key = 'ace4e782-e953-45d5-9f2a-aa1498c830ed';
  // Doc example: VendorID=11 + VoucherPin=123456789012
  const got = hashParams({ VendorID: '11', VoucherPin: '123456789012' }, key);
  assert.equal(got, 'c399a3964ec6d7e3e7804fa56d14c78e2a1a880c1a702127d96a790ec6332bf0');
});

test('rand/cents conversion is exact string math, incl. comma grouping', () => {
  assert.equal(randToCents('8.50'), 850);
  assert.equal(randToCents('1.50'), 150);
  assert.equal(randToCents('30.0000'), 3000);
  assert.equal(randToCents('1,000.00'), 100000);
  assert.equal(randToCents('0'), 0);
  assert.equal(centsToRand(850), '8.50');
  assert.equal(centsToRand(100000), '1000.00');
  // The classic float trap: 0.1+0.2 style drift must be impossible.
  assert.equal(randToCents(centsToRand(2999)), 2999);
  assert.throws(() => randToCents('abc'));
  assert.throws(() => randToCents('1.234'), /Sub-cent/);
});

test('voucher PINs are masked, never shown in full', () => {
  assert.equal(maskPin('1234567890123456'), '1234…[16-digits]');
  assert.equal(maskPin('123'), '****');
  assert.ok(!maskPin('1234567890123456').includes('7890123456'));
});

// ---------------------------------------------------------------------------
// The timeout contract (the money-safety core)
// ---------------------------------------------------------------------------

test('a remit timeout is INDETERMINATE and demands CheckRemitVoucher', async () => {
  await withEnv(async () => {
    const client = new OttRedemptionClient({ timeoutMs: 5 });
    // Force the timeout path deterministically.
    client.post = async (_endpoint, _params, opts) => {
      assert.equal(opts?.timeoutAsMarker, true, 'remit must opt into the timeout marker');
      throw new Error('TIMEOUT');
    };
    await assert.rejects(
      () =>
        client.remitVoucher({
          voucherPin: '123456789012',
          amountCents: 5000,
          uniqueReference: 'wapay-redeem-abc123',
          mobile: '27780000000',
          clientId: 'acct_1',
        }),
      (err) => {
        assert.equal(err.message, 'TIMEOUT_CHECK_REQUIRED');
        assert.equal(err.uniqueReference, 'wapay-redeem-abc123');
        return true;
      }
    );
  });
});

test('the spec rule is encoded: never retry the remit, always check', () => {
  assert.match(source, /do not retry the RemitVoucher/i, 'the spec rule is quoted in the module');
  assert.match(source, /NEVER retry the remit|never a second remitVoucher|NEVER retry/i);
  // remitVoucher must be called exactly once per attempt — no internal loop.
  const fn = source.slice(source.indexOf('async remitVoucher'), source.indexOf('async checkRemitVoucher'));
  assert.ok(!/for\s*\(|while\s*\(/.test(fn), 'no retry loop inside remitVoucher');
});

test('epoch-shaped references are refused (they poison derived ledger keys)', async () => {
  await withEnv(async () => {
    const client = new OttRedemptionClient();
    await assert.rejects(
      () =>
        client.remitVoucher({
          voucherPin: '123456789012',
          amountCents: 100,
          uniqueReference: `wapay-redeem-${Date.now()}`,
          mobile: '27780000000',
          clientId: 'a',
        }),
      /epoch-free/
    );
  });
});

test('remit refuses non-positive or non-integer amounts', async () => {
  await withEnv(async () => {
    const client = new OttRedemptionClient();
    for (const bad of [0, -100, 10.5, NaN, undefined]) {
      await assert.rejects(
        () =>
          client.remitVoucher({
            voucherPin: '1234',
            amountCents: bad,
            uniqueReference: 'wapay-redeem-x',
            mobile: '2778',
            clientId: 'a',
          }),
        /positive integer amountCents/
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Partial redemption + response parsing
// ---------------------------------------------------------------------------

test('partial redemption: taken vs balance are both surfaced in cents', async () => {
  await withEnv(async () => {
    const client = new OttRedemptionClient();
    client.post = async () => ({
      success: 'true',
      voucherID: '12345678',
      voucherAmount: '8.50',
      voucherBalance: '1.50',
    });
    const out = await client.remitVoucher({
      voucherPin: '123456789012',
      amountCents: 850,
      uniqueReference: 'wapay-redeem-abc',
      mobile: '27780000000',
      clientId: 'acct_1',
    });
    assert.equal(out.voucherAmountCents, 850);
    assert.equal(out.voucherBalanceCents, 150, 'the residual stays with the customer via OTT');
    assert.equal(out.voucherId, '12345678');
  });
});

test('checkVoucher returns the value so a preview can quote before money moves', async () => {
  await withEnv(async () => {
    const client = new OttRedemptionClient();
    client.post = async (endpoint, params) => {
      assert.equal(endpoint, 'CheckVoucher');
      assert.equal(params.vendorID, '11');
      return { success: 'true', message: 'Voucher Valid', serial: '300001095954', value: '30.0000' };
    };
    const out = await client.checkVoucher('123456789012');
    assert.equal(out.valueCents, 3000);
    assert.equal(out.serial, '300001095954');
  });
});

// ---------------------------------------------------------------------------
// Standing rules
// ---------------------------------------------------------------------------

test('GetAPIKey is never implemented — it rotates the LIVE key', () => {
  assert.ok(!/GetAPIKey['"`]\s*[,)]/.test(source), 'no GetAPIKey call');
  assert.ok(!/post\(\s*['"`]GetAPIKey/.test(source), 'never posted');
  assert.match(source, /ROTATES the live key/i, 'the trap is documented in the module');
});

test('endpoints and auth match the v6 spec', () => {
  assert.match(source, /\/api\/v1\/\$\{endpoint\}|`\$\{this\.base\}\/api\/v1\//);
  for (const ep of ['CheckVoucher', 'RemitVoucher', 'CheckRemitVoucher']) {
    assert.ok(source.includes(`'${ep}'`), `${ep} implemented`);
  }
  assert.match(source, /Basic \$\{basic\}/, 'HTTP Basic auth');
  assert.match(source, /application\/x-www-form-urlencoded/, 'form encoding');
});

test('the PIN never reaches a log line in full', () => {
  const logCalls = [...source.matchAll(/log\((['"`][a-z_]+['"`][^;]*?)\);/gs)].map((m) => m[1]);
  assert.ok(logCalls.length > 3, 'there are log calls to inspect');
  for (const call of logCalls) {
    assert.ok(!/\bvoucherPin\b(?!\s*\))/.test(call.replace(/maskPin\(voucherPin\)/g, 'MASKED')),
      `raw PIN in a log call: ${call.slice(0, 90)}`);
  }
  assert.match(source, /pinMasked: maskPin\(voucherPin\)/);
});

test('live vs test environment is detectable without printing a credential', () => {
  withEnv(() => {
    const test = new OttRedemptionClient();
    assert.equal(test.isLive, false, 'test- prefix means sandbox');
    const live = new OttRedemptionClient({ baseUrl: 'https://api.ott-mobile.com' });
    assert.equal(live.isLive, true, 'no prefix means production');
  });
});

// ---------------------------------------------------------------------------
// Chat-flow wiring (the second cash-in rail)
// ---------------------------------------------------------------------------

const processorSource = readFileSync(
  fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)),
  'utf8'
);

function ottFlowSource() {
  const start = processorSource.indexOf('async function attemptOttRedemption');
  assert.ok(start > -1, 'processor must define attemptOttRedemption');
  const end = processorSource.indexOf('\nasync function handleVoucherRedemption', start);
  assert.ok(end > start);
  return processorSource.slice(start, end);
}

test('OTT is a FALLBACK: Blu stays the primary rail, tried first', () => {
  const blu = processorSource.indexOf('bluClient.checkStatus(pin)');
  const ott = processorSource.indexOf('attemptOttRedemption({ from, pin, account })', blu);
  assert.ok(blu > -1 && ott > blu, 'OTT is only attempted after Blu fails');
  // The fallback lives in the Blu status-check catch, so a healthy Blu
  // voucher never touches OTT.
  assert.match(processorSource, /catch \(statusError\)[\s\S]{0,400}attemptOttRedemption/);
});

test('one PIN can only ever be credited once, and rails cannot collide', () => {
  const fn = ottFlowSource();
  assert.match(fn, /createHash\('sha256'\)\.update\(String\(pin\)\)/, 'idemKey derives from the PIN');
  assert.match(fn, /wapay-redeem-ott-\$\{safeHash\}/, 'rail-prefixed so Blu and OTT keys never collide');
  // The ledger's timestamp guard would reject a raw hash run AFTER the
  // voucher was consumed (BUGLOG #17's shape), so the hash is interleaved.
  assert.match(fn, /replace\(\/\(\.\{8\}\)\/g, '\$1x'\)/);
});

test('read-only check happens BEFORE anything is consumed', () => {
  const fn = ottFlowSource();
  const check = fn.indexOf('client.checkVoucher(pin)');
  const remit = fn.indexOf('client.remitVoucher');
  assert.ok(check > -1 && remit > check, 'checkVoucher precedes remitVoucher');
  // A PIN that is not an OTT voucher costs nothing and stays silent.
  assert.match(fn, /return false; \/\/ not an OTT voucher/);
});

test('a durable row is written BEFORE the voucher is consumed', () => {
  const fn = ottFlowSource();
  const row = fn.indexOf('providerRequest.upsert');
  const remit = fn.indexOf('client.remitVoucher');
  const remitted = fn.indexOf("status: 'REMITTED'");
  const post = fn.indexOf('postEntry(loadEntry)');
  assert.ok(row > -1 && row < remit, 'row created before the remit');
  assert.ok(remitted > remit && remitted < post, 'REMITTED recorded before the ledger write');
});

test('a remit timeout resolves via check, never a second remit', () => {
  const fn = ottFlowSource();
  assert.match(fn, /TIMEOUT_CHECK_REQUIRED/);
  assert.match(fn, /client\.checkRemitVoucher\(reference\)/);
  // Exactly one remit call in the whole flow.
  assert.equal((fn.match(/client\.remitVoucher\(/g) || []).length, 1);
  assert.match(fn, /status: 'RECONCILE'/, 'still-unknown leaves a reconcilable row');
});

test('money in is credited through buildLoad on the OTT rail', () => {
  const fn = ottFlowSource();
  assert.match(fn, /buildLoad\(\{[\s\S]{0,120}rail: RAIL\.OTT/);
  assert.match(fn, /faceCents: remit\.voucherAmountCents/);
  assert.match(fn, /idemKey,/);
  assert.ok(!/reserveHold|settleHold/.test(fn), 'a load is not a two-phase spend');
});

test('the customer is told about any residual left on the voucher', () => {
  const fn = ottFlowSource();
  assert.match(fn, /residualCents: remit\.voucherBalanceCents/);
  assert.match(fn, /is left on that voucher/);
});

test('the PIN never reaches a log line or the stored row', () => {
  const fn = ottFlowSource();
  const logs = [...fn.matchAll(/logStructured\(([^;]*?)\);/gs)].map((m) => m[1]);
  assert.ok(logs.length >= 3);
  for (const call of logs) {
    assert.ok(!/\bpin\b/.test(call.replace(/pinHash|safeHash/g, '')), `PIN in a log: ${call.slice(0, 80)}`);
  }
  const meta = fn.slice(fn.indexOf('metadata: {'), fn.indexOf('metadata: {') + 120);
  assert.ok(!/\bpin\b/.test(meta.replace(/pinHash/g, '')), 'PIN never stored on the row');
});

test('the rail stays silent when it is not configured', () => {
  const fn = ottFlowSource();
  assert.match(fn, /if \(!process\.env\.OTT_MERCHANT_API_KEY\) return false/);
});
