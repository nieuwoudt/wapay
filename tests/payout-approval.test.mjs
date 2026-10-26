// The founder approves every pay-out (2026-10-26), the freeze holes found that morning are closed, and the numbers
// tied to the fraud are listed for watching.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { proofFor } from './helpers/pin-proof.mjs';

process.env.WAPAY_PII_KEY ||= '7f'.repeat(32);
process.env.WAPAY_INTERNAL_API_KEY ||= 'test-internal-key-for-proofs';
const { requestPayout } = await import('../lib/payouts.js');
const { approvePayout, rejectPayout, listAwaitingApproval, mintApprovalToken, verifyApprovalToken, approvalUrl, rejectedCopy, approvedCopy } = await import('../lib/payout-approval.js');
const { isApprovalMode, setPayoutApproval, readPayoutMode, isPayoutHeldFor, PAYOUT_APPROVAL_KEY, PAYOUT_HOLD_KEY, _resetPayoutHoldCache } = await import('../lib/payout-hold.js');
const { refuseSpendIfFrozen, FROZEN_SEND_COPY } = await import('../lib/payout-freeze.js');
const { awaitingApprovalCopy } = await import('../lib/payout-chat.js');
const { watchlist } = await import('../lib/watchlist.js');

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const NOW = Date.now();
const providers = [{ method: 'PAYSHAP', label: 'PayShap', providerCode: '66', providerName: 'PayShap Account', minCents: 5000, maxCents: 300000 }];
const recipient = { firstname: 'Lerato', surname: 'M', mobile: '073 123 4567', account_number: '62012345678', branch_code: '250655', branch_name: 'FNB', id_number: '9001015009087' };
const account = { id: 'acc-approve-000000000001', waId: '27731234567', createdAt: new Date(NOW - 60 * 86400e3), profile: { kyc: { status: 'VERIFIED', fullName: 'Lerato M' } } };

function env() {
  process.env.WAPAY_PAYOUT_ENABLED = 'true';
  process.env.OTT_PAYOUT_BASE_URL = 'https://test-payoutapi.example';
  process.env.OTT_PAYOUT_USERNAME = 'u'; process.env.OTT_PAYOUT_PASSWORD = 'p'; process.env.OTT_PAYOUT_API_KEY = 'k';
  process.env.WAPAY_PAYOUT_KYC = 'off';
  delete process.env.WAPAY_PAYOUT_TEST_NUMBERS;
  _resetPayoutHoldCache();
}

function db({ approval = true, held = true, frozen = false } = {}) {
  const prs = []; const audits = []; const markers = new Set([...(approval ? [PAYOUT_APPROVAL_KEY] : []), ...(held ? [PAYOUT_HOLD_KEY] : [])]);
  const prof = () => ({ ...account.profile, ...(frozen ? { payouts: { frozen: true } } : {}) });
  const match = (r, where) => (!where.idemKey || r.idemKey === where.idemKey) && (!where.status || (typeof where.status === 'string' ? r.status === where.status : where.status.in.includes(r.status))) && (!where.metadata || r.metadata?.[where.metadata.path[0]] === where.metadata.equals) && (!where.route || r.route === where.route);
  return {
    _prs: prs, _audits: audits, _markers: markers, _freeze: (v) => { frozen = v; },
    processedMessage: {
      async findUnique({ where }) { return markers.has(where.waMessageId) ? { id: 'm', processedAt: new Date(NOW) } : null; },
      async upsert({ where }) { markers.add(where.waMessageId); return {}; },
      async deleteMany({ where }) { markers.delete(where.waMessageId); return { count: 1 }; },
      async create() { return {}; },
      async findFirst() { return null; },
    },
    account: { async findUnique() { return { ...account, profile: prof() }; }, async findMany() { return []; } },
    providerRequest: {
      async findUnique({ where }) { return prs.find((r) => r.idemKey === where.idemKey) || null; },
      async findMany({ where }) { if (where?.route === 'ott-payout' && (where.status || where.metadata)) return prs.filter((r) => match(r, where)); return []; },
      async create({ data }) { const row = { id: `pr${prs.length + 1}`, requestTs: new Date(), ...data }; prs.push(row); return row; },
      async update({ where, data }) { const r = prs.find((x) => x.idemKey === where.idemKey); Object.assign(r, data); return r; },
      async updateMany({ where, data }) { const rows = prs.filter((r) => match(r, where)); for (const r of rows) Object.assign(r, data); return { count: rows.length }; },
    },
    paymentRequest: { async findMany() { return []; } },
    journalEntry: { async findMany() { return []; } },
    wallet: { async findMany() { return [{ balanceType: 'SPEND', availableCents: 50000, pendingCents: 0 }]; } },
    auditLog: { async create({ data }) { audits.push(data); return data; } },
  };
}
function ledger() {
  const calls = []; const holds = new Map(); const settled = [];
  return {
    calls, holds, settled,
    async ensureWallet() { calls.push('ensureWallet'); },
    async postEntry(e) { calls.push(`post:${e.source}`); return {}; },
    async reserveHold({ idemKey, amountCents }) { calls.push('reserveHold'); holds.set(idemKey, { amountCents, status: 'ACTIVE' }); },
    async settleHold({ idemKey, entry }) { calls.push(`settleHold:${entry.source}`); settled.push(entry); holds.get(idemKey).status = 'SETTLED'; },
    async releaseHold({ idemKey }) { calls.push('releaseHold'); if (holds.get(idemKey)) holds.get(idemKey).status = 'RELEASED'; },
  };
}
const rail = (seen = [], settlement = 'SETTLE') => ({ async performPayout(a) { seen.push(a); return { settlement, outcome: settlement === 'SETTLE' ? 'SETTLED' : 'PENDING_FINALISATION', status: settlement === 'SETTLE' ? 100 : 99, paymentReference: 'OTT1' }; }, async getPaymentStatus() { return {}; } });
const ask = ({ prisma, led = ledger(), client = rail(), intentId = 'intent-ap0001', amountCents = 20000, alerts = [], extra = {} }) =>
  requestPayout({ prisma, ledger: led, client, account, intentId, method: 'PAYSHAP', amountCents, recipient, providers, readFloat: async () => null, authorization: proofFor(account, { intentId, amountCents }), receipts: [], alertRequest: async (a) => { alerts.push(a); }, ...extra });

test('approval mode: the request is checked, set aside and kept encrypted; nothing reaches the rail; the founder gets a link', async () => {
  env();
  const prisma = db(); const led = ledger(); const seen = []; const alerts = [];
  assert.equal(await isPayoutHeldFor({ prisma, account }), false, 'customers may ask while approval mode is on, even with the pause row');
  const out = await ask({ prisma, led, client: rail(seen), alerts });
  assert.deepEqual({ ok: out.ok, status: out.status, feeCents: out.feeCents }, { ok: true, status: 'AWAITING_APPROVAL', feeCents: 800 });
  assert.equal(seen.length, 0, 'no rail call');
  const row = prisma._prs[0];
  assert.equal(row.status, 'AWAITING_APPROVAL');
  assert.ok(row.metadata.approval.enc.startsWith('pii1:') || row.metadata.approval.enc.split(':').length === 4, 'the details are encrypted');
  assert.ok(!JSON.stringify(row).includes('62012345678') && !JSON.stringify(row).includes('9001015009087'), 'no account or ID number in the clear');
  assert.equal([...led.holds.values()][0].amountCents, 20800, 'the amount and the fee are set aside');
  assert.deepEqual(led.calls, ['ensureWallet', 'post:BALANCE_UPGRADE', 'reserveHold']);
  assert.match(alerts[0].text, /Result: WAITING FOR YOUR APPROVAL, money set aside, nothing sent\nApprove or reject: https:\/\/[^\s]+\/ops\/approve\?token=/);
  assert.equal(prisma._audits[0].metadata.outcome, 'AWAITING_APPROVAL');
  assert.match(awaitingApprovalCopy(out), /^⏳ \*Waiting for approval\.\* A person at WaPay checks every pay-out before it goes\. Your R200 and the R8 fee are set aside for it and nothing has left WaPay \(reference WP[0-9A-F]{14}\)\. Ask me \*status\* any time to see where it is\.$/);
  assert.ok(!/\b(soon|shortly|within|minutes?|hours?|today|tomorrow)\b/i.test(awaitingApprovalCopy(out)), 'no time promise');
  const list = await listAwaitingApproval({ prisma });
  assert.equal(list.length, 1); assert.equal(list[0].to.account, '•••678'); assert.equal(list[0].level, 1);
});

test('approve: claimed once, decrypted, sent through the same rail step, the customer told; a second approval does nothing', async () => {
  env();
  const prisma = db(); const led = ledger(); const told = [];
  const out = await ask({ prisma, led });
  const seen = [];
  const ok = await approvePayout({ prisma, ledger: led, client: rail(seen), reference: out.reference, by: 'founder', deps: { notifyCustomer: async (m) => { told.push(m); return { ok: true }; } } });
  assert.equal(ok.ok, true); assert.equal(ok.status, 'SETTLED');
  assert.equal(seen[0].recipient.account_number, '62012345678', 'the rail gets the real details');
  assert.equal(prisma._prs[0].status, 'SUCCESS'); assert.equal(prisma._prs[0].metadata.approval.approvedBy, 'founder');
  assert.ok(!prisma._prs[0].metadata.approval.enc, 'the encrypted details are dropped once used');
  assert.equal(led.settled[0].postings.find((p) => p.accountCode === 'REVENUE:FEE:CASHOUT').creditCents, 800);
  assert.match(told[0].text, /^✅ Your withdrawal of R200 by PayShap has been paid/);
  assert.equal(told[0].templateEnv, 'WAPAY_TEMPLATE_PAYOUT_OUTCOME');
  assert.deepEqual(await approvePayout({ prisma, ledger: led, client: rail(seen), reference: out.reference }), { ok: false, error: 'NOT_WAITING' });
  assert.equal(seen.length, 1, 'paid once');
});

test('approve: a short float keeps it waiting; a freeze since the request turns the approval into a rejection', async () => {
  env();
  const prisma = db(); const led = ledger();
  const out = await ask({ prisma, led });
  const short = await approvePayout({ prisma, ledger: led, reference: out.reference, readFloat: async () => ({ balanceCents: 4909 }) });
  assert.equal(short.error, 'FLOAT_SHORT'); assert.equal(prisma._prs[0].status, 'AWAITING_APPROVAL', 'still waiting');
  prisma._freeze(true);
  const frozen = await approvePayout({ prisma, ledger: led, client: rail(), reference: out.reference, deps: { notifyCustomer: async () => ({ ok: true }) } });
  assert.equal(frozen.error, 'FROZEN'); assert.equal(prisma._prs[0].status, 'FAILED'); assert.equal(prisma._prs[0].metadata.outcome, 'REJECTED');
  assert.ok(led.calls.includes('releaseHold') && led.calls.includes('post:BALANCE_DOWNGRADE'), 'the money went back');
});

test('reject: the hold released, the money back to SPEND, the customer told; idempotent', async () => {
  env();
  const prisma = db(); const led = ledger(); const told = [];
  const out = await ask({ prisma, led });
  const r = await rejectPayout({ prisma, ledger: led, reference: out.reference, by: 'founder', reason: 'fraud', deps: { notifyCustomer: async (m) => { told.push(m); return { ok: true }; } } });
  assert.deepEqual({ ok: r.ok, status: r.status }, { ok: true, status: 'REJECTED' });
  assert.equal(prisma._prs[0].status, 'FAILED'); assert.equal(prisma._prs[0].metadata.approval.rejectedBy, 'founder'); assert.ok(!prisma._prs[0].metadata.approval.enc);
  assert.ok(led.calls.includes('releaseHold')); assert.ok(led.calls.includes('post:BALANCE_DOWNGRADE'));
  assert.match(told[0].text, /^❌ Your pay-out request of R200 by PayShap was not approved \(reference WP[0-9A-F]{14}\)\. The R200 and the R8 fee are back in your WaPay balance\./);
  assert.deepEqual(await rejectPayout({ prisma, ledger: led, reference: out.reference }), { ok: false, error: 'NOT_WAITING' });
  assert.ok(!/—/.test(rejectedCopy({ amountCents: 100, feeCents: 8, method: 'PAYSHAP', reference: 'WP1' })) && !/—/.test(approvedCopy({ status: 'PENDING', amountCents: 100, method: 'PAYSHAP', reference: 'WP1' })));
});

test('operator pay-outs and test numbers never wait; without approval mode the pause and the review behave as before', async () => {
  env();
  const prisma = db();
  const op = await ask({ prisma, intentId: 'intent-ap0002', extra: { allowApproval: false } });
  assert.equal(op.status, 'SETTLED', 'the founder started it');
  process.env.WAPAY_PAYOUT_TEST_NUMBERS = '0731234567';
  try { assert.equal((await ask({ prisma: db(), intentId: 'intent-ap0003' })).error, 'TEST_RUN'); } finally { delete process.env.WAPAY_PAYOUT_TEST_NUMBERS; }
  const paused = db({ approval: false, held: true });
  assert.equal((await ask({ prisma: paused, intentId: 'intent-ap0004' })).error, 'PAYOUT_HOLD');
});

test('the mode switch: on and off with who and why; failing reads count as approval on', async () => {
  env();
  const prisma = db({ approval: false, held: true });
  assert.equal((await readPayoutMode({ prisma })).mode, 'paused');
  await assert.rejects(setPayoutApproval({ prisma, on: true, by: '', reason: 'x' }), { code: 'NEED_REASON' });
  assert.equal((await setPayoutApproval({ prisma, on: true, by: 'founder', reason: 'approve every pay-out' })).mode, 'approval');
  assert.equal(await isApprovalMode({ prisma }), true);
  assert.equal((await setPayoutApproval({ prisma, on: false, by: 'founder', reason: 'back to the pause' })).mode, 'paused');
  _resetPayoutHoldCache();
  assert.equal(await isApprovalMode({ prisma: { processedMessage: { async findUnique() { throw new Error('db down'); } } } }), true, 'fails safe');
});

test('the approval link: signed, three days, one pay-out', () => {
  const t = mintApprovalToken({ reference: 'WP0123456789ABCD', now: NOW });
  assert.deepEqual(verifyApprovalToken(t, { now: NOW + 1000 }).reference, 'WP0123456789ABCD');
  assert.equal(verifyApprovalToken(t, { now: NOW + 4 * 86400e3 }).reason, 'EXPIRED');
  assert.equal(verifyApprovalToken(t.slice(0, -2) + 'xx', { now: NOW }).reason, 'BAD_SIGNATURE');
  assert.equal(mintApprovalToken({ reference: 'nope' }), null);
  assert.match(approvalUrl(t, { APP_BASE_URL: 'https://wapay-api.vercel.app/' }), /^https:\/\/wapay-api\.vercel\.app\/ops\/approve\?token=/);
});

test('the freeze holes: a frozen account cannot pay a link from its balance or buy airtime, data, electricity, fuel or vouchers', async () => {
  const proc = read('../pages/api/webhooks/message-processor-v2.js');
  const start = proc.slice(proc.indexOf('async function handlePayRequestStart('));
  assert.ok(start.indexOf('readPayoutFreeze({ prisma, accountId: account.id') < start.indexOf("updateConversationState(from, 'PAYREQ_CONFIRM'"), 'refused before the confirmation');
  const pin = proc.slice(proc.indexOf("// Read the freeze again right before the debit"));
  assert.ok(pin.indexOf('readPayoutFreeze') < pin.indexOf("idemKey: `wapay-payreq-${request.id}`"), 'and again before the debit');
  for (const f of ['airtime', 'data', 'electricity', 'fuel', 'voucher']) {
    const src = read(`../pages/api/vas/${f}/execute.js`);
    assert.ok(src.indexOf('refuseSpendIfFrozen({ prisma, accountId, res })') > 0 && src.indexOf('refuseSpendIfFrozen({ prisma, accountId, res })') < src.indexOf('reserveHold({'), `${f}: refused before any hold`);
  }
  const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  assert.equal(await refuseSpendIfFrozen({ prisma: { account: { async findUnique() { return { profile: { payouts: { frozen: true } } }; } } }, accountId: 'acc', res }), true);
  assert.deepEqual([res.code, res.body], [423, { error: 'FROZEN', message: FROZEN_SEND_COPY }]);
  assert.equal(await refuseSpendIfFrozen({ prisma: { account: { async findUnique() { return { profile: {} }; } } }, accountId: 'acc', res: {} }), false);
});

test('numbers we watch: money moved with a frozen account, abroad checkouts, own-card links, payers of frozen accounts', async () => {
  const F = 'frozen-acc-0000000000001'; const W = 'watch-acc-00000000000001'; const X = 'abroad-acc-0000000000001';
  const prisma = {
    account: {
      async findMany({ where }) {
        if (where?.profile) return [{ id: F, waId: '27820000001', displayName: 'F', createdAt: new Date(NOW - 5 * 86400e3), profile: { payouts: { frozen: true, at: '2026-10-24T00:00:00Z', reason: 'stolen cards' } } }];
        if (where?.id?.in) return where.id.in.map((id) => ({ id, waId: id === W ? '27830000517' : id === X ? '27840009777' : '27820000001', displayName: null, createdAt: new Date(NOW - 4 * 86400e3), profile: {} }));
        return [];
      },
    },
    journalEntry: { async findMany() { return [{ lines: [{ accountCode: `WALLET:${F}:SPEND`, debitCents: 50000 }, { accountCode: `WALLET:${W}:SPEND`, creditCents: 50000 }] }]; } },
    linkVisit: { async findMany() { return [{ accountId: X, kind: 'CHECKOUT', country: 'KE' }, { accountId: F, kind: 'CHECKOUT', country: 'PK' }]; } },
    providerRequest: { async findMany({ where }) { return where.route === 'payrequest' ? [{ accountId: F, metadata: { payerMsisdn: '0811234567', amountCents: 30000 } }, { accountId: X, metadata: { payerMsisdn: '0840009777', amountCents: 30000 } }] : []; } },
    auditLog: { async findMany() { return []; } },
    conversationTurn: { async findMany() { return [1, 2, 3].map(() => ({ accountId: W })); } },
    wallet: { async findMany() { return [{ accountId: W, availableCents: 50000, pendingCents: 0 }, { accountId: F, availableCents: 28510, pendingCents: 0 }]; } },
  };
  const w = await watchlist({ prisma, now: NOW });
  const watched = w.accounts.find((a) => a.accountId === W);
  assert.deepEqual(watched.reasons.map((r) => r.code).sort(), ['FROZEN_MONEY', 'PAUSE_TRIES']);
  assert.equal(watched.phone, '•••0517'); assert.equal(watched.balanceCents, 50000);
  const abroad = w.accounts.find((a) => a.accountId === X);
  assert.deepEqual(abroad.reasons.map((r) => r.code).sort(), ['ABROAD_CHECKOUT', 'OWN_CARD']);
  assert.ok(!w.accounts.some((a) => a.accountId === F), 'a frozen account is listed under frozen, not watched');
  assert.deepEqual(w.payers, [{ number: '•••4567', paidAccounts: 1, paidFrozenAccounts: 1, totalCents: 30000, isFrozenAccount: false }]);
  assert.equal(w.frozen[0].balanceCents, 28510); assert.equal(w.frozenHeldCents, 28510);
  assert.ok(!JSON.stringify(w).includes('27830000517'), 'masked numbers only');
});

test('the dashboard and the pages: a Pay-outs tab with approvals, requests and the watchlist; the approval page; status and activity wording', () => {
  const admin = read('../pages/admin/index.js');
  assert.match(admin, /\['payouts', 'Pay-outs'\]/); assert.match(admin, /tab === 'payouts' \? <PayoutsTab \/>/);
  assert.match(admin, /<h2>Waiting for your approval<\/h2><Approvals/); assert.match(admin, /<h2>Numbers we should be watching<\/h2><Watchlist/);
  const api = read('../pages/api/admin/payout-approvals.js');
  assert.ok(api.indexOf('requireAdmin(req)') < api.indexOf("b.decision === 'approve'")); assert.match(api, /JSON_ONLY/);
  assert.match(read('../pages/api/ops/approve.js'), /verifyApprovalToken\(token\)/);
  assert.match(read('../pages/ops/approve.js'), /Approve and pay/);
  const proc = read('../pages/api/webhooks/message-processor-v2.js');
  assert.match(proc, /if \(status === 'AWAITING_APPROVAL' \|\| status === 'REJECTING'\) \{/);
  assert.match(read('../lib/app-portal.js'), /'waiting for approval, set aside from your balance'/);
  assert.match(read('../lib/app-portal.js'), /'AWAITING_APPROVAL', 'REJECTING'\] \}/);
  assert.match(read('../lib/ops-payout.js'), /allowExpress: false, allowApproval: false/);
});
