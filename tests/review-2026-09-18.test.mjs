/**
 * Founder review 2026-09-18, from a live WhatsApp session on build 9bc355e.
 *
 * His words: "It's too systematic. It already knows which option to choose ...
 * You should just recommend it ... rather than recommending going back to the
 * menu. How can we save the customer's time, with all product recommendations
 * ... to find the best matching product for our client at the lowest rates."
 *
 * Three things he marked:
 *   1. withdraw: "R48 is below the R50 minimum ... Reply back and choose 3 or 4"
 *      is a menu bounce for an answer the flow already holds.
 *   2. "Can you tell me a full history of what you know about me and all my
 *      past transactions?" got the canned how-it-works line, twice.
 *   3. "Where can I spend my OTT voucher?" came back as a paragraph, not a list.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { startWithdraw, handleWithdrawReply } from '../lib/payout-chat.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const processor = read('../pages/api/webhooks/message-processor-v2.js');

const env = () => { process.env.WAPAY_PAYOUT_ENABLED = 'true'; process.env.WAPAY_PAYOUT_KYC = 'off'; };
const verified = { id: 'acc_r5', waId: '27600000901', msisdn: '27600000901', profile: { kyc: { status: 'VERIFIED', firstName: 'Test', lastName: 'Person' } } };
const deps = (totalCents) => ({ payoutBalances: async () => ({ spendCents: 0, cashCents: totalCents, totalCents }), requestPayout: async () => ({ ok: true, status: 'SETTLED', reference: 'WPTEST', amountCents: 0, feeCents: 0 }) });
const live = [
  { method: 'PAYSHAP', providerCode: '127', providerName: 'PayShap Account', minCents: 5000, maxCents: 15000000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile', 'account_number', 'branch_code'] },
  { method: 'CASHSEND', providerCode: '112', providerName: 'ABSA CashSend', minCents: 5000, maxCents: 300000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
  { method: 'NEDCASH', providerCode: '113', providerName: 'Nedbank Cardless', minCents: 2000, maxCents: 300000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
  { method: 'EWALLET', providerCode: '114', providerName: 'FNB eWallet', minCents: 2000, maxCents: 300000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
];

test('below the minimum: the flow offers the one method that carries this amount as a yes or no, and YES switches without a menu', async () => {
  env();
  const d = { ...deps(10000), resolveProviders: async () => live };
  const menu = await startWithdraw({ account: verified, ask: {}, deps: d });
  const absa = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: '2' });
  assert.equal(absa.state, 'PAYOUT_AMOUNT');

  const low = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: absa.data, text: '30' });
  assert.equal(low.state, 'PAYOUT_AMOUNT');
  assert.match(low.text, /^R30 is below the R50 minimum for cash at an Absa ATM, but /);
  assert.match(low.text, /takes R30 for a R\d+(\.\d\d)? fee, so R\d+(\.\d\d)? leaves your balance\. Reply \*YES\* to switch to that, or type another amount\.$/);
  assert.doesNotMatch(low.text, /Reply \*back\*/, 'never sends the customer back to the menu');
  assert.doesNotMatch(low.text, /choose \*3\*/);
  assert.ok(['NEDCASH', 'EWALLET'].includes(low.data.offerMethod), 'a method whose minimum allows R30');
  assert.equal(low.data.offerAmountCents, 3000);

  const yes = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: low.data, text: 'YES' });
  assert.equal(yes.data.method, low.data.offerMethod, 'YES switches to the offered method');
  assert.equal(yes.data.amountCents, 3000, 'and keeps the amount the customer typed');
  assert.notEqual(yes.state, 'PAYOUT_AMOUNT', 'the flow moves on to the recipient step');
  assert.equal(yes.data.offerMethod, null, 'the offer is consumed');
});

test('the offered method is the cheapest one that can carry the amount, never merely the next in the list', async () => {
  env();
  const pricey = live.map((p) => (p.method === 'NEDCASH' ? { ...p, minCents: 2000 } : p));
  const d = { ...deps(50000), resolveProviders: async () => pricey };
  const menu = await startWithdraw({ account: verified, ask: {}, deps: d });
  const absa = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: '2' });
  const low = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: absa.data, text: '25' });
  const { quotePayout } = await import('../lib/payouts.js');
  const fees = ['NEDCASH', 'EWALLET'].map((m) => [m, quotePayout({ method: m, amountCents: 2500, minCents: 2000, maxCents: 300000 }).feeCents]);
  const cheapest = fees.sort((a, b) => a[1] - b[1])[0][0];
  assert.equal(low.data.offerMethod, cheapest, `offers the cheapest (${JSON.stringify(fees)})`);
});

test('when no other method can carry the amount, the refusal states the minimum and asks for an amount, with no menu bounce', async () => {
  env();
  const onlyAbsa = live.filter((p) => p.method === 'CASHSEND');
  const d = { ...deps(30000), resolveProviders: async () => onlyAbsa };
  const start = await startWithdraw({ account: verified, ask: { amountCents: 1000, method: 'CASHSEND' }, deps: d });
  assert.equal(start.state, 'PAYOUT_AMOUNT');
  assert.match(start.text, /R10 is below the R50 minimum for cash at an Absa ATM\. Please type an amount of R50 or more, or "cancel"\./);
  assert.equal(start.data.offerMethod, undefined);
});

test('over the balance by this method: a cheaper method that still carries the full amount is offered first', async () => {
  env();
  const d = { ...deps(6600), resolveProviders: async () => live };
  const menu = await startWithdraw({ account: verified, ask: {}, deps: d });
  const shap = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: '1' });
  assert.equal(shap.state, 'PAYOUT_AMOUNT');
  const over = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: shap.data, text: '60' });
  if (over.data.offerMethod) {
    assert.match(over.text, /^With the R\d+(\.\d\d)? fee that is more than you have by PayShap, but /);
    assert.match(over.text, /Reply \*YES\* to switch to that, or type another amount\.$/);
    const yes = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: over.data, text: 'yes' });
    assert.equal(yes.data.amountCents, 6000, 'the full amount the customer asked for');
  } else {
    assert.match(over.text, /You can withdraw up to R\d+/, 'otherwise the reachable ceiling');
  }
});

// --- the memory and history question -----------------------------------------

const matcherSrc = processor.slice(processor.indexOf('const MEMORY_ASK_LOOSE'), processor.indexOf('/**\n * One question, one answer'));
const memoryHistoryAsk = new Function(matcherSrc + '\nreturn memoryHistoryAsk;')();

test('the founder\'s own sentence is answered, and a product question or money command never is', () => {
  assert.equal(memoryHistoryAsk('Can you tell me a full history of what you know about me / and all my past transactions and questions?'), 'BOTH');
  assert.equal(memoryHistoryAsk('tell me everything you know about me'), 'MEMORY');
  assert.equal(memoryHistoryAsk('what have you got on me?'), 'MEMORY');
  assert.equal(memoryHistoryAsk('can I see all my past transactions'), 'HISTORY');
  assert.equal(memoryHistoryAsk('show me my transaction history please'), 'HISTORY');
  assert.equal(memoryHistoryAsk('my profile'), 'MEMORY');
  for (const t of [
    'what do you know about airtime bundles',
    'send R50 to 0831234567',
    'buy R30 airtime',
    'withdraw R200',
    'did my payment go through',
    'delete my payment link PR7K2FQ4',
    'how much does it cost to deposit',
    'hi',
    '',
  ]) assert.equal(memoryHistoryAsk(t), null, `never: ${t}`);
});

test('the combined answer is one message built from the record, and the hook sits with the other memory hooks', () => {
  const fn = processor.slice(processor.indexOf('async function handleMemoryAndHistory'), processor.indexOf('async function handleMemoryAndHistory') + 2600);
  assert.match(fn, /loadContextPack\(\{ prisma, account, movementLimit: 10 \}\)/);
  assert.match(fn, /rows\.map\(transactionLine\)\.join/);
  assert.match(fn, /🧠 \*What I know about you\*/);
  assert.equal((fn.match(/sendWhatsAppText\(/g) || []).length, 1, 'one message, not two (Meta bills every reply from 1 October 2026)');
  assert.doesNotMatch(fn, /orchestrate\(|runAgentTurn\(/, 'no model call: every number comes from the record');
  const hookAt = processor.indexOf('const ask = memoryHistoryAsk(text);');
  assert.ok(hookAt > processor.indexOf('if (matchAboutMeAsk(text)) {'), 'after the exact matcher');
  assert.ok(hookAt < processor.indexOf('const feeTopic = matchFeeAsk(text);'), 'before the fee hook');
});

// --- the reply shape, for every customer -------------------------------------

test('the list, the separate blocks and the recommend-the-best-step rules reach BOTH the two-tier engine and the agent', () => {
  const orch = read('../packages/ai/src/orchestrator.ts');
  const prompt = read('../packages/ai/src/prompt.ts');
  assert.match(orch, /export const REPLY_SHAPE = /);
  assert.match(orch, /\$\{REPLY_SHAPE\}/, 'wired into the per-domain prompt');
  for (const src of [orch, prompt]) {
    assert.match(src, /Three or more items are a LIST|Three or more items are a list/);
    assert.match(src, /offer THAT step as one yes or no question/);
    assert.match(src, /costs them least or arrives soonest/);
  }
  assert.match(orch, /"Accepted at" and "not accepted at" are separate blocks/);
  assert.doesNotMatch(orch, /reply: 1–3 short sentences/, 'the old sentence-only rule is gone');
});
