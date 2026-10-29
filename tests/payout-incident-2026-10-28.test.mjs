// The 28 October incident (BUGLOG #145 to #149): Lisa's R100 PayShap withdrawal waited for approval with R116 set
// aside, was approved at 21:40 and failed at the bank in the same minute; a R228 was offered meanwhile; her
// "Nothing is coming in to my bank account" got the withdraw opener. These lock the pieces below the processor
// (the processor replay is tests/payout-incident-chat.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { proofFor } from './helpers/pin-proof.mjs';

process.env.WAPAY_PII_KEY ||= '7f'.repeat(32);
process.env.WAPAY_INTERNAL_API_KEY ||= 'test-internal-key-for-proofs';
const { matchMissingMoney, matchCancelWithdrawal, matchPersonAsk, namesDeposit } = await import('../lib/missing-money.js');
const { matchWithdrawAsk, startWithdraw, executeWithdraw, PIN_PRIVACY_LINE, handleWithdrawReply } = await import('../lib/payout-chat.js');
const { payoutReason, PAYOUT_REASONS, NEXT_STEPS } = await import('../lib/payout-reasons.js');
const copy = await import('../lib/payout-status-copy.js');
const { requestPayout, finalisePayout, payoutOutcomeMessage, findOpenPayout } = await import('../lib/payouts.js');
const { approvePayout, rejectPayout, approvedCopy } = await import('../lib/payout-approval.js');
const { PAYOUT_APPROVAL_KEY, _resetPayoutHoldCache } = await import('../lib/payout-hold.js');
const { moneySituation, situationSentences } = await import('../lib/money-situation.js');

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const NOW = Date.now();
const providers = [{ method: 'PAYSHAP', label: 'PayShap', providerCode: '66', providerName: 'PayShap Account', minCents: 5000, maxCents: 300000 }];
const recipient = { firstname: 'Lisa', surname: 'M', mobile: '060 002 0001', account_number: '1383400918', branch_code: '470010', branch_name: 'Capitec', id_number: 'FN123456', id_type: 'PASSPORT', country_of_issue: 'ZW', nationality: 'ZW' };
const account = { id: 'acc-incident-0000000001', waId: '27600020001', createdAt: new Date(NOW - 60 * 86400e3), profile: {} };

function env() {
  process.env.WAPAY_PAYOUT_ENABLED = 'true';
  process.env.OTT_PAYOUT_BASE_URL = 'https://test-payoutapi.example';
  process.env.OTT_PAYOUT_USERNAME = 'u'; process.env.OTT_PAYOUT_PASSWORD = 'p'; process.env.OTT_PAYOUT_API_KEY = 'k';
  process.env.WAPAY_PAYOUT_KYC = 'off';
  delete process.env.WAPAY_PAYOUT_TEST_NUMBERS;
  delete process.env.WAPAY_OPS_ALERT_MSISDNS;
  delete process.env.ALERT_EMAIL;
  _resetPayoutHoldCache();
}

/** The approval suite's fake, with the account filter the open-withdrawal read needs and a unique-index switch. */
function db({ approval = true, uniqueIndex = false } = {}) {
  const prs = []; const audits = []; const markers = new Set(approval ? [PAYOUT_APPROVAL_KEY] : []);
  const OPEN = ['INIT', 'AWAITING_APPROVAL', 'PENDING', 'REJECTING', 'NEEDS_OPERATOR'];
  const match = (r, where) => (!where.idemKey || r.idemKey === where.idemKey) && (!where.accountId || r.accountId === where.accountId) && (!where.status || (typeof where.status === 'string' ? r.status === where.status : where.status.in.includes(r.status))) && (!where.metadata || r.metadata?.[where.metadata.path[0]] === where.metadata.equals) && (!where.route || r.route === where.route);
  return {
    _prs: prs, _audits: audits,
    processedMessage: {
      async findUnique({ where }) { return markers.has(where.waMessageId) ? { id: 'm', processedAt: new Date(NOW) } : null; },
      async upsert({ where }) { markers.add(where.waMessageId); return {}; },
      async create({ data }) { if (markers.has(data.waMessageId)) throw Object.assign(new Error('dup'), { code: 'P2002' }); markers.add(data.waMessageId); return {}; },
      async findFirst() { return null; },
    },
    account: { async findUnique() { return { ...account }; }, async findMany() { return []; }, async findFirst() { return null; } },
    providerRequest: {
      async findUnique({ where }) { return prs.find((r) => r.idemKey === where.idemKey) || null; },
      async findMany({ where, take }) { const rows = prs.filter((r) => match(r, where || {})).sort((a, b) => b.requestTs - a.requestTs); return take ? rows.slice(0, take) : rows; },
      async create({ data }) {
        if (uniqueIndex && data.route === 'ott-payout' && OPEN.includes(data.status) && prs.some((r) => r.accountId === data.accountId && OPEN.includes(r.status))) {
          throw Object.assign(new Error('Unique constraint failed on the constraint: `ProviderRequest_one_open_payout`'), { code: 'P2002', meta: { target: 'ProviderRequest_one_open_payout' } });
        }
        const row = { id: `pr${prs.length + 1}`, requestTs: new Date(NOW + prs.length), ...data }; prs.push(row); return row;
      },
      async update({ where, data }) { const r = prs.find((x) => x.idemKey === where.idemKey); Object.assign(r, data); return r; },
      async updateMany({ where, data }) { const rows = prs.filter((r) => match(r, where)); for (const r of rows) Object.assign(r, data); return { count: rows.length }; },
    },
    paymentRequest: { async findMany() { return []; } },
    journalEntry: { async findMany() { return []; } },
    wallet: { async findMany() { return [{ balanceType: 'SPEND', availableCents: 36000, pendingCents: 0 }]; } },
    auditLog: { async create({ data }) { audits.push(data); return data; } },
  };
}
function ledger() {
  const calls = []; const holds = new Map();
  return {
    calls, holds,
    async ensureWallet() { calls.push('ensureWallet'); },
    async postEntry(e) { calls.push(`post:${e.source}`); return {}; },
    async reserveHold({ idemKey, amountCents }) { calls.push('reserveHold'); holds.set(idemKey, { amountCents, status: 'ACTIVE' }); },
    async settleHold({ idemKey }) { calls.push('settleHold'); holds.get(idemKey).status = 'SETTLED'; },
    async releaseHold({ idemKey }) { calls.push('releaseHold'); if (holds.get(idemKey)) holds.get(idemKey).status = 'RELEASED'; },
  };
}
const rail = (seen = [], settlement = 'PENDING') => ({ async performPayout(a) { seen.push(a); return { settlement, outcome: settlement === 'PENDING' ? 'PENDING_FINALISATION' : 'SUCCESS', status: settlement === 'PENDING' ? 99 : 100, paymentReference: 'OTT1' }; }, async getPaymentStatus() { return {}; } });
const ask = ({ prisma, led = ledger(), client = rail(), intentId, amountCents }) =>
  requestPayout({ prisma, ledger: led, client, account, intentId, method: 'PAYSHAP', amountCents, recipient, providers, readFloat: async () => null, authorization: proofFor(account, { intentId, amountCents }), receipts: [], alertRequest: async () => {} });

// ---------------------------------------------------------------------------------------------------------------
test('#145: her sentence is a missing-money complaint, never a withdrawal; real withdraw asks still are', () => {
  for (const t of ['Nothing is coming in to my bank account', 'did my withdrawal go through', 'did my withdrawal to my capitec account go through', 'why did my withdrawal fail', 'I did not receive my money', 'where is my money', 'my money did not arrive in my bank', 'nothing in my capitec yet', 'Money not reflecting in my account', 'where is my R100', 'my payout was declined', 'status', 'Status?', 'check my status']) {
    assert.ok(matchMissingMoney(t), `missing money: "${t}"`);
    assert.equal(matchWithdrawAsk(t), null, `not a withdrawal: "${t}"`);
  }
  for (const t of ['withdraw R200', 'money to my bank', 'lets do a withdrawal to my bank account', 'withdraw all my money to my capitec account', 'cash out R100 to my account', 'can I withdraw to my FNB account']) {
    assert.ok(matchWithdrawAsk(t), `still a withdrawal: "${t}"`);
    assert.ok(!matchMissingMoney(t), `not a complaint: "${t}"`);
  }
  for (const t of ["I don't have a bank account", "I haven't got a bank account", 'did my deposit go through', 'I did not receive the OTP', 'no thanks', 'balance',
    // review 2026-10-29: money sent to them or by them, a purchase, and questions about how it works belong elsewhere
    "My friend sent me money but it's not showing in my account", "I didn't get my electricity token but money left my account", 'I sent R100 to my mom, she didnt receive',
    'send R50 to 0821234567 he has not got any money', 'What happens if my withdrawal fails?', 'is the fee refunded if my payout is declined']) assert.ok(!matchMissingMoney(t), `not a complaint: "${t}"`);
  assert.ok(namesDeposit('did my card top up go through') && !namesDeposit('Nothing is coming in to my bank account'));
  // The cancel acts at once, so only a request said as one cancels (review 2026-10-29).
  for (const t of ['cancel withdrawal', 'cancel my withdrawal', 'please cancel the payout', 'I want to cancel my withdrawal', 'can you cancel my withdrawal please', 'cancel my withdrawal of R100']) assert.ok(matchCancelWithdrawal(t), `cancel: "${t}"`);
  for (const t of ["Please don't cancel my withdrawal", "I don't want the withdrawal to be cancelled", 'How do I cancel a withdrawal?', 'Can I cancel my withdrawal if I change my mind?', 'stop withdrawal notifications', 'stop asking me about payouts', 'cancel', 'cancel request PRABCDEF']) assert.ok(!matchCancelWithdrawal(t), `not a cancel: "${t}"`);
  assert.ok(matchPersonAsk('person') && matchPersonAsk('I want to speak to someone') && matchPersonAsk('talk to an agent'));
  for (const t of ['help', 'personal loan', 'agent', 'I need an agent to deposit cash']) assert.ok(!matchPersonAsk(t), `not a person ask: "${t}"`);
});

test('#146: every rejection reason is a row of data; an unknown code is flagged, never guessed', () => {
  const r97 = payoutReason({ outcome: 'PROVIDER_97', message: 'Fail at Provider' });
  assert.deepEqual([r97.key, r97.code, r97.known, r97.fault, r97.waiveFee], ['BANK_DID_NOT_COMPLETE', '97', true, 'BANK', true]);
  assert.equal(payoutReason({ outcome: 'PROVIDER_97', message: 'Fail at Provider: account holder name mismatch' }).key, 'NAME_MISMATCH');
  assert.equal(payoutReason({ outcome: 'PROVIDER_97', message: 'Fail at Provider: Invalid account' }).key, 'ACCOUNT_NOT_VALID');
  assert.equal(payoutReason({ outcome: 'PROVIDER_97', message: 'Fail at Provider: Bank unavailable' }).key, 'BANK_UNAVAILABLE');
  assert.equal(payoutReason({ providerStatus: 9, outcome: 'DATA_VALIDATION' }).key, 'DETAILS_REJECTED');
  assert.equal(payoutReason({ providerStatus: '11' }).key, 'ID_REJECTED');
  assert.equal(payoutReason({ outcome: 'FLOAT_SHORT', providerStatus: 0 }).key, 'FLOAT_SHORT', 'our own outcome outranks the code beside it');
  assert.equal(payoutReason({ outcome: 'INIT_ABANDONED_0' }).key, 'NEVER_SENT');
  assert.equal(payoutReason({ outcome: 'REJECTED' }).waiveFee, false, 'a rejection is a decision, not a failure');
  const unknown = payoutReason({ outcome: 'PROVIDER_55' });
  assert.deepEqual([unknown.key, unknown.known, unknown.code], ['UNKNOWN', false, '55']);
  for (const row of PAYOUT_REASONS) {
    assert.ok(row.key && row.reason && row.next in NEXT_STEPS && ['CUSTOMER', 'BANK', 'OURS', 'UNKNOWN'].includes(row.fault), row.key);
    for (const t of [row.reason, ...(row.refine || []).map((x) => x.reason)]) assert.ok(!/bank rail|—|OTT|minute|second|instant|today|hour/i.test(t), `plain, no partner, no time: ${t}`);
  }
});

test('#148: one vocabulary; a ✅ only when the bank has paid; no jargon, no time promise, no em dash', () => {
  const p = { amountCents: 10000, feeCents: 1600, method: 'PAYSHAP', reference: 'WP161EF3F64B2374', recipient: { account: '•••918', bank: 'Capitec' } };
  const way = copy.onItsWayCopy({ ...p, outcome: 'PENDING_FINALISATION' }, { approved: true });
  assert.equal(way, "⏳ *Approved and on its way.* Your R100 withdrawal by PayShap is on its way to your Capitec account •••918 (reference WP161EF3F64B2374). I'll message you here when your bank confirms it. If it does not go through, the R100 and the R16 fee come straight back to your balance.");
  assert.equal(approvedCopy({ ...p, status: 'PENDING', outcome: 'PENDING_FINALISATION' }), way, 'the founder\'s approval of a PENDING is ⏳, never ✅ (21:40)');
  const failed = payoutOutcomeMessage({ ...p, status: 'FAILED', outcome: 'PROVIDER_97', message: 'Fail at Provider', balanceCents: 36000 });
  assert.equal(failed, "❌ *Didn't go through.* Your R100 withdrawal by PayShap didn't reach your Capitec account •••918, because the bank's payment system did not complete it. The R100 and the R16 fee are back in your WaPay balance, so you have R360 available now. Say *withdraw* to try again a little later. Reply *person* to talk to someone from WaPay. (Reference WP161EF3F64B2374.)");
  const all = [way, failed, copy.cancelledCopy(p), copy.openPayoutCopy({ ...p, status: 'AWAITING_APPROVAL' }), copy.openPayoutCopy({ ...p, status: 'PENDING' }), copy.cannotCancelCopy({ ...p, status: 'PENDING' }), copy.cannotCancelCopy(null),
    ...['AWAITING_APPROVAL', 'PENDING', 'SUCCESS', 'FAILED'].map((status) => copy.payoutLine({ ...p, status, outcome: 'PROVIDER_97', createdAt: new Date() })), copy.personAskedCopy({ alerted: true }), copy.personAskedCopy({})];
  for (const t of all) assert.ok(!/bank rail|—|within|minute|instantly|seconds|pay-out/i.test(t), `plain words: ${t}`);
  for (const t of all.filter((x) => /✅/.test(x))) assert.match(t, /paid/);
  assert.deepEqual(['AWAITING_APPROVAL', 'REJECTING', 'INIT', 'PENDING', 'NEEDS_OPERATOR', 'SUCCESS', 'FAILED'].map((status) => copy.payoutPhase({ status })), ['APPROVAL', 'APPROVAL', 'ON_ITS_WAY', 'ON_ITS_WAY', 'CHECKING', 'PAID', 'FAILED']);
  assert.equal(copy.payoutPhase({ status: 'FAILED', outcome: 'CANCELLED_BY_CUSTOMER' }), 'CANCELLED');
});

test('#145: the missing-money answer for her 22:13 state names the failure, the payment, nothing on its way and R420', () => {
  const now = new Date();
  const text = copy.missingMoneyReply({
    payouts: [
      { status: 'FAILED', outcome: 'PROVIDER_97', message: 'Fail at Provider', amountCents: 10000, feeCents: 1600, method: 'PAYSHAP', reference: 'WP161EF3F64B2374', recipient: { account: '•••918' }, createdAt: new Date(now - 75 * 60e3), finalisedAt: new Date(now - 33 * 60e3) },
      { status: 'SUCCESS', amountCents: 32500, feeCents: 800, method: 'PAYSHAP', reference: 'WPED6D478285A1E9', recipient: { account: '•••918' }, createdAt: new Date(now - 26 * 3600e3), finalisedAt: new Date(now - 26 * 3600e3) },
    ],
    availableCents: 42000, heldCents: 0, now,
  });
  assert.match(text, /^🔎 I checked your withdrawals:\n\n❌ R100 by PayShap to your bank account •••918, today at \d\d:\d\d: didn't go through, because the bank's payment system did not complete it\./);
  assert.match(text, /\n\n✅ R325 by PayShap to your bank account •••918, yesterday at \d\d:\d\d: paid\./);
  assert.match(text, /\n\nNothing else is on its way from your WaPay balance right now\.\n\n💰 Balance: R420\.\n\nSay \*withdraw\* to try again a little later\. Reply \*person\* to talk to someone from WaPay\.$/);
});

test('#147: one open withdrawal per account, refused before any row, cent, hold or rail call; the index race is OPEN_PAYOUT too', async () => {
  env();
  const prisma = db(); const led = ledger(); const seen = [];
  const first = await ask({ prisma, led, client: rail(seen), intentId: 'intent-inc-r100', amountCents: 10000 });
  assert.equal(first.status, 'AWAITING_APPROVAL');
  const before = { rows: prisma._prs.length, calls: led.calls.length };
  const second = await ask({ prisma, led, client: rail(seen), intentId: 'intent-inc-r228', amountCents: 22800 });
  assert.equal(second.error, 'OPEN_PAYOUT');
  assert.deepEqual([second.open.reference, second.open.status, second.open.amountCents], [first.reference, 'AWAITING_APPROVAL', 10000]);
  assert.deepEqual({ rows: prisma._prs.length, calls: led.calls.length }, before, 'nothing written, moved or held');
  assert.equal(seen.length, 0, 'nothing sent');
  assert.equal(prisma._audits.filter((a) => a.event === 'PAYOUT_REQUEST').length, 1, 'a refused second request is not reported as a new one');
  // The same intent again is still its own replay, not a refusal.
  assert.equal((await ask({ prisma, led, intentId: 'intent-inc-r100', amountCents: 10000 })).replayed, true);
  // The database backstop: two requests that both read "nothing open" before either row exists.
  const racing = db({ uniqueIndex: true });
  const realFind = racing.providerRequest.findMany;
  racing.providerRequest.findMany = async (args) => (args?.where?.status?.in ? [] : realFind(args));
  await ask({ prisma: racing, intentId: 'intent-race-a', amountCents: 10000 });
  const lost = await ask({ prisma: racing, intentId: 'intent-race-b', amountCents: 10000 });
  assert.equal(lost.error, 'OPEN_PAYOUT');
  assert.equal(racing._prs.length, 1);
  // The chat says so before any step: what is open, what is set aside, what can be done.
  const chat = await startWithdraw({ prisma, account, ask: { amountCents: 22800, method: 'PAYSHAP' }, deps: { payoutBalances: async () => ({ totalCents: 24400, heldCents: 11600 }), resolveProviders: async () => providers, recentReceipts: async () => [] } });
  assert.equal(chat.state, null);
  // (No fresh money in this fake, so the normal R8 fee: R108 set aside. Her night had the express R16: R116.)
  assert.match(chat.text, /^⏳ You already have a withdrawal waiting for approval: R100 by PayShap to your Capitec account •••918 \(reference WP[0-9A-F]{14}\)\. R108 is set aside for it\./);
  assert.match(chat.text, /💰 Balance: R360: R244 available and R116 set aside/);
  // And once it is finished, a new one may start.
  assert.equal(await findOpenPayout({ prisma: db(), accountId: account.id }), null);
});

test('#146/#148: approve → the bank has it (⏳) → the webhook says 97 → the customer hears why, with the money back; ops hears too', async () => {
  env();
  const prisma = db(); const led = ledger(); const told = [];
  const req = await ask({ prisma, led, intentId: 'intent-inc-approve', amountCents: 10000 });
  const ok = await approvePayout({ prisma, ledger: led, client: rail([], 'PENDING'), reference: req.reference, deps: { notifyCustomer: async (m) => { told.push(m); return { ok: true }; } } });
  assert.equal(ok.status, 'PENDING');
  assert.match(told[0].text, /^⏳ \*Approved and on its way\.\* Your R100 withdrawal by PayShap is on its way to your Capitec account •••918/);
  assert.ok(!/✅/.test(told[0].text));
  const fin = await finalisePayout({ prisma, ledger: led, reference: req.reference, status: '97', message: 'Fail at Provider' });
  assert.deepEqual([fin.status, fin.providerStatus, fin.outcome, fin.message], ['FAILED', '97', 'PROVIDER_97', 'Fail at Provider']);
  assert.ok(led.calls.includes('releaseHold'));
  const msg = payoutOutcomeMessage({ ...fin, balanceCents: 36000 });
  assert.match(msg, /didn't reach your Capitec account •••918, because the bank's payment system did not complete it\. The R100 and the R8 fee are back in your WaPay balance, so you have R360 available now\./);
  // The ops alert for an unmapped code (logged, no recipients in tests) is built from masks only.
  const src = read('../lib/payouts.js');
  const alert = src.slice(src.indexOf('async function payoutFailedAlert'), src.indexOf('/** The live pay-out float'));
  assert.match(alert, /UNMAPPED CODE/); assert.match(alert, /replace\(\/\\d\{6,\}\/g/, 'digit runs masked'); assert.match(alert, /opsPayoutFailed\(\{ text, key: reference/);
  assert.match(src.slice(src.indexOf('export async function finalisePayout')), /await payoutFailedAlert\(/);
});

test('#147: "cancel withdrawal" cancels one still waiting for approval, through the reject step, without a second message', async () => {
  env();
  const prisma = db(); const led = ledger(); const told = [];
  const req = await ask({ prisma, led, intentId: 'intent-inc-cancel', amountCents: 10000 });
  const done = await rejectPayout({ prisma, ledger: led, reference: req.reference, by: 'customer', reason: 'cancelled by the customer in chat', outcome: 'CANCELLED_BY_CUSTOMER', tell: false, deps: { notifyCustomer: async (m) => { told.push(m); return { ok: true }; } } });
  assert.equal(done.ok, true);
  assert.equal(told.length, 0, 'the chat answers it itself');
  const row = prisma._prs.find((r) => r.metadata?.reference === req.reference);
  assert.deepEqual([row.status, row.metadata.outcome, row.metadata.approval.rejectedBy], ['FAILED', 'CANCELLED_BY_CUSTOMER', 'customer']);
  assert.ok(led.calls.includes('releaseHold') && led.calls.includes('post:BALANCE_DOWNGRADE'), 'the hold released and the money back to SPEND');
  assert.match(copy.cancelledCopy(done.out, { balanceCents: 36000 }), /^↩️ \*Cancelled\.\* Your R100 withdrawal by PayShap \(reference WP[0-9A-F]{14}\) will not be sent\. The R100 and the R8 fee are back in your WaPay balance, so you have R360 available now\.$/);
  assert.equal(copy.payoutPhase(row.metadata ? { status: row.status, outcome: row.metadata.outcome } : {}), 'CANCELLED');
});

test('#147: the money situation sees a withdrawal waiting for approval (the gates read it)', async () => {
  const fake = {
    wallet: { async findMany() { return [{ balanceType: 'SPEND', availableCents: 24400, pendingCents: 0 }, { balanceType: 'CASH', availableCents: 0, pendingCents: 11600 }]; } },
    pendingGift: { async findMany() { return []; } },
    providerRequest: { async findMany({ where }) { return where.route === 'ott-payout' && where.status?.in?.includes('AWAITING_APPROVAL') ? [{ status: 'AWAITING_APPROVAL', requestTs: new Date(), metadata: { reference: 'WP161EF3F64B2374', amountCents: 10000, feeCents: 1600, method: 'PAYSHAP' } }] : []; } },
    payoutIdentity: { async findUnique() { return null; } },
    payoutDestination: { async count() { return 0; } },
    account: { async findMany() { return []; } },
    journalEntry: { async findMany() { return []; } },
  };
  const s = await moneySituation({ prisma: fake, account: { id: 'acc-1', waId: '27600020001' } });
  assert.deepEqual([s.availableCents, s.heldCents, s.pendingPayouts[0]?.status], [24400, 11600, 'AWAITING_APPROVAL']);
  assert.match(situationSentences(s).join(' '), /R116 is set aside for your R100 withdrawal \(WP161EF3F64B2374\), which is waiting for approval/);
});

test('#149: the withdrawal PIN step says WaPay never keeps the PIN and how to delete the message', async () => {
  const data = { amountCents: 10000, method: 'PAYSHAP', intentId: 'intent-inc-pin', recipient: { account_number: '1383400918', branch_code: '470010', branch_name: 'Capitec' }, balanceCents: 36000, options: ['PAYSHAP'], limits: { PAYSHAP: { minCents: 5000, maxCents: 300000 } }, feeCents: 1600, totalCents: 11600 };
  const pin = await handleWithdrawReply({ account, state: 'PAYOUT_CONFIRM', data, text: 'yes' });
  assert.equal(pin.state, 'PAYOUT_PIN');
  assert.equal(pin.text, `🔐 *Enter your WaPay PIN* to withdraw R100.\n\n${PIN_PRIVACY_LINE}`);
  assert.match(PIN_PRIVACY_LINE, /never keeps your PIN.*Delete for me/);
});

test('static: the processor answers money that already moved before the agent and before the withdraw matcher; the migration matches the code', () => {
  const p = read('../pages/api/webhooks/message-processor-v2.js');
  const at = (s) => { const i = p.indexOf(s); assert.ok(i > 0, s); return i; };
  const hooks = at('if (matchMissingMoney(text)) return await handleMissingMoney({ from, account, rawText: text });');
  assert.ok(at('if (matchCancelWithdrawal(text)) return await handleCancelWithdrawal({ from, account });') < hooks);
  assert.ok(at('if (matchPersonAsk(text)) return await handlePersonAsk({ from, account, text });') < hooks);
  assert.ok(hooks < at('if (agentV3For(from)) {\n    return await handleAgentTurn({ from, text, account, messageId });'), 'before the Pay agent');
  assert.ok(hooks < at("const { matchWithdrawAsk } = await import('../../../lib/payout-chat.js');"), 'before the withdraw matcher');
  const cancel = p.slice(p.indexOf('async function handleCancelWithdrawal'));
  assert.ok(cancel.indexOf("open.status === 'AWAITING_APPROVAL'") < cancel.indexOf('rejectPayout({'), 'only a withdrawal waiting for approval is cancelled');
  assert.match(cancel, /outcome: 'CANCELLED_BY_CUSTOMER', tell: false/);
  const person = p.slice(p.indexOf('async function handlePersonAsk'));
  assert.match(person.slice(0, 3200), /alerted = !!\(\(wa && wa\.sent\) \|\| \(mail && mail\.success\)\);/, 'a person is promised only when an alert went');
  const sql = read('../packages/domain/prisma/migrations/20261028_one_open_payout/migration.sql');
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "ProviderRequest_one_open_payout" ON "ProviderRequest"\("accountId"\) WHERE "route" = 'ott-payout' AND "status" IN \('INIT', 'AWAITING_APPROVAL', 'PENDING', 'REJECTING'\);/);
  assert.deepEqual([...copy.OPEN_PAYOUT_STATUSES], ['INIT', 'AWAITING_APPROVAL', 'PENDING', 'REJECTING'], 'the index and the code name the same statuses; NEEDS_OPERATOR never blocks the customer');
  assert.match(p, /if \(open && \(open\.status === 'AWAITING_APPROVAL' \|\| open\.status === 'REJECTING'\)\) \{/, 'a reject stopped half-way is finished by the customer\'s cancel');
  assert.match(p, /if \(parkedRef && parked\.status === 'PENDING' && \(matchDepositStatusRequest\(text\) \|\| matchMissingMoney\(text\)\)\) throw/, 'a stuck INIT row is still checked by the hook');
  assert.match(p, /const inView = \(r\) => isOpenPayout\(r\) \|\| new Date\(r\.createdAt\)\.getTime\(\) >= since;/, 'an open withdrawal is shown whatever its age');
  assert.match(person.slice(0, 3200), /if \(alerted\) await prisma\.processedMessage\.create\(\{ data: \{ waMessageId: marker/, '"earlier today" only after a delivery');
  const core = read('../lib/payouts.js');
  const fn = core.slice(core.indexOf('async function requestPayoutCore'));
  const open = fn.indexOf('const open = await findOpenPayout(');
  assert.ok(open > fn.indexOf('const existing = await prismaClient.providerRequest.findUnique') && open < fn.indexOf('providerRequest.create(') && open < fn.indexOf('reserveHold(') && open < fn.indexOf('railAndSettle('), 'after the replay, before any row, hold or rail call');
});

test('review 2026-10-29: the push and the lookup give the same reason; nothing "came back" when nothing left; replays and timeouts say their real state; cash is not a bank', async () => {
  // A row that sat at 99 and then failed with 97: the stale 99 must not win.
  const row = { status: 'FAILED', providerStatus: '99', outcome: 'PROVIDER_97', message: 'Fail at Provider: account holder name mismatch', amountCents: 10000, feeCents: 1600, method: 'PAYSHAP', reference: 'WPX', recipient: { account: '•••918' } };
  assert.equal(copy.reasonFor(row).key, 'NAME_MISMATCH');
  assert.match(copy.payoutLine(row), /because the name did not match the bank account/);
  assert.match(payoutOutcomeMessage(row), /because the name did not match the bank account/);
  // Nothing moved: no "came back".
  for (const outcome of ['INSUFFICIENT_FUNDS', 'FLOAT_SHORT']) {
    const p = { status: 'FAILED', outcome, amountCents: 10000, feeCents: 800, method: 'PAYSHAP', reference: 'WPY' };
    assert.match(copy.payoutLine(p), /Nothing left your balance for it\./); assert.ok(!/came back/.test(copy.payoutLine(p)));
    assert.match(copy.failedCopy(p), /Nothing left your WaPay balance for it\./); assert.ok(!/are back/.test(copy.failedCopy(p)));
  }
  // A replay of a request still waiting for approval is not a failure.
  env();
  const prisma = db(); const led = ledger();
  const first = await ask({ prisma, led, intentId: 'intent-rev-replay', amountCents: 10000 });
  const again = await ask({ prisma, led, intentId: 'intent-rev-replay', amountCents: 10000 });
  assert.deepEqual([first.status, again.replayed, again.status, again.ok], ['AWAITING_APPROVAL', true, 'AWAITING_APPROVAL', true]);
  // Approved, but the bank's answer timed out: no "on its way" (BUGLOG #82).
  const timeout = approvedCopy({ status: 'PENDING', outcome: 'TRANSPORT_INDETERMINATE', amountCents: 10000, feeCents: 1600, method: 'PAYSHAP', reference: 'WPZ' });
  assert.match(timeout, /^⏳ \*Approved\.\* I could not get confirmation from your bank just now, so I am checking on it \(reference WPZ\)\. The R100 and the R16 fee stay set aside/);
  assert.ok(!/on its way/.test(timeout));
  // Cash methods are not a bank, and the statement is never promised to show our reference.
  const cash = { amountCents: 10000, feeCents: 1800, method: 'CASHSEND', reference: 'WPC', recipient: { mobile: '•••1175' }, createdAt: new Date() };
  for (const t of [copy.payoutLine({ ...cash, status: 'PENDING' }), copy.payoutLine({ ...cash, status: 'SUCCESS' }), copy.openPayoutCopy({ ...cash, status: 'PENDING' }), copy.cannotCancelCopy({ ...cash, status: 'PENDING' }), copy.onItsWayCopy({ ...cash, outcome: 'PENDING' }), copy.missingMoneyReply({ payouts: [{ ...cash, status: 'SUCCESS' }] })]) {
    assert.ok(!/your bank|bank confirm|statement/.test(t), `no bank for cash: ${t}`);
  }
  assert.ok(!/statement|with the reference/.test(copy.missingMoneyReply({ payouts: [{ ...cash, method: 'PAYSHAP', recipient: { account: '•••918' }, status: 'SUCCESS' }] })));
  // NEEDS_OPERATOR is a person's check, never "on its way".
  assert.match(copy.payoutLine({ ...cash, status: 'NEEDS_OPERATOR' }), /a person at WaPay is checking this one/);
  // "person" never promises what the record does not say.
  for (const t of [copy.personAskedCopy({ alerted: true }), copy.personAskedCopy({ alerted: 'EARLIER' }), copy.personAskedCopy({ contact: '060' }), copy.personAskedCopy({})]) assert.ok(!/money is safe/i.test(t));
});
