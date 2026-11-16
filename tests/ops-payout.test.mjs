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
    idFromRequests: async () => null,
    providers: async () => null,
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

test('"max" on a balance above the per-pay-out ceiling quotes the ceiling, not an error', async () => {
  const { d, calls } = deps({ balances: async () => ({ spendCents: 0, cashCents: 580710, totalCents: 580710 }) });
  const out = await opsPayout({ prisma: db, accountId: 'acc1', amountCents: 'max', deps: d });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.quote.amountCents <= out.maxPayoutCents, true);
  assert.equal(out.quote.amountCents + out.quote.feeCents <= 580710, true);
  assert.equal(calls.rail.length, 0);
});

// BUGLOG #147 (2026-11-09): OTT's live list asks PayShap for id_number; the dry run read only the static list.
const LIVE_PAYSHAP = [{ method: 'PAYSHAP', providerCode: '66', providerName: 'PayShap Account', requiredFields: ['firstname', 'surname', 'id_number', 'mobile', 'account_number', 'branch_code'] }];
const verified = { id: 'acc2', waId: '27830000111', displayName: 'Ncamsile', profile: { kyc: { status: 'VERIFIED', fullName: 'JELE Ncamsile', idNumberMasked: '••••••••••083' } } };
const db2 = { account: { findUnique: async ({ where }) => (where.id === 'acc2' ? verified : null) }, auditLog: { create: async () => ({}) } };
const noVault = { identityOnFile: async () => null, loadIdentity: async () => null, providers: async () => LIVE_PAYSHAP };

test('#147: the live list asks for an ID the vault does not hold: the dry run blocks in plain words and the live run never reaches the rail', async () => {
  const { cleanRecipient, requiredRecipientFields } = await import('../lib/payouts.js');
  // The incident itself: the rail's check, with the live list, refuses a recipient without an ID.
  assert.throws(() => cleanRecipient('PAYSHAP', { firstname: 'Ncamsile', surname: 'Jele', mobile: '27830000111', account_number: '1234567595', branch_code: '678000' }, LIVE_PAYSHAP[0].requiredFields), (e) => e.code === 'BAD_RECIPIENT' && e.field === 'id_number');
  assert.equal(requiredRecipientFields('PAYSHAP', LIVE_PAYSHAP[0].requiredFields).includes('id_number'), true);

  const { d, calls } = deps(noVault);
  const dry = await opsPayout({ prisma: db2, accountId: 'acc2', amountCents: 100000, deps: d });
  assert.equal(dry.ok, false);
  assert.deepEqual(dry.blockers, ['NO_IDENTITY']);
  assert.equal(dry.requiredFields.from, 'OTT');
  assert.match(dry.message, /ID number is not on file/);
  assert.match(dry.blockerDetails[0].text, /PayShap asks for one/);
  const live = await opsPayout({ prisma: db2, accountId: 'acc2', amountCents: 100000, by: 'founder', reason: 'x', dryRun: false, deps: d });
  assert.equal(live.ok, false);
  assert.equal(live.error, 'NO_IDENTITY');
  assert.equal(calls.rail.length, 0);

  // OTT's list unreadable: the dry run says it checked WaPay's static list instead, and blocks exactly when that list needs an ID.
  const { d: d3 } = deps({ ...noVault, providers: async () => { throw new Error('timeout'); } });
  const dry3 = await opsPayout({ prisma: db2, accountId: 'acc2', amountCents: 100000, deps: d3 });
  assert.equal(dry3.requiredFields.from, 'STATIC');
  assert.deepEqual(dry3.blockers, requiredRecipientFields('PAYSHAP').includes('id_number') ? ['NO_IDENTITY'] : []);
});

test('#147: vault empty, the ID typed on the last pay-out request is used when its name is the verified name; never shown in full', async () => {
  const fromRequest = { fullName: 'Ncamsile Jele', idNumber: '9001010000083', idType: 'RSAID', countryOfIssue: null, reference: 'WPOABC' };
  const { d, calls } = deps({ ...noVault, idFromRequests: async () => fromRequest });
  const dry = await opsPayout({ prisma: db2, accountId: 'acc2', amountCents: 100000, deps: d });
  assert.equal(dry.ok, true, JSON.stringify(dry.blockerDetails));
  assert.equal(dry.identity.source, 'LAST_PAYOUT_REQUEST');
  assert.equal(dry.identity.idLast3, '083');
  assert.equal(JSON.stringify(dry).includes('9001010000083'), false);
  const live = await opsPayout({ prisma: db2, accountId: 'acc2', amountCents: 100000, by: 'founder', reason: 'restriction', dryRun: false, deps: d });
  assert.equal(live.ok, true, JSON.stringify(live));
  assert.equal(calls.rail.length, 1);
  assert.equal(calls.rail[0].recipient.id_number, '9001010000083');
  assert.equal(calls.rail[0].recipient.firstname, 'JELE');
  assert.equal(calls.rail[0].recipient.mobile, '27830000111');
  assert.deepEqual(calls.rail[0].providers, LIVE_PAYSHAP, 'the rail validates against the list the dry run read');
  assert.equal(JSON.stringify(live).includes('9001010000083'), false);
});

test('#147: a request ID under another name, without a verified ID, or ending differently is never used', async () => {
  const cases = [
    { name: 'other name', found: { fullName: 'Sipho Dlamini', idNumber: '9001010000083', idType: 'RSAID' }, db: db2, text: /different name/ },
    { name: 'last three differ', found: { fullName: 'Ncamsile Jele', idNumber: '9001010000091', idType: 'RSAID' }, db: db2, text: /does not end like/ },
    { name: 'not verified', found: { fullName: 'Ncamsile Jele', idNumber: '9001010000083', idType: 'RSAID' }, db: { ...db2, account: { findUnique: async () => ({ ...verified, profile: { kyc: { status: 'PENDING', fullName: 'Ncamsile Jele' } } }) } }, text: /no verified ID/ },
  ];
  for (const c of cases) {
    const { d, calls } = deps({ ...noVault, idFromRequests: async () => c.found });
    const dry = await opsPayout({ prisma: c.db, accountId: 'acc2', amountCents: 100000, deps: d });
    assert.equal(dry.ok, false, c.name);
    assert.deepEqual(dry.blockers, ['NO_IDENTITY'], c.name);
    assert.match(dry.message, c.text, c.name);
    const live = await opsPayout({ prisma: c.db, accountId: 'acc2', amountCents: 100000, by: 'founder', reason: 'x', dryRun: false, deps: d });
    assert.equal(live.ok, false, c.name);
    assert.equal(calls.rail.length, 0, c.name);
    assert.equal(JSON.stringify(dry).includes(c.found.idNumber), false, c.name);
  }
});

test('#147: idFromLastPayoutRequest opens the newest sealed recipient that carries an ID (real vault encryption)', async () => {
  process.env.WAPAY_PII_KEY = 'a'.repeat(64);
  const { encryptPii } = await import('../lib/pii-vault.js');
  const { idFromLastPayoutRequest } = await import('../lib/ops-payout.js');
  const seal = (recipient) => { const s = encryptPii(JSON.stringify({ recipient, providerCode: '66' })); return { enc: s.enc, keyVersion: s.keyVersion }; };
  const rows = [
    { metadata: { reference: 'WPO4', status: 'SETTLED' } },
    { metadata: { reference: 'WPO3', approval: seal({ firstname: 'Ncamsile', surname: 'Jele', account_number: '1234567595' }) } },
    { metadata: { reference: 'WPO2', approval: seal({ firstname: 'Ncamsile', surname: 'Jele', id_number: '9001010000083' }) } },
    { metadata: { reference: 'WPO1', approval: seal({ firstname: 'Ncamsile', surname: 'Jele', id_number: '8001010000084' }) } },
  ];
  let query = null;
  const fake = { providerRequest: { findMany: async (q) => { query = q; return rows; } } };
  const got = await idFromLastPayoutRequest({ prisma: fake, accountId: 'acc2' });
  assert.equal(query.where.accountId, 'acc2');
  assert.equal(query.where.route, 'ott-payout');
  assert.deepEqual(query.orderBy, { requestTs: 'desc' });
  assert.equal(got.idNumber, '9001010000083');
  assert.equal(got.fullName, 'Ncamsile Jele');
  assert.equal(got.idType, 'RSAID');
  assert.equal(got.reference, 'WPO2');
  assert.equal(await idFromLastPayoutRequest({ prisma: { providerRequest: { findMany: async () => [{ metadata: { approval: { enc: 'enc1:bad:bad:bad' } } }] } }, accountId: 'acc2' }), null);
});

test('#147: a field OTT asks for that WaPay cannot fill blocks the dry run; a rail refusal comes back in plain words', async () => {
  const { d } = deps({ providers: async () => [{ ...LIVE_PAYSHAP[0], requiredFields: [...LIVE_PAYSHAP[0].requiredFields, 'email'] }] });
  const dry = await opsPayout({ prisma: db, accountId: 'acc1', amountCents: 100000, deps: d });
  assert.equal(dry.ok, false);
  assert.deepEqual(dry.blockers, ['MISSING_FIELDS']);
  assert.deepEqual(dry.missingFields, ['email']);
  assert.match(dry.message, /PayShap now asks for the customer's email address/);

  const { d: d2 } = deps({ requestPayout: async () => ({ ok: false, error: 'BAD_RECIPIENT', field: 'id_number', reference: 'REF2' }) });
  const live = await opsPayout({ prisma: db, accountId: 'acc1', amountCents: 100000, by: 'founder', reason: 'x', dryRun: false, deps: d2 });
  assert.equal(live.ok, false);
  assert.equal(live.result.field, 'id_number');
  assert.match(live.result.message, /customer's ID number is missing or not valid\. No money moved\./);
});
