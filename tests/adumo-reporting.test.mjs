/**
 * Adumo: the pieces added 2026-09-29 from the Virtual spec and the public
 * Postman workspace. Locks: the per-transaction webhook claim and the flow
 * field on the checkout; the outcome (method, masked PAN, bank error)
 * recorded on the intent by the return and the webhook; the Enterprise
 * reporting client (OAuth client credentials, cached; getState by id or by
 * merchant reference); the reconciler credits ONLY on SETTLED with a
 * matching gross, through the shared idempotent settlement; the probe and
 * cron routes are gated and cannot start a payment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildVirtualCheckout, verifyJwtHs256, verifyAdumoResponse, signJwtHs256, adumoFlow, adumoMethodClass, adumoOutcomeRecord, ADUMO_PUBLIC_TEST, ADUMO_FLOWS } from '../lib/adumo.js';
import { AdumoReportingClient, adumoReportingConfig, adumoReportingConfigured, classifyAdumoState, normaliseState, reconcileAdumoIntent, reconcileAdumoIntents, ADUMO_TOKEN_PATH, ADUMO_GETSTATE_PATH } from '../lib/adumo-reporting.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const cfg = { merchantId: ADUMO_PUBLIC_TEST.merchantId, applicationId: ADUMO_PUBLIC_TEST.applicationIdNo3ds, jwtSecret: ADUMO_PUBLIC_TEST.jwtSecret, sandbox: true };

test('checkout: notificationURL rides in the signed claims, flow only from the allowlist, both optional', () => {
  const f = buildVirtualCheckout({ amountCents: 3800, merchantReference: 'PRFMXNPV-1', successUrl: 'https://pleasepayme.co.za/api/pay/adumo-return?code=PRFMXNPV', failUrl: 'https://pleasepayme.co.za/api/pay/adumo-return?code=PRFMXNPV', notificationUrl: 'https://pleasepayme.co.za/api/webhooks/adumo', flow: 'eft_ozow', config: cfg });
  const v = verifyJwtHs256(f.fields.Token, cfg.jwtSecret);
  assert.equal(v.claims.notificationURL, 'https://pleasepayme.co.za/api/webhooks/adumo');
  assert.equal(f.fields.flow, 'EFT_OZOW');
  const plain = buildVirtualCheckout({ amountCents: 3800, merchantReference: 'PRFMXNPV-1', successUrl: 'https://x/y', failUrl: 'https://x/z', flow: 'bitcoin', config: cfg });
  assert.ok(!('flow' in plain.fields), 'an unknown flow falls back to the options page');
  assert.ok(!('notificationURL' in verifyJwtHs256(plain.fields.Token, cfg.jwtSecret).claims));
  assert.throws(() => buildVirtualCheckout({ amountCents: 3800, merchantReference: 'PRFMXNPV-1', successUrl: 'https://x/y', failUrl: 'https://x/z', notificationUrl: 'http://evil/hook', config: { ...cfg, sandbox: false } }), /https/);
  assert.equal(adumoFlow('OTT_VOUCHER'), 'OTT_VOUCHER'); assert.equal(adumoFlow(''), null); assert.deepEqual([...ADUMO_FLOWS].slice(0, 2), ['CARD', 'CARD_VERIFICATION']);
});

test('response extras: method, masked PAN, bank error and card country are read from the unsigned fields for the books, never for the decision', () => {
  const good = { cuid: cfg.merchantId, auid: cfg.applicationId, mref: 'PRFMXNPV-1', amount: 38, result: 0, status: 'APPROVED', transactionIndex: 'ABC-123', puid: 'p-1' };
  const fields = { _RESPONSE_TOKEN: signJwtHs256(good, cfg.jwtSecret), _PAYMETHOD: 'ePay Virtual', _PANHASHED: '411111******1111', _CARDCOUNTRY: 'ZA', _3DSTATUS: '5', _ACQUIRERDATETIME: '2026/09/29 10:00:00 AM' };
  const v = verifyAdumoResponse({ fields, expected: { mref: 'PRFMXNPV-1', amountCents: 3800 }, config: cfg });
  assert.equal(v.approved, true); assert.equal(v.method, 'ePay Virtual'); assert.equal(v.methodClass, 'CARD'); assert.equal(v.panMasked, '411111******1111'); assert.equal(v.cardCountry, 'ZA'); assert.equal(v.puid, 'p-1');
  const bad = verifyAdumoResponse({ fields: { ...fields, _PANHASHED: '4111111111111111' }, expected: { mref: 'PRFMXNPV-1', amountCents: 3800 }, config: cfg });
  assert.equal(bad.panMasked, null, 'a full PAN is never kept');
  const declined = verifyAdumoResponse({ fields: { _RESPONSE_TOKEN: signJwtHs256({ ...good, result: -1, status: 'DECLINED' }, cfg.jwtSecret), _BANK_ERROR_CODE: '51', _BANK_ERROR_MESSAGE: 'Insufficient funds', _PAYMETHOD: 'SID' }, expected: { mref: 'PRFMXNPV-1', amountCents: 3800 }, config: cfg });
  assert.equal(declined.approved, false); assert.equal(declined.bankErrorCode, '51'); assert.equal(declined.methodClass, 'EFT');
  // unsigned fields never flip the decision
  const forged = verifyAdumoResponse({ fields: { _RESPONSE_TOKEN: signJwtHs256({ ...good, result: -1 }, cfg.jwtSecret), _RESULT: '0', _STATUS: 'APPROVED' }, expected: { mref: 'PRFMXNPV-1', amountCents: 3800 }, config: cfg });
  assert.equal(forged.approved, false);
  assert.equal(adumoMethodClass('Capitec Pay'), 'EFT'); assert.equal(adumoMethodClass('OTT Voucher'), 'VOUCHER'); assert.equal(adumoMethodClass('Apple Pay'), 'WALLET'); assert.equal(adumoMethodClass(''), null);
  const rec = adumoOutcomeRecord(v, { via: 'return', now: new Date('2026-09-29T10:00:00Z') });
  assert.equal(rec.adumoOutcome.via, 'return'); assert.equal(rec.adumoOutcome.panMasked, '411111******1111'); assert.equal(rec.adumoOutcome.at, '2026-09-29T10:00:00.000Z');
  assert.ok(!('claims' in rec.adumoOutcome) && !JSON.stringify(rec).includes('eyJ'), 'no token in the record');
});

/** A scripted Adumo: one token endpoint, one getState endpoint, a call log. */
function fakeAdumo({ tokenStatus = 200, states = {}, expiresIn = 600 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, auth: init?.headers?.Authorization || null });
    const u = new URL(url);
    if (u.pathname === ADUMO_TOKEN_PATH) {
      if (u.searchParams.get('grant_type') !== 'client_credentials' || !u.searchParams.get('client_id') || !u.searchParams.get('client_secret')) return { status: 400, text: async () => '{}' };
      return { status: tokenStatus, text: async () => JSON.stringify(tokenStatus === 200 ? { access_token: `tok-${calls.length}`, token_type: 'bearer', expires_in: expiresIn } : { error: 'invalid_client' }) };
    }
    if (u.pathname.startsWith(ADUMO_GETSTATE_PATH)) {
      if (!/^Bearer tok-/.test(init?.headers?.Authorization || '')) return { status: 401, text: async () => '{}' };
      const key = u.pathname === ADUMO_GETSTATE_PATH ? u.searchParams.get('merchantReference') : u.pathname.slice(ADUMO_GETSTATE_PATH.length + 1);
      const body = states[key];
      if (!body) return { status: 404, text: async () => '{}' };
      return { status: 200, text: async () => JSON.stringify(body) };
    }
    return { status: 500, text: async () => 'nope' };
  };
  return { calls, fetchImpl };
}
const rcfg = { base: 'https://staging-apiv3.adumoonline.com', clientId: 'cid', clientSecret: 'sec', applicationId: cfg.applicationId, merchantId: cfg.merchantId };
const settledBody = (mref, amount = 38) => ({ paymentType: 'CARD', transactionState: 'SETTLED', currencyCode: 'ZAR', countryCode: 'ZAF', merchantReference: mref, amount, authorisedAmount: amount, settledAmount: amount, refundedAmount: 0, errorMessage: '' });

test('reporting client: OAuth client credentials on the apiv3 host, cached until a minute before expiry, refreshed after', async () => {
  let t = 1_000_000;
  const { calls, fetchImpl } = fakeAdumo({ states: { 'PRFMXNPV-1': settledBody('PRFMXNPV-1') }, expiresIn: 600 });
  const client = new AdumoReportingClient({ config: rcfg, fetchImpl, now: () => t });
  const a = await client.getStateByMerchantReference('PRFMXNPV-1');
  assert.equal(a.found, true); assert.equal(a.state.settled, true); assert.equal(a.state.settledCents, 3800); assert.equal(a.state.transactionState, 'SETTLED');
  assert.equal(calls[0].url, `${rcfg.base}${ADUMO_TOKEN_PATH}?grant_type=client_credentials&client_id=cid&client_secret=sec`); assert.equal(calls[0].method, 'POST');
  assert.equal(calls[1].url, `${rcfg.base}${ADUMO_GETSTATE_PATH}?merchantReference=PRFMXNPV-1&applicationUid=${cfg.applicationId}`); assert.equal(calls[1].auth, 'Bearer tok-1');
  t += 500_000; // inside the 600 s minus 60 s window
  await client.getStateByMerchantReference('PRFMXNPV-1');
  assert.equal(calls.filter((c) => c.url.includes(ADUMO_TOKEN_PATH)).length, 1, 'token reused');
  t += 60_000; // past it
  await client.getStateByMerchantReference('PRFMXNPV-1');
  assert.equal(calls.filter((c) => c.url.includes(ADUMO_TOKEN_PATH)).length, 2, 'token refreshed');
  const missing = await client.getStateByMerchantReference('PRNOPE-1');
  assert.equal(missing.found, false);
  await assert.rejects(() => new AdumoReportingClient({ config: rcfg, fetchImpl: fakeAdumo({ tokenStatus: 401 }).fetchImpl, now: () => t }).token(), /OAuth failed/);
  assert.throws(() => new AdumoReportingClient({ config: { ...rcfg, clientSecret: '' } }), /not configured/);
  assert.equal(adumoReportingConfigured({ ADUMO_CLIENT_ID: 'a', ADUMO_CLIENT_SECRET: 'b' }), true);
  assert.equal(adumoReportingConfig({ ADUMO_SANDBOX: 'true' }).base, 'https://staging-apiv3.adumoonline.com');
  assert.equal(adumoReportingConfig({}).base, 'https://apiv3.adumoonline.com');
});

test('states: AUTHORISED (the hosted page end state, staging 2026-09-29) and SETTLED credit; the TDS states wait; refunds, reversals and declines never credit', () => {
  assert.deepEqual(classifyAdumoState('SETTLED'), { settled: true, pending: false, failed: false });
  assert.deepEqual(classifyAdumoState('AUTHORISED'), { settled: true, pending: false, failed: false });
  for (const s of ['TDS_AUTH_REQUIRED', 'TDS_AUTH_NOT_REQUIRED']) assert.equal(classifyAdumoState(s).pending, true, s);
  for (const s of ['REFUNDED', 'REVERSED', 'DECLINED', 'FAILED']) assert.equal(classifyAdumoState(s).failed, true, s);
  assert.equal(classifyAdumoState('SOMETHING_NEW').unknown, true);
  const n = normaliseState({ transactionState: 'SETTLED', amount: 38.5, settledAmount: '38.50', refundedAmount: 0 });
  assert.equal(n.amountCents, 3850); assert.equal(n.settledCents, 3850); assert.equal(n.refundedCents, 0);
});

function stubPrisma(rows) {
  return {
    _rows: rows,
    providerRequest: {
      async findMany({ where = {}, take }) { return rows.filter((r) => r.provider === where.provider && r.status === where.status && (!where.requestTs?.lt || r.requestTs < where.requestTs.lt)).slice(0, take).map((r) => ({ ...r })); },
      async update({ where, data }) { const r = rows.find((x) => x.idemKey === where.idemKey); Object.assign(r, data); return { ...r }; },
    },
  };
}
const intent = (code, { status = 'PENDING', ageMs = 10 * 60 * 1000, gross = 3800 } = {}) => ({ id: `i-${code}`, idemKey: `wapay-payreq-${code}`, provider: 'ADUMO', route: 'payrequest', status, requestTs: new Date(Date.now() - ageMs), metadata: { accountId: 'acc-1', amountCents: gross - 100, feeCents: 100, grossCents: gross, requestCode: code, adumoRef: `${code}-1`, payerMsisdn: '0787051175' } });

test('reconcile: SETTLED with the same gross settles once through the shared settlement; anything else touches no money', async () => {
  const settled = [];
  const settle = async ({ intent: it, rail, providerRef }) => { settled.push([it.metadata.requestCode, rail, providerRef]); return { ok: true, replayed: false }; };
  const rows = [intent('PRAAAAAA'), intent('PRBBBBBB'), intent('PRCCCCCC'), intent('PRHHHHHH'), intent('PRDDDDDD', { ageMs: 60 * 1000 }), intent('PREEEEEE', { status: 'SUCCESS' })];
  const { fetchImpl } = fakeAdumo({ states: {
    'PRAAAAAA-1': { ...settledBody('PRAAAAAA-1'), transactionId: 'tx-a' },
    'PRBBBBBB-1': { ...settledBody('PRBBBBBB-1'), transactionState: 'AUTHORISED', settledAmount: 0, transactionId: 'tx-b' }, // the hosted page's end state
    'PRCCCCCC-1': { ...settledBody('PRCCCCCC-1', 20), settledAmount: 20 },
    'PRHHHHHH-1': { ...settledBody('PRHHHHHH-1'), transactionState: 'TDS_AUTH_REQUIRED', authorisedAmount: 0, settledAmount: 0 },
  } });
  const client = new AdumoReportingClient({ config: rcfg, fetchImpl, now: () => Date.now() });
  const prisma = stubPrisma(rows);
  const out = await reconcileAdumoIntents({ prisma, client, settle, olderThanMs: 5 * 60 * 1000 });
  assert.deepEqual(out.map((r) => [r.mref, r.status, r.found ?? null, r.mismatch || r.transactionState || null]), [
    ['PRAAAAAA-1', 'SETTLED', true, null],
    ['PRBBBBBB-1', 'SETTLED', true, null],
    ['PRCCCCCC-1', 'PENDING', true, 'AMOUNT'],
    ['PRHHHHHH-1', 'PENDING', true, 'TDS_AUTH_REQUIRED'],
  ], 'the young row and the SUCCESS row are not swept');
  assert.deepEqual(settled, [['PRAAAAAA', 'ADUMO', 'tx-a'], ['PRBBBBBB', 'ADUMO', 'tx-b']], 'one credit each for the settled and the authorised matching rows, with Adumo\'s transaction id as the reference');
  assert.equal(rows[0].metadata.adumoReport.transactionState, 'SETTLED'); assert.equal(rows[2].metadata.adumoReport.mismatch, 'AMOUNT');
  // a transport failure changes nothing
  const boom = new AdumoReportingClient({ config: rcfg, fetchImpl: async () => { throw new Error('ECONNRESET'); }, now: () => Date.now() });
  const r = await reconcileAdumoIntent({ prisma, client: boom, settle, intent: intent('PRFFFFFF') });
  assert.equal(r.status, 'PENDING'); assert.equal(r.checked, false); assert.equal(settled.length, 2, 'a transport failure credits nothing');
  assert.equal((await reconcileAdumoIntent({ prisma, client, settle, intent: { ...intent('PRGGGGGG'), metadata: { requestCode: 'PRGGGGGG' } } })).error, 'NO_REFERENCE');
});

test('static: checkout passes the webhook claim and the flow; return + webhook record the outcome before deciding; probe and cron routes are gated and cannot pay', () => {
  const checkout = read('../pages/api/pay/checkout.js');
  assert.match(checkout, /notificationUrl: `\$\{base\}\/api\/webhooks\/adumo`/);
  assert.match(checkout, /flow: adumoFlow\(req\.method === 'POST' \? req\.body\?\.flow : req\.query\?\.flow\)/);
  const ret = read('../pages/api/pay/adumo-return.js');
  assert.ok(ret.indexOf('adumoOutcomeRecord(v, { via: \'return\' })') > ret.indexOf('verifyAdumoResponse(') && ret.indexOf('adumoOutcomeRecord(v') < ret.indexOf('if (!v.approved)'), 'recorded after verification, before the decision');
  assert.ok(ret.indexOf('adumoOutcomeRecord(v') < ret.indexOf('settleCardPayment('));
  const hook = read('../pages/api/webhooks/adumo.js');
  assert.match(hook, /adumoOutcomeRecord\(v, \{ via: 'webhook' \}\)/);
  const probe = read('../pages/api/internal/adumo-status.js');
  assert.match(probe, /if \(req\.method !== 'GET'\) return res\.status\(405\)/); assert.match(probe, /timingSafeEqual/); assert.match(probe, /Cache-Control', 'private, no-store'/);
  assert.ok(!/buildVirtualCheckout|settleCardPayment|initialisevirtual|postEntry/.test(probe), 'the probe cannot start or settle a payment');
  assert.match(probe, /clientSecret: !!r\.clientSecret/); assert.ok(!/clientSecret: r\.clientSecret|jwtSecret: c\.jwtSecret\b/.test(probe), 'secrets are presence-only');
  const cron = read('../pages/api/cron/adumo-reconcile.js');
  assert.match(cron, /x-vercel-cron/); assert.match(cron, /CRON_SECRET/); assert.match(cron, /requireInternalAuth\(req, res\)/);
  assert.match(cron, /reconcileAdumoIntents\(\{ olderThanMs, limit/); assert.ok(!/buildVirtualCheckout|initialisevirtual/.test(cron));
  const lib = read('../lib/adumo-reporting.js');
  assert.ok(!/GetAPIKey/.test(lib)); assert.match(lib, /if \(st\.settled\) \{/); assert.match(lib, /paidCents !== gross/);
});
