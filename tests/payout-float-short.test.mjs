/**
 * BUGLOG #129 (2026-10-20): the pay-out float ran dry and 23 pay-outs were rejected by the
 * rail while the chat blamed the customer's bank. Now: the float is read before any ledger
 * move and a short float refuses honestly, the rail's own "insufficient funds" is named as
 * our float, the operator is alerted, and the customer hears the truth.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requestPayout } from '../lib/payouts.js';
import { proofFor } from './helpers/pin-proof.mjs';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
function env() {
  process.env.WAPAY_PAYOUT_ENABLED = 'true';
  process.env.OTT_PAYOUT_BASE_URL = 'https://test-payoutapi.example';
  process.env.OTT_PAYOUT_USERNAME = 'u'; process.env.OTT_PAYOUT_PASSWORD = 'p'; process.env.OTT_PAYOUT_API_KEY = 'k';
  process.env.WAPAY_PAYOUT_KYC = 'off';
}
function stubPrisma() {
  const prs = [];
  return {
    _prs: prs,
    providerRequest: {
      async findUnique({ where }) { const r = prs.find((x) => x.idemKey === where.idemKey); return r ? { ...r } : null; },
      async findMany() { return prs.map((r) => ({ ...r })); },
      async create({ data }) { const row = { id: `pr${prs.length + 1}`, requestTs: new Date(), providerRef: null, ...data }; prs.push(row); return { ...row }; },
      async update({ where, data }) { const r = prs.find((x) => x.idemKey === where.idemKey); Object.assign(r, data); return { ...r }; },
    },
    wallet: { async findMany() { return [{ balanceType: 'SPEND', availableCents: 500000 }, { balanceType: 'CASH', availableCents: 0 }]; } },
  };
}
function stubLedger() {
  const calls = []; const holds = new Map();
  return {
    calls, holds,
    async ensureWallet() { calls.push('ensureWallet'); },
    async postEntry(e) { calls.push(`post:${e.source}`); return { idemKey: e.idemKey }; },
    async reserveHold({ idemKey, amountCents }) { calls.push('reserveHold'); holds.set(idemKey, { amountCents, status: 'ACTIVE' }); return {}; },
    async settleHold({ idemKey, entry }) { calls.push(`settleHold:${entry.source}`); holds.get(idemKey).status = 'SETTLED'; },
    async releaseHold({ idemKey }) { calls.push('releaseHold'); holds.get(idemKey).status = 'RELEASED'; },
  };
}
const providers = [{ method: 'PAYSHAP', label: 'PayShap', providerCode: '66', providerName: 'PayShap Account', minCents: 5000, maxCents: 300000 }];
const account = { id: 'acc-float', msisdn: '27731234567', profile: {} };
const recipient = { firstname: 'Lerato', surname: 'M', mobile: '073 123 4567', account_number: '62012345678', branch_code: '250655', branch_name: 'FNB', id_number: '9001015009087' };
const call = (over = {}) => requestPayout({ prisma: stubPrisma(), ledger: stubLedger(), account, intentId: over.intentId || 'intent-0001', method: 'PAYSHAP', amountCents: 99200, recipient, providers, authorization: proofFor(account, { intentId: over.intentId || 'intent-0001', amountCents: 99200 }), ...over });

test('a float that cannot cover the pay-out refuses before any ledger move, records FLOAT_SHORT, and alerts once', async () => {
  env();
  const prisma = stubPrisma(); const ledger = stubLedger(); const alerts = [];
  const out = await call({ prisma, ledger, readFloat: async () => ({ configured: true, balanceCents: 87280, error: null }), alertFloat: async (a) => { alerts.push(a); return true; } });
  assert.equal(out.ok, false); assert.equal(out.error, 'FLOAT_SHORT'); assert.equal(out.floatCents, 87280); assert.equal(out.alerted, true);
  assert.deepEqual(ledger.calls, [], 'nothing moved, nothing held');
  assert.equal(prisma._prs[0].status, 'FAILED'); assert.equal(prisma._prs[0].metadata.outcome, 'FLOAT_SHORT'); assert.equal(prisma._prs[0].metadata.needCents, 99200 + 288 + 100);
  assert.equal(alerts.length, 1); assert.equal(alerts[0].amountCents, 99200); assert.equal(alerts[0].method, 'PAYSHAP');
});

test('an unreadable float lets the rail decide; a float that covers it pays', async () => {
  env();
  const settle = { settlement: 'SETTLE', outcome: 'SETTLED', status: 100, paymentReference: 'OTT1' };
  const client = { async performPayout() { return settle; }, async getPaymentStatus() { return {}; } };
  const a = await call({ client, readFloat: async () => ({ configured: true, balanceCents: null, error: 'REJECTED' }), alertFloat: async () => true });
  assert.equal(a.ok, true); assert.equal(a.status, 'SETTLED');
  const b = await call({ client, intentId: 'intent-0002', readFloat: async () => ({ configured: true, balanceCents: 500000 }), alertFloat: async () => true });
  assert.equal(b.ok, true);
});

test('the rail answering "insufficient funds" is our float: FLOAT_SHORT, the hold released, the operator alerted; another rejection stays PAYOUT_REJECTED', async () => {
  env();
  const prisma = stubPrisma(); const ledger = stubLedger(); const alerts = [];
  const rail = { async performPayout() { return { settlement: 'RELEASE', outcome: 'PAYOUT_REJECTED', status: 0, httpStatus: 400, body: { status: 0, message: 'Insufficient funds for this transaction - 994.88' } }; }, async getPaymentStatus() { return {}; } };
  const out = await call({ prisma, ledger, client: rail, readFloat: async () => ({ configured: true, balanceCents: null }), alertFloat: async (a) => { alerts.push(a); return true; } });
  assert.equal(out.error, 'FLOAT_SHORT'); assert.equal(out.alerted, true); assert.equal(prisma._prs[0].metadata.outcome, 'FLOAT_SHORT');
  assert.ok(ledger.calls.includes('releaseHold'), 'the hold came back'); assert.equal(alerts.length, 1);
  const other = { async performPayout() { return { settlement: 'RELEASE', outcome: 'PAYOUT_REJECTED', status: 0, httpStatus: 400, body: { status: 0, message: 'Failed to retrieve record' } }; }, async getPaymentStatus() { return {}; } };
  const o = await call({ intentId: 'intent-0003', client: other, readFloat: async () => ({ configured: true, balanceCents: null }), alertFloat: async () => { throw new Error('must not be called'); } });
  assert.equal(o.error, 'PAYOUT_REJECTED'); assert.equal(o.alerted, undefined);
});

test('the customer hears the truth: our account is being topped up, nothing left the balance, no bank blamed', () => {
  const chat = read('../lib/payout-chat.js');
  assert.match(chat, /if \(out\.error === 'FLOAT_SHORT'\) \{/);
  assert.match(chat, /This withdrawal could not be made right now: our pay-out account is being topped up\. Nothing has left your balance and your money is safe\./);
  assert.match(chat, /\$\{out\.alerted \? '; a person from the WaPay team has been told' : ''\}/, 'a person is named only when the alert went');
  const p = read('../lib/payouts.js');
  assert.match(p, /const needCents = amountCents \+ cashoutRailCostCents\(method, amountCents\) \+ 100;/);
  assert.match(p, /const floatShort = \/insufficient funds\/i\.test\(String\(result\.body\?\.message \|\| ''\)\);/);
  assert.match(p, /key: `float-empty:\$\{bucket\}`/, 'one alert per ten-minute window');
});
