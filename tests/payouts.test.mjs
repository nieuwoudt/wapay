/**
 * Payouts (lib/payouts.js): the ledger sequence around OTT's payout rail,
 * driven with an in-memory prisma, an in-memory ledger and a scripted OTT
 * client. No network, no bank: the contract is the outcome per OTT status.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  requestPayout, finalisePayout, quotePayout, payoutReference, cleanRecipient, resolveProviders, _resetProviderCache,
  payoutEnabled, accountKycVerified, MIN_PAYOUT_CENTS, MAX_PAYOUT_CENTS, listPayouts,
} from '../lib/payouts.js';

function env(on = true) {
  process.env.WAPAY_PAYOUT_ENABLED = on ? 'true' : '';
  process.env.OTT_PAYOUT_BASE_URL = 'https://test-payoutapi.example';
  process.env.OTT_PAYOUT_USERNAME = 'u'; process.env.OTT_PAYOUT_PASSWORD = 'p'; process.env.OTT_PAYOUT_API_KEY = 'k';
  delete process.env.WAPAY_PAYOUT_KYC;
}
function stubPrisma() {
  const prs = [];
  return {
    _prs: prs,
    providerRequest: {
      async findUnique({ where }) { const r = prs.find((x) => x.idemKey === where.idemKey); return r ? { ...r } : null; },
      async findMany({ where = {}, take }) {
        let rows = prs.filter((x) => (!where.route || x.route === where.route) && (!where.accountId || x.accountId === where.accountId));
        if (where.metadata?.path) rows = rows.filter((x) => x.metadata?.[where.metadata.path[0]] === where.metadata.equals);
        return (take ? rows.slice(0, take) : rows).map((r) => ({ ...r }));
      },
      async create({ data }) { const row = { id: `pr${prs.length + 1}`, requestTs: new Date(), providerRef: null, ...data }; prs.push(row); return { ...row }; },
      async update({ where, data }) { const r = prs.find((x) => x.idemKey === where.idemKey); Object.assign(r, data); return { ...r }; },
    },
    wallet: { async findMany() { return [{ balanceType: 'SPEND', availableCents: 50000 }, { balanceType: 'CASH', availableCents: 0 }]; } },
  };
}
function stubLedger({ spendCents = 100000 } = {}) {
  const calls = [];
  const holds = new Map();
  let spend = spendCents; let cash = 0;
  return {
    calls, holds,
    get spend() { return spend; }, get cash() { return cash; },
    async ensureWallet() { calls.push('ensureWallet'); },
    async postEntry(e) {
      calls.push(`post:${e.source}`);
      if (e.source === 'BALANCE_UPGRADE') { const amt = e.postings[0].debitCents; if (spend < amt) { const err = new Error('Insufficient funds'); err.name = 'InsufficientFundsError'; throw err; } spend -= amt; cash += amt; }
      if (e.source === 'BALANCE_DOWNGRADE') { const amt = e.postings[0].debitCents; cash -= amt; spend += amt; }
      return { idemKey: e.idemKey };
    },
    async reserveHold({ idemKey, amountCents }) { calls.push('reserveHold'); if (holds.has(idemKey)) return { replayed: true }; holds.set(idemKey, { amountCents, status: 'ACTIVE' }); cash -= amountCents; return { holdId: idemKey, status: 'ACTIVE' }; },
    async settleHold({ idemKey, entry }) { calls.push(`settleHold:${entry.source}`); const h = holds.get(idemKey); h.status = 'SETTLED'; },
    async releaseHold({ idemKey }) { calls.push('releaseHold'); const h = holds.get(idemKey); h.status = 'RELEASED'; cash += h.amountCents; },
  };
}
const providers = [{ method: 'PAYSHAP', label: 'PayShap', providerCode: '7', providerName: 'PayShap' }, { method: 'CASHSEND', label: 'CashSend', providerCode: '9', providerName: 'ABSA CashSend' }];
const kycd = { id: 'acc-1', msisdn: '27731234567', profile: { kyc: { status: 'VERIFIED' } } };
const recipient = { firstname: 'Lerato', surname: 'M', mobile: '073 123 4567', account_number: '62012345678', branch_code: '250655', branch_name: 'FNB' };
function client(script) { const calls = []; return { calls, async performPayout(args) { calls.push(args); return typeof script === 'function' ? script(args) : script; }, async getPaymentStatus() { return {}; } }; }

test('quote + reference + recipient cleaning', () => {
  env();
  const q = quotePayout({ method: 'PAYSHAP', amountCents: 50000 });
  assert.equal(q.feeCents, 800, 'PayShap flat R8 (ledger-core bands, +R2 margin 2026-09-11)');
  assert.equal(q.totalCents, 50800);
  assert.throws(() => quotePayout({ method: 'PAYSHAP', amountCents: MIN_PAYOUT_CENTS - 1 }), /between/);
  assert.throws(() => quotePayout({ method: 'PAYSHAP', amountCents: MAX_PAYOUT_CENTS + 1 }), /between/);
  assert.throws(() => quotePayout({ method: 'BITCOIN', amountCents: 5000 }), /Unknown/);
  assert.match(payoutReference('payout-acc-1-abc'), /^WP[0-9A-F]{14}$/);
  assert.equal(payoutReference('x'), payoutReference('x'), 'deterministic, epoch-free');
  const r = cleanRecipient('PAYSHAP', recipient);
  assert.equal(r.mobile, '27731234567'); assert.equal(r.account_number, '62012345678');
  assert.throws(() => cleanRecipient('PAYSHAP', { firstname: 'A', surname: 'B' }), /Missing account_number/);
  assert.throws(() => cleanRecipient('CASHSEND', { firstname: 'A', surname: 'B', mobile: '12' }), /Missing mobile|Bad mobile/);
});

test('gates: disabled, KYC, bad intent — nothing touches the ledger', async () => {
  env(false);
  const ledger = stubLedger();
  assert.equal((await requestPayout({ prisma: stubPrisma(), ledger, account: kycd, intentId: 'intent-0001', method: 'PAYSHAP', amountCents: 50000, recipient, providers })).error, 'DISABLED');
  env();
  assert.equal((await requestPayout({ prisma: stubPrisma(), ledger, account: { id: 'acc-2', profile: {} }, intentId: 'intent-0001', method: 'PAYSHAP', amountCents: 50000, recipient, providers })).error, 'KYC_REQUIRED');
  assert.equal((await requestPayout({ prisma: stubPrisma(), ledger, account: kycd, intentId: 'x', method: 'PAYSHAP', amountCents: 50000, recipient, providers })).error, 'BAD_INTENT');
  assert.equal((await requestPayout({ prisma: stubPrisma(), ledger, account: kycd, intentId: 'intent-0001', method: 'PAYSHAP', amountCents: 100, recipient, providers })).error, 'BAD_AMOUNT');
  assert.deepEqual(ledger.calls, [], 'no ledger call for any refused request');
  process.env.WAPAY_PAYOUT_KYC = 'off';
  assert.equal(accountKycVerified({ profile: {} }), false);
  const r = await requestPayout({ prisma: stubPrisma(), ledger: stubLedger(), client: client({ status: '100', settlement: 'SETTLE', outcome: 'SUCCESS', paymentReference: 'OTT1' }), account: { id: 'acc-2', profile: {} }, intentId: 'intent-0002', method: 'PAYSHAP', amountCents: 50000, recipient, providers });
  assert.equal(r.status, 'SETTLED', 'sandbox switch skips KYC');
  delete process.env.WAPAY_PAYOUT_KYC;
});

test('status 100: upgrade → hold → pay → settle (cashout) + rail cost; recorded SUCCESS; replay is a no-op', async () => {
  env();
  const prisma = stubPrisma(); const ledger = stubLedger(); const c = client({ status: '100', settlement: 'SETTLE', outcome: 'SUCCESS', paymentReference: 'OTT-REF-1' });
  const r = await requestPayout({ prisma, ledger, client: c, account: kycd, intentId: 'intent-1000', method: 'PAYSHAP', amountCents: 50000, recipient, providers });
  assert.equal(r.ok, true); assert.equal(r.status, 'SETTLED'); assert.equal(r.feeCents, 800); assert.equal(r.providerRef, 'OTT-REF-1');
  assert.deepEqual(ledger.calls, ['ensureWallet', 'post:BALANCE_UPGRADE', 'reserveHold', 'settleHold:CASHOUT_PAYSHAP', 'post:CASHOUT_COST_PAYSHAP']);
  assert.equal(c.calls[0].amountCents, 50000); assert.equal(c.calls[0].providerCode, '7'); assert.match(c.calls[0].yourUniqueReference, /^WP/);
  assert.equal(c.calls[0].recipient.mobile, '27731234567');
  assert.equal(prisma._prs[0].status, 'SUCCESS'); assert.equal(prisma._prs[0].providerRef, 'OTT-REF-1');
  assert.equal(prisma._prs[0].metadata.recipient.account, '•••678', 'recipient stored masked');
  assert.equal(ledger.spend, 100000 - 50800, 'amount + fee left SPEND'); assert.equal(ledger.cash, 0, 'and CASH after settle');
  const again = await requestPayout({ prisma, ledger, client: c, account: kycd, intentId: 'intent-1000', method: 'PAYSHAP', amountCents: 50000, recipient, providers });
  assert.equal(again.replayed, true); assert.equal(again.status, 'SETTLED'); assert.equal(c.calls.length, 1, 'the double submit never reaches OTT');
});

test('status 99/98 or a transport timeout: hold KEPT, recorded PENDING; the webhook finalises either way', async () => {
  env();
  for (const script of [{ status: '99', settlement: 'PENDING', outcome: 'PENDING_FINALISATION', paymentReference: 'P1' }, { status: null, settlement: 'PENDING', outcome: 'TRANSPORT_INDETERMINATE', reconcileRequired: true, paymentReference: null }]) {
    const prisma = stubPrisma(); const ledger = stubLedger();
    const r = await requestPayout({ prisma, ledger, client: client(script), account: kycd, intentId: 'intent-2000', method: 'PAYSHAP', amountCents: 20000, recipient, providers });
    assert.equal(r.status, 'PENDING');
    assert.deepEqual(ledger.calls, ['ensureWallet', 'post:BALANCE_UPGRADE', 'reserveHold'], 'never released, never settled');
    assert.equal(ledger.holds.get('payout-acc-1-intent-2000-hold').status, 'ACTIVE');
    assert.equal(prisma._prs[0].status, 'PENDING');
    // webhook: paid
    const done = await finalisePayout({ prisma, ledger, reference: r.reference, status: '100', message: 'Payment successful' });
    assert.equal(done.status, 'SETTLED'); assert.equal(prisma._prs[0].status, 'SUCCESS');
    assert.equal(ledger.holds.get('payout-acc-1-intent-2000-hold').status, 'SETTLED');
    assert.deepEqual((await finalisePayout({ prisma, ledger, reference: r.reference, status: '100' })), { ok: true, noop: true, status: 'SUCCESS' }, 'a repeat webhook is a no-op');
  }
  // webhook: failed at the provider → release + money back to SPEND
  const prisma = stubPrisma(); const ledger = stubLedger();
  const r = await requestPayout({ prisma, ledger, client: client({ status: '98', settlement: 'PENDING', outcome: 'PENDING' }), account: kycd, intentId: 'intent-2001', method: 'PAYSHAP', amountCents: 20000, recipient, providers });
  assert.equal((await finalisePayout({ prisma, ledger, reference: r.reference, status: '98' })).noop, true, 'still pending: nothing changes');
  const failed = await finalisePayout({ prisma, ledger, reference: r.reference, status: '97', message: 'Failed at provider' });
  assert.equal(failed.status, 'FAILED'); assert.equal(prisma._prs[0].status, 'FAILED');
  assert.equal(ledger.holds.get('payout-acc-1-intent-2001-hold').status, 'RELEASED');
  assert.equal(ledger.spend, 100000, 'the customer is whole again'); assert.equal(ledger.cash, 0);
  assert.equal((await finalisePayout({ prisma, ledger, reference: 'WPNOPE', status: '100' })).error, 'UNKNOWN_REFERENCE');
});

test('provider rejects (status 0 / 4 / 97 at request time): released, money back, recorded FAILED', async () => {
  env();
  const prisma = stubPrisma(); const ledger = stubLedger();
  const r = await requestPayout({ prisma, ledger, client: client({ status: '4', settlement: 'RELEASE', outcome: 'INVALID_MOBILE' }), account: kycd, intentId: 'intent-3000', method: 'CASHSEND', amountCents: 30000, recipient, providers });
  assert.equal(r.ok, false); assert.equal(r.status, 'FAILED'); assert.equal(r.error, 'INVALID_MOBILE');
  assert.deepEqual(ledger.calls, ['ensureWallet', 'post:BALANCE_UPGRADE', 'reserveHold', 'releaseHold', 'post:BALANCE_DOWNGRADE']);
  assert.equal(ledger.spend, 100000); assert.equal(ledger.cash, 0);
  assert.equal(prisma._prs[0].status, 'FAILED'); assert.equal(prisma._prs[0].metadata.outcome, 'INVALID_MOBILE');
});

test('insufficient balance: refused before any hold; no provider for the method: refused before any ledger call', async () => {
  env();
  const prisma = stubPrisma(); const ledger = stubLedger({ spendCents: 1000 });
  const r = await requestPayout({ prisma, ledger, client: client({}), account: kycd, intentId: 'intent-4000', method: 'PAYSHAP', amountCents: 50000, recipient, providers });
  assert.equal(r.error, 'INSUFFICIENT_FUNDS'); assert.equal(r.totalCents, 50800);
  assert.deepEqual(ledger.calls, ['ensureWallet', 'post:BALANCE_UPGRADE']); assert.equal(prisma._prs[0].status, 'FAILED');
  const l2 = stubLedger();
  const r2 = await requestPayout({ prisma: stubPrisma(), ledger: l2, client: client({}), account: kycd, intentId: 'intent-4001', method: 'RTC', amountCents: 50000, recipient, providers });
  assert.equal(r2.error, 'NO_PROVIDER'); assert.deepEqual(l2.calls, []);
});

test('providers resolve from OTT by name, never by hardcoded code; cached; history lists masked rows', async () => {
  _resetProviderCache();
  let calls = 0;
  const c = { async getActiveProviders() { calls += 1; return { providers: [{ providerCode: 12, providerName: 'PayShap Instant' }, { providerCode: 3, providerName: 'OTT VOUCHER' }, { providerCode: 5, providerName: 'Nedbank Cash Send' }] }; } };
  const list = await resolveProviders({ client: c, now: 1000 });
  assert.deepEqual(list.map((p) => [p.method, p.providerCode]), [['PAYSHAP', '12'], ['CASHSEND', '5']]);
  await resolveProviders({ client: c, now: 2000 });
  assert.equal(calls, 1, 'cached');
  _resetProviderCache();
  const prisma = stubPrisma();
  prisma._prs.push({ idemKey: 'k', route: 'ott-payout', accountId: 'acc-1', status: 'SUCCESS', requestTs: new Date(), providerRef: 'X', metadata: { reference: 'WPAAA', method: 'PAYSHAP', amountCents: 1000, feeCents: 600, recipient: { name: 'L M', account: '•••678' } } });
  const h = await listPayouts({ prisma, accountId: 'acc-1' });
  assert.equal(h[0].reference, 'WPAAA'); assert.equal(h[0].recipient.account, '•••678'); assert.equal(h[0].status, 'SUCCESS');
  assert.equal(payoutEnabled(), true);
});

test('routes: the payout API needs a fresh factor on every request and fails closed; the webhook verifies the hash first', () => {
  const route = readFileSync(fileURLToPath(new URL('../pages/api/business/payout.js', import.meta.url)), 'utf8');
  assert.match(route, /verifyStepUp\(\{ business, msisdn/, 'password or one-time code on every pay-out');
  assert.ok(route.indexOf('verifyStepUp(') < route.indexOf('requestPayout('), 'the factor is checked BEFORE any money moves');
  assert.match(route, /if \(!payoutEnabled\(\)\) return res\.status\(503\)/);
  const hook = readFileSync(fileURLToPath(new URL('../pages/api/webhooks/ott-payout.js', import.meta.url)), 'utf8');
  assert.ok(hook.indexOf('verifyPayoutWebhook(payload, apiKey)') < hook.indexOf('finalisePayout('), 'hash verified before finalising');
  assert.match(hook, /res\.status\(401\)\.json\(\{ ok: false, error: 'BAD_HASH' \}\)/);
});
