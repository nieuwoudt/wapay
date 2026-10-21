import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.WAPAY_INTERNAL_API_KEY ||= 'test-internal-key-for-proofs';
const { opsPayout } = await import('../lib/ops-payout.js');
const { verifyPinProof } = await import('@wapay/auth/pin-proof');

const account = { id: 'acc1', waId: '27830000000', displayName: 'Thandi', profile: {} };
const db = { account: { findUnique: async ({ where }) => (where.id === 'acc1' ? account : null) }, auditLog: { create: async () => ({}) } };
function deps(over = {}) {
  const calls = { rail: [], touched: 0, audit: [], sent: [] };
  const d = {
    listDestinations: async () => [{ id: 'd1', method: 'PAYSHAP', label: 'TymeBank account •••595', timesUsed: 4 }],
    loadDestination: async () => ({ id: 'd1', method: 'PAYSHAP', account_number: '1234567595', branch_code: '678000', branch_name: 'TymeBank' }),
    loadIdentity: async () => ({ fullName: 'Ncamsile Jele', idType: 'RSAID', idNumber: '9001010000083' }),
    identityOnFile: async () => ({ fullName: 'Ncamsile Jele', idType: 'RSAID', idLast3: '083' }),
    touchDestination: async () => { calls.touched++; },
    requestPayout: async (args) => { calls.rail.push(args); return { ok: true, status: 'SETTLED', reference: 'REF1' }; },
    balances: async () => ({ spendCents: 287240, cashCents: 0, totalCents: 287240 }),
    rules: async () => ({ ok: true }),
    freeze: async () => null,
    float: async () => ({ balanceCents: 1765652 }),
    enabled: () => true,
    configured: () => true,
    audit: async (r) => { calls.audit.push(r); },
    send: async (m) => { calls.sent.push(m); return { ok: true }; },
    ...over,
  };
  return { d, calls };
}

test('dry run reads everything, masks numbers and calls no rail', async () => {
  const { d, calls } = deps();
  const out = await opsPayout({ prisma: db, accountId: 'acc1', amountCents: 'max', deps: d });
  assert.equal(out.ok, true);
  assert.equal(out.dryRun, true);
  assert.equal(calls.rail.length, 0);
  assert.equal(out.quote.totalCents <= 287240, true);
  assert.equal(out.account.phone, '•••000');
  assert.equal(JSON.stringify(out).includes('1234567595'), false);
  assert.equal(JSON.stringify(out).includes('9001010000083'), false);
  assert.deepEqual(out.blockers, []);
});

test('live run pays the saved destination with a STEP_UP proof the verifier accepts, audits and tells the customer', async () => {
  const { d, calls } = deps();
  const out = await opsPayout({ prisma: db, accountId: 'acc1', amountCents: 100000, by: 'founder', reason: 'restriction period', dryRun: false, deps: d });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(calls.rail.length, 1);
  const call = calls.rail[0];
  assert.equal(call.method, 'PAYSHAP');
  assert.equal(call.amountCents, 100000);
  assert.equal(call.recipient.account_number, '1234567595');
  assert.equal(call.recipient.id_number, '9001010000083');
  assert.equal(call.recipient.firstname, 'Ncamsile');
  assert.equal(call.recipient.mobile, '27830000000');
  const v = verifyPinProof(call.authorization, { accountId: 'acc1', intentId: call.intentId, amountCents: 100000 });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.via, 'STEP_UP');
  assert.equal(calls.touched, 1);
  assert.equal(calls.audit[0].event, 'OPS_PAYOUT');
  assert.equal(calls.audit[0].metadata.by, 'founder');
  assert.equal(calls.sent.length, 1);
  assert.equal(JSON.stringify(out).includes('1234567595'), false);
});

test('refuses without a chosen destination when several are saved, and without a reason on a live run', async () => {
  const { d } = deps({ listDestinations: async () => [{ id: 'd1', method: 'PAYSHAP', label: 'A' }, { id: 'd2', method: 'CASHSEND', label: 'B' }] });
  const out = await opsPayout({ prisma: db, accountId: 'acc1', amountCents: 10000, deps: d });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'NEED_DESTINATION');
  assert.equal(out.destinations.length, 2);
  const { d: d2, calls } = deps();
  const live = await opsPayout({ prisma: db, accountId: 'acc1', amountCents: 10000, dryRun: false, deps: d2 });
  assert.equal(live.ok, false);
  assert.equal(live.error, 'NEED_REASON');
  assert.equal(calls.rail.length, 0);
});

test('blockers stop a live run before the rail: frozen, rules, disabled', async () => {
  const { d, calls } = deps({ freeze: async () => ({ frozen: true, reason: 'check' }), rules: async () => ({ ok: false, error: 'KYC_REQUIRED' }), enabled: () => false });
  const out = await opsPayout({ prisma: db, accountId: 'acc1', amountCents: 10000, by: 'founder', reason: 'x', dryRun: false, deps: d });
  assert.equal(out.ok, false);
  assert.deepEqual(out.blockers, ['DISABLED', 'FROZEN', 'KYC_REQUIRED']);
  assert.equal(calls.rail.length, 0);
});
