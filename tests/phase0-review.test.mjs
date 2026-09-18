/**
 * Guards from the read-only adversarial review of the Phase 0 build
 * (2026-09-16, docs/AGENT_ARCHITECTURE_V2.md). Each test names the finding it
 * closes. Source locks are used only where the behaviour lives in the
 * processor; everything in lib/ is exercised directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { redactForMemory, recordTurn } from '../lib/turns.js';
import { sendWhatsAppText as say, recordInbound, configureSay } from '../lib/say.js';
import { loadContextPack, renderCustomerRecord } from '../lib/context-pack.js';
import { capabilityById } from '../lib/capabilities.js';
import { reconcilePendingPayouts, sweepPayoutsAndNotify } from '../lib/payouts.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const processor = read('../pages/api/webhooks/message-processor-v2.js');
const webhook = read('../pages/api/webhooks/whatsapp.js');

/** Slice a top-level function's source and evaluate it (no external references). */
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} exists`);
  let depth = 0; let i = src.indexOf('{', start); const open = i;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) break; } }
  const body = src.slice(start, i + 1);
  return new Function(`${body}; return ${name};`)();
}
function sliceFn(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  assert.ok(start > -1, `${name} exists`);
  const next = src.indexOf('\nasync function ', start + 10);
  return src.slice(start, next > -1 ? next : undefined);
}
function sliceCase(src, state) {
  const start = src.indexOf(`case '${state}':`);
  assert.ok(start > -1, `state ${state} exists`);
  const next = src.indexOf("\n      case '", start + 10);
  return src.slice(start, next > -1 ? next : start + 6000);
}

// ---------------------------------------------------------------- policy gates never pre-empt the flow's own KYC step
test('the withdraw gate and the dispatcher gate leave KYC to the flow (only consents block)', () => {
  const w = sliceFn(processor, 'handleWithdrawStart');
  assert.match(w, /requirements\.filter\(\(r\) => r\.type !== 'KYC_TIER'\)/);
  assert.match(w, /if \(verdict\.decision === 'require' && blocking\.length > 0\)/);
  const d = sliceFn(processor, 'dispatchOrchestratorAction');
  assert.match(d, /const blocking = verdict\.requirements\.filter\(\(r\) => r\.type !== 'KYC_TIER'\)/);
  assert.match(d, /\(verdict\.decision === 'require' && blocking\.length > 0\)/);
});

test('every action the dispatcher gates maps to a registered capability with no requirements, and never to WITHDRAW', () => {
  const src = processor.match(/const ACTION_CAPABILITY = (\{[\s\S]*?\});/);
  assert.ok(src, 'ACTION_CAPABILITY exists');
  const map = new Function(`return ${src[1]};`)();
  for (const id of [...Object.values(map), 'OTT_SELF']) {
    const cap = capabilityById(id);
    assert.ok(cap, `${id} is registered`);
    assert.equal(cap.policy.minKycTier, 0, `${id} needs no KYC tier`);
    assert.equal(cap.policy.consents.length, 0, `${id} needs no consent`);
    assert.equal(cap.policy.adviceClass, 'none');
  }
  assert.ok(!Object.values(map).includes('WITHDRAW'), 'withdraw has its own gated entry, not an AI action');
});

// ---------------------------------------------------------------- memory: what is recorded and how
test('recordInbound is called once, inside handlePostOnboarding, after the state read, guarded by messageId, with secret-input states', () => {
  assert.equal((processor.match(/await recordInbound\(/g) || []).length, 1);
  const at = processor.indexOf('await recordInbound(');
  const fnStart = processor.indexOf('async function handlePostOnboarding');
  const fnEnd = processor.indexOf('\nasync function ', fnStart + 10);
  assert.ok(at > fnStart && at < fnEnd, 'inside handlePostOnboarding');
  assert.ok(processor.indexOf('let { state, data } = await getConversationState(from)') < at, 'after the state read');
  const block = processor.slice(at - 200, at + 600);
  assert.match(block, /if \(messageId\) \{/);
  assert.match(block, /inPinState: \/_PIN\$\|PIN_RESEND_AUTH\|AWAITING_VOUCHER_PIN\//);
  assert.match(block, /secretInput: \/\^PAYOUT_\(ACCOUNT\|ID\)\$\//);
  // onboarding never records: the call is not in processMessage or the onboarding flow
  const pm = sliceFn(processor, 'processMessage');
  assert.ok(!/recordInbound\(/.test(pm.replace(/handlePostOnboarding\([\s\S]*$/, '')));
});

test('login codes are sent as secret and never stored; the swallowing catch rethrows when nothing was sent', () => {
  const admin = processor.indexOf('WaPay admin code:');
  const biz = processor.indexOf('WaPay for Business code:');
  assert.ok(admin > -1 && biz > -1);
  assert.match(processor.slice(admin - 120, admin), /secret: true/);
  assert.match(processor.slice(biz - 120, biz), /secret: true/);
  const hpo = sliceFn(processor, 'handlePostOnboarding');
  assert.match(hpo, /const sendsAtEntry = outboundSendCount\(\);/);
  assert.match(hpo, /if \(outboundSendCount\(\) === sendsAtEntry\) throw error;/);
});

test('redaction: grouped voucher PINs, login codes, and secret inputs keep no digits', () => {
  assert.equal(redactForMemory('my pin 1234-5678-9012-3456 pls'), 'my pin [16-digit code …56] pls');
  assert.equal(redactForMemory('1234 5678 9012 3456'), '[16-digit code …56]');
  assert.match(redactForMemory('🔐 *WaPay admin code: 482913*'), /admin code: \[code\]\*/);
  assert.match(redactForMemory('Your OTP: 4821'), /OTP: \[code\]/);
  assert.equal(redactForMemory('62345678901', { secretInput: true }), '[hidden]');
  assert.equal(redactForMemory('623 456 789 01', { secretInput: true }), '[hidden]');
  assert.equal(redactForMemory('8001015009087', { secretInput: true }), '[hidden]');
  assert.equal(redactForMemory('my pin is 1234', { inPinState: true }), 'my pin is [PIN]');
  // ordinary text keeps phone numbers and amounts
  assert.equal(redactForMemory('send R50 to 0837654321'), 'send R50 to 0837654321');
});

test('say: a memory failure after a successful send still returns ok; a secret send records nothing', async () => {
  const sends = [];
  const created = [];
  const okTransport = async (a) => { sends.push(a); return { ok: true, data: { messages: [{ id: 'wamid.1' }] } }; };
  configureSay({ transport: okTransport, prisma: { account: { findUnique: async () => { throw new Error('db down'); } }, conversationTurn: { create: async (x) => { created.push(x); return { id: 't1' }; } } } });
  const r1 = await say({ to: '27821234567', text: 'hello' });
  assert.equal(r1.ok, true, 'account lookup failure never fails the send');
  configureSay({ transport: okTransport, prisma: { account: { findUnique: async () => ({ id: 'acc1' }) }, conversationTurn: { create: async () => { throw new Error('insert failed'); } } } });
  const r2 = await say({ to: '27821234567', text: 'hello again' });
  assert.equal(r2.ok, true, 'insert failure never fails the send');
  configureSay({ transport: okTransport, prisma: { account: { findUnique: async () => ({ id: 'acc1' }) }, conversationTurn: { create: async (x) => { created.push(x); return { id: 't2' }; } } } });
  await say({ to: '27821234567', text: 'code: 123456', secret: true });
  assert.equal(created.length, 0, 'a secret send is never stored');
  await say({ to: '27821234567', text: 'stored' });
  assert.equal(created.length, 1);
  configureSay({ transport: undefined, prisma: undefined });
});

test('recordInbound: a redelivered message id is stored once', async () => {
  const rows = [];
  const prisma = {
    account: { findUnique: async () => ({ id: 'acc1' }) },
    conversationTurn: {
      findFirst: async ({ where }) => rows.find((r) => r.waMessageId === where.waMessageId && r.role === where.role) || null,
      create: async ({ data }) => { const row = { id: `t${rows.length + 1}`, ...data }; rows.push(row); return { id: row.id }; },
    },
  };
  configureSay({ prisma });
  await recordInbound({ waId: '27821234567', text: 'hi', waMessageId: 'wamid.x' });
  const second = await recordInbound({ waId: '27821234567', text: 'hi', waMessageId: 'wamid.x' });
  assert.equal(rows.length, 1);
  assert.equal(second.duplicate, true);
  configureSay({ transport: undefined, prisma: undefined });
});

// ---------------------------------------------------------------- provenance
test('knownAmountsFromPack admits settled money only; the figure parser reads thousands separators', () => {
  const knownAmountsFromPack = extractFn(processor, 'knownAmountsFromPack');
  const looksLikeReceipt = extractFn(processor, 'looksLikeReceipt');
  const set = knownAmountsFromPack({
    balances: { spendCents: 6600, cashCents: 0, heldSpendCents: 0, heldCashCents: 0 },
    movements: [
      { kind: 'PAYOUT', amountCents: 5000, feeCents: 800, status: 'PENDING' },
      { kind: 'DEPOSIT', amountCents: 2000, feeCents: 0, status: 'SUCCESS' },
      { kind: 'SEND', amountCents: 7500, feeCents: 300, status: 'FAILED' },
    ],
    pendingPayout: { amountCents: 5000, feeCents: 800, heldCents: 5800 },
    openPayLinks: [{ amountCents: 15000 }],
  });
  assert.ok(set.settled.has(2000) && set.balances.has(6600));
  // 2026-09-18: pending, failed and open figures ARE quotable (the record
  // handed them to the model, and 'what did I buy' must be able to list them),
  // but they are never settled, so they can never back a success claim. The
  // assertions below are the security property; the bucket is the mechanism.
  for (const c of [5000, 5800, 7500, 15000]) assert.ok(!set.settled.has(c), 'pending, failed and open amounts are never provenance for a receipt');
  assert.ok(set.balances.has(15000) && set.balances.has(5000), 'but the agent may repeat what the record showed it');
  assert.ok(!looksLikeReceipt('Your R150 pay link is still open and your R50 withdrawal is pending.', set), 'listing the record is allowed');
  assert.ok(looksLikeReceipt('✅ Your R150 pay link was paid.', set), 'calling an open link paid is not');
  assert.ok(looksLikeReceipt('✅ Your R50 withdrawal was paid.', set), 'a pending amount cannot be spoken as paid');
  assert.ok(!looksLikeReceipt('✅ Your R20 deposit was received. Balance is R66.', set));
  assert.ok(looksLikeReceipt('✅ Deposit received R66', set), 'a balance figure alone never backs a success claim');
  assert.ok(!looksLikeReceipt('Your balance is R66.', set), 'a balance may be quoted without a success claim');
  assert.ok(looksLikeReceipt('✅ Deposit received: R1,000.00', new Set([100])), 'R1,000.00 is not R1');
  assert.ok(looksLikeReceipt('✅ Deposit received: R1 000', new Set([100])));
  assert.ok(!looksLikeReceipt('✅ Deposit received: R1,000.00', new Set([100000])));
  assert.ok(!looksLikeReceipt('✅ Deposit received: R12,50', new Set([1250])), 'a South African decimal comma');
});

// ---------------------------------------------------------------- PIN locks per state, not a fixed window
test('each wallet-PIN state tests the strict shape before its own verifyPIN or execute call', () => {
  for (const state of ['PAYOUT_PIN', 'PAYREQ_PIN', 'DATA_PIN', 'AIRTIME_PIN', 'ELECTRICITY_PIN', 'FUEL_PIN', 'VOUCHER_GIFT_PIN', 'VOUCHER_PIN_RESEND_AUTH']) {
    const body = sliceCase(processor, state);
    const shapeAt = body.search(/\^\\d\{4,6\}\$/);
    assert.ok(shapeAt > -1, `${state} tests /^\\d{4,6}$/`);
    const uses = [body.indexOf('verifyPIN('), body.indexOf('pin: '), body.indexOf('pin = ')].filter((i) => i > -1);
    assert.ok(uses.length > 0 && shapeAt < Math.min(...uses), `${state} checks the shape before using the PIN`);
    assert.match(body, /const pin = text\.trim\(\);|pin: text\.trim\(\)|const pinAttempt = text\.trim\(\);|\/\^\\d\{4,6\}\$\/\.test\(text\.trim\(\)\)/);
  }
});

// ---------------------------------------------------------------- Transactions matcher
test('the Transactions matcher answers list asks and never swallows a money command or a status question', () => {
  const m = processor.match(/const TRANSACTIONS_ASK = \/(.*)\/i;\n/);
  assert.ok(m, 'TRANSACTIONS_ASK exists');
  const re = new RegExp(m[1], 'i');
  for (const yes of ['Transactions', 'my transactions', 'statement', 'what did I buy', 'what did i buy last week', 'my withdrawals', 'who paid my link', 'show me my history', 'my deposits']) {
    assert.ok(re.test(yes), `matches: ${yes}`);
  }
  for (const no of ['withdraw R200', 'send R50 to 0831234567', 'deposit R100', 'request R150', 'did my payment go through', 'my payment to fnb', 'buy R50 airtime', 'balance', 'how do I withdraw money', 'cancel my transaction']) {
    assert.ok(!re.test(no), `does not match: ${no}`);
  }
  assert.ok(processor.indexOf('if (matchTransactionsAsk(text))') < processor.indexOf('const feeTopic = matchFeeAsk(text);'), 'runs before the fee hook');
});

// ---------------------------------------------------------------- execute routes: ordered, not marker presence
test('execute routes: hold key set after reserve, delivery flag set after the provider and before settle, release only before delivery', () => {
  const ROUTES = [['airtime', 'purchaseAirtime('], ['data', 'purchaseDataBundle('], ['electricity', 'purchaseElectricity(']];
  for (const [name, providerCall] of ROUTES) {
    const src = read(`../pages/api/vas/${name}/execute.js`);
    const reserve = src.indexOf('reserveHold(');
    const holdSet = src.indexOf('holdIdemKey = idemKey');
    const provider = src.indexOf(providerCall);
    const delivered = src.indexOf('providerDelivered = true');
    const settle = src.indexOf('settleHold(');
    assert.ok(reserve > -1 && holdSet > -1 && provider > -1 && delivered > -1 && settle > -1, `${name}: all markers present`);
    assert.ok(reserve < holdSet && holdSet < provider && provider < delivered && delivered < settle, `${name}: reserve < holdIdemKey = idemKey < provider call < providerDelivered = true < settleHold`);
    const outerCatch = src.slice(src.lastIndexOf('} catch (error) {'));
    assert.match(outerCatch, /if \(holdIdemKey && !providerDelivered\) \{[\s\S]*?releaseHold\(/, `${name}: releases only before delivery`);
    assert.match(outerCatch, /else if \(holdIdemKey && providerDelivered\)/, `${name}: keeps the hold after delivery`);
  }
});

// ---------------------------------------------------------------- webhook: typing in the background, scoped counter, ring released
test('webhook: typing starts before the turn and is awaited before the ACK; the turn runs in its own send scope; a released claim also clears the dedupe ring', () => {
  const typingStart = webhook.indexOf('typing = sendTypingIndicator({ messageId })');
  const firstDispatch = webhook.indexOf('processMessage({');
  const awaitTyping = webhook.indexOf('if (typing) { await typing; typing = null; }');
  const ack = webhook.indexOf('status(200).json({ ok: true })');
  assert.ok(typingStart > -1 && awaitTyping > -1);
  assert.ok(typingStart < firstDispatch && awaitTyping < ack, 'started before the turn, settled before the ACK');
  assert.ok(!/await sendTypingIndicator\(/.test(webhook), 'never awaited serially before the brain');
  assert.match(webhook, /await runWithSendScope\(async \(\) => \{/);
  assert.match(webhook, /error\.sentSomething = outboundSendCount\(\) > 0;/);
  const release = webhook.slice(webhook.indexOf('releaseClaim({ waMessageId: messageId })'), webhook.indexOf('retryable = true'));
  assert.match(release, /await unmarkMessageProcessed\(from, messageId\);/);
  assert.match(read('../pages/api/webhooks/user-manager.js'), /export async function unmarkMessageProcessed\(waId, messageId\)/);
  const sendTs = read('../packages/whatsapp/src/send.ts');
  assert.match(sendTs, /new AsyncLocalStorage<\{ count: number \}>\(\)/);
  assert.match(sendTs, /export function runWithSendScope/);
});

// ---------------------------------------------------------------- opportunistic reconcile is throttled and short
test('the on-inbound pay-out reconcile asks the rail at most every ten minutes with a short timeout', () => {
  const hook = processor.slice(processor.indexOf('Opportunistic pay-out reconciliation'), processor.indexOf('Opportunistic pay-out reconciliation') + 2200);
  assert.match(hook, /lastCheckedAt/);
  assert.match(hook, /10 \* 60 \* 1000/);
  assert.match(hook, /new OttPayoutClient\(\{ timeoutMs: 3000 \}\)/);
  assert.match(hook, /if \(parkedRef && !recentlyChecked\)/);
});

// ---------------------------------------------------------------- context pack: pending pay-out beyond the capped list; indexed gifts; first names
function packPrisma({ providerRows = [], pendingRow = null, gifts = [] } = {}) {
  const calls = [];
  return {
    calls,
    wallet: { findMany: async () => [{ balanceType: 'SPEND', availableCents: 6600, pendingCents: 0, updatedAt: new Date() }] },
    hold: { findMany: async () => [] },
    providerRequest: {
      findMany: async (q) => { calls.push(['providerRequest.findMany', q]); return providerRows; },
      findFirst: async (q) => { calls.push(['providerRequest.findFirst', q]); return pendingRow; },
    },
    pendingGift: { findMany: async (q) => { calls.push(['pendingGift.findMany', q]); return gifts; } },
    paymentRequest: { findMany: async () => [] },
    beneficiary: { findMany: async () => [{ name: 'Philly Mokoena', msisdn: '0831234567' }, { name: 'Mom', msisdn: '0837654321' }] },
  };
}
const account = { id: 'acc1', waId: '27787051175', msisdn: '0787051175', displayName: 'Nieuwoudt', profile: {} };

test('context pack: the pending pay-out is found by its own query even when newer previews crowd it out', async () => {
  const pendingRow = { id: 'pr-old', provider: 'OTT', route: 'ott-payout', idemKey: 'payout-acc1-x', status: 'PENDING', providerRef: null, requestTs: new Date(Date.now() - 3 * 3600 * 1000), metadata: { method: 'PAYSHAP', amountCents: 5000, feeCents: 800, reference: 'WPC15800A7BD6637', recipient: { name: 'N', account: '***394' } } };
  const previews = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, provider: 'BLU', route: 'airtime-preview', idemKey: `k${i}`, status: 'PENDING', providerRef: null, requestTs: new Date(Date.now() - i * 60000), metadata: { amountCents: 1000, msisdn: '0831234567' } }));
  const prisma = packPrisma({ providerRows: previews, pendingRow });
  const pack = await loadContextPack({ prisma, account });
  assert.ok(pack.pendingPayout, 'pending pay-out surfaced');
  assert.equal(pack.pendingPayout.reference, 'WPC15800A7BD6637');
  const direct = prisma.calls.find(([n]) => n === 'providerRequest.findFirst');
  assert.ok(direct && direct[1].where.route === 'ott-payout');
  const gifts = prisma.calls.find(([n]) => n === 'pendingGift.findMany' && [1][0] !== undefined && n && true);
  const received = prisma.calls.filter(([n, q]) => n === 'pendingGift.findMany' && q.where.recipientMsisdn);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0][1].where.recipientMsisdn, { in: ['0787051175', '27787051175', '+27787051175'] }, 'exact shapes, not a suffix scan');
  const record = renderCustomerRecord(pack);
  assert.match(record, /Pending pay-out/i);
  assert.match(record, /Saved people: Philly, Mom\./, 'first names only');
  assert.doesNotMatch(record, /Mokoena/);
});

// ---------------------------------------------------------------- pay-out sweep: deadline and notify accounting
function sweepPrisma(rows) {
  return {
    providerRequest: {
      findMany: async ({ where = {}, take }) => {
        let out = rows.filter((r) => r.route === where.route);
        if (where.status) out = out.filter((r) => r.status === where.status);
        if (where.metadata?.path) out = out.filter((r) => r.metadata?.[where.metadata.path[0]] === where.metadata.equals);
        if (where.requestTs?.lt) out = out.filter((r) => r.requestTs < where.requestTs.lt);
        return (take ? out.slice(0, take) : out).map((r) => ({ ...r }));
      },
      update: async ({ where, data }) => { const r = rows.find((x) => x.idemKey === where.idemKey); Object.assign(r, data); return { ...r }; },
      findUnique: async ({ where }) => { const r = rows.find((x) => x.idemKey === where.idemKey); return r ? { ...r } : null; },
    },
    account: { findUnique: async () => ({ waId: '27787051175' }) },
    journalEntry: { findUnique: async () => null },
    hold: { findUnique: async () => ({ status: 'ACTIVE' }) },
  };
}
const ledgerStub = { calls: [], async settleHold(a) { this.calls.push(['settle', a]); }, async postEntry(a) { this.calls.push(['post', a]); }, async releaseHold(a) { this.calls.push(['release', a]); }, async ensureWallet() {} };
const old = new Date(Date.now() - 60 * 60 * 1000);
const pendingRow = (i) => ({ id: `r${i}`, provider: 'OTT', route: 'ott-payout', idemKey: `payout-acc1-i${i}`, status: 'PENDING', accountId: 'acc1', requestTs: old, metadata: { method: 'PAYSHAP', amountCents: 5000, feeCents: 800, reference: `WPC${i}` } });

test('the sweep stops picking rows once its deadline passes', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => pendingRow(i));
  const client = { async getPaymentStatus() { await new Promise((r) => setTimeout(r, 40)); return { settlement: 'PENDING', status: 98, outcome: 'PENDING', body: {} }; } };
  const results = await reconcilePendingPayouts({ prisma: sweepPrisma(rows), ledger: ledgerStub, client, limit: 20, deadlineMs: 60 });
  const checked = results.filter((r) => r.checked === true).length;
  const stopped = results.find((r) => r.error === 'DEADLINE');
  assert.ok(checked >= 1 && checked < 6, `some rows checked (${checked}), not all`);
  assert.ok(stopped, 'a DEADLINE marker ends the sweep');
});

test('a failed customer notification is never counted as told', async () => {
  const rows = [pendingRow(9)];
  const client = { async getPaymentStatus() { return { settlement: 'SETTLE', status: 100, outcome: 'PAID', body: {} }; } };
  const out = await sweepPayoutsAndNotify({ prisma: sweepPrisma(rows), ledger: ledgerStub, client, send: async () => ({ ok: false, error: 'boom' }) });
  assert.equal(out.counts.settled, 1);
  assert.equal(out.counts.notified, 0);
  assert.equal(out.counts.notifyFailed, 1);
  assert.deepEqual(out.notified, []);
});

// ---------------------------------------------------------------- daily cron is bounded; erase script clears turns
test('the daily floor is bounded and the ledger verify script erases turns with the account', () => {
  const vas = read('../pages/api/cron/daily-vas-sync.js');
  assert.match(vas, /sweepPayoutsAndNotify\(\{ limit: 5, deadlineMs: 20 \* 1000 \}\)/);
  assert.match(vas, /purgeOldTurns\(\{ prisma, olderThanDays: 30 \}\)/);
  const verify = read('../scripts/verify-ledger-db.mjs');
  assert.ok(verify.indexOf('conversationTurn.deleteMany') < verify.indexOf('account.deleteMany'), 'turns erased before the account');
});
