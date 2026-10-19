/**
 * How-it-works knowledge base (2026-09-15): questions about a capability or a
 * process are answered step by step; commands still start flows; the AI gets
 * the same facts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOPICS, matchHowItWorksAsk, howItWorksAnswer, howItWorksFacts, looksLikeQuestion, VAS_LIMITS } from '../lib/how-it-works.js';
import { buildBrainKnowledge } from '../lib/spend-catalogue.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const ON_SCOPE = { airtime: true, data: true, electricity: true, anyVas: true, allVas: true, bluLoad: true, ottLoad: false, voucher: true };
const ctx = { withdrawLive: true, wicodeLive: false, fuelPartners: ['Shell', 'Engen'], ottFacts: 'OTT vouchers are accepted online at partner platforms.', scope: ON_SCOPE };
// No scope in ctx and no switch set: the shipped default (launch scope 2026-10-18).
const holdCtx = { withdrawLive: true, wicodeLive: false, fuelPartners: ['Shell', 'Engen'], ottFacts: 'OTT vouchers are accepted online at partner platforms.' };

test('launch scope: an off topic answers coming soon and what works today, never the steps', () => {
  for (const id of ['airtime', 'data', 'electricity']) {
    const a = howItWorksAnswer(id, holdCtx);
    assert.match(a, /coming soon on WaPay/, id);
    assert.match(a, /Right now you can get paid with a "please pay me" link/, id);
    assert.doesNotMatch(a, /R10 to R5000|buy R50 airtime|show MTN bundles/, `${id}: no steps while off`);
    assert.doesNotMatch(a, /\b(january|february|march|april|may|june|july|august|september|october|november|december|20\d\d)\b/i, `${id}: no date promise`);
  }
  const dep = howItWorksAnswer('deposit', holdCtx);
  assert.match(dep, /Cash at a till \(Blu or OTT voucher\):\* coming soon/);
  assert.doesNotMatch(dep, /ask any major retailer for a \*Blu Voucher\*/);
  assert.match(howItWorksAnswer('ott', holdCtx), /WaPay \(OTT\) vouchers are coming soon/);
  assert.doesNotMatch(howItWorksAnswer('ott', holdCtx), /Say "buy an OTT voucher for R100"/);
  assert.match(howItWorksAnswer('send', holdCtx), /It is free and lands in their WaPay balance/, 'send stays live (founder, 2026-10-18)');
  assert.doesNotMatch(howItWorksAnswer('send', holdCtx), /spend it on airtime/, 'with airtime off, a recipient is never told to spend on it');
  assert.match(howItWorksAnswer('fuel', holdCtx), /coming to WaPay soon/);
  assert.doesNotMatch(howItWorksAnswer('fuel', holdCtx), /airtime, data, electricity, vouchers/, 'the fuel redirect names only what works');
});

test('the founder sentences route to the right topic', () => {
  assert.equal(matchHowItWorksAsk('Can I buy electricity?'), 'electricity');
  assert.equal(matchHowItWorksAsk('Can they withdraw the OTT voucher for money?'), 'ott');
  assert.equal(matchHowItWorksAsk('If I send someone money, can they withdraw it?'), 'send');
  assert.equal(matchHowItWorksAsk('Does it work when I send cash to an ATM? How do I withdraw the money?'), 'withdraw');
  assert.equal(matchHowItWorksAsk('Are OTT vouchers accepted currently?'), 'ott');
  assert.equal(matchHowItWorksAsk('Can I send money to someone?'), 'send');
  assert.equal(matchHowItWorksAsk('How do I withdraw my money to my bank account?'), 'withdraw');
  assert.equal(matchHowItWorksAsk('how does a please pay me link work?'), 'request');
  assert.equal(matchHowItWorksAsk('Can I buy petrol with WaPay?'), 'fuel');
  assert.equal(matchHowItWorksAsk('how do I add money'), 'deposit');
});

test('commands, balance asks and plain inputs are never explained instead of executed', () => {
  for (const t of ['buy R50 electricity', 'Can you send R50 airtime to 0821234567?', 'withdraw R200', 'deposit R100', '50', 'yes', 'mine', 'FNB', "what's my balance?", 'how much money do I have', 'show my vouchers', 'did my payment go through?', 'Where can I spend my WaPay money!', 'What can I buy with this?', 'hi'])
    assert.equal(matchHowItWorksAsk(t), null, t);
  assert.equal(looksLikeQuestion('50'), false); assert.equal(looksLikeQuestion('Standard Bank'), false); assert.equal(looksLikeQuestion('can I take money out'), true);
});

test('answers carry the steps, the real limits and the words to start, and follow the switches', () => {
  const e = howItWorksAnswer('electricity', ctx);
  assert.match(e, /R10 to R5000/); assert.match(e, /buy R100 electricity/); assert.match(e, /meter number/);
  const w = howItWorksAnswer('withdraw', ctx);
  assert.match(w, /withdraw R200/); assert.match(w, /R8 fee/); assert.match(w, /Absa or Nedbank ATM/); assert.ok(!/eWallet/.test(w), 'no eWallet unless the rail lists it (BUGLOG #119)'); assert.match(howItWorksAnswer('withdraw', { ...ctx, providers: [{ method: 'PAYSHAP' }, { method: 'CASHSEND' }, { method: 'EWALLET' }] }), /FNB eWallet/); assert.match(w, /SA ID number or passport/); assert.match(w, /between R50 and R3000/, 'no live list: the production floor, never the bare R20 config (BUGLOG #119)');
  assert.match(howItWorksAnswer('withdraw', { ...ctx, withdrawLive: false }), /coming soon/);
  const o = howItWorksAnswer('ott', ctx);
  assert.match(o, /12-digit PIN/); assert.match(o, /Checkers, Shoprite, Pick n Pay/); assert.match(o, /cannot be exchanged for cash/); assert.match(o, /36 months/);
  const ch = howItWorksAnswer('ott', { ...ctx, text: 'Is it accepted at Checkers?' });
  assert.match(ch, /No, Checkers does not take OTT vouchers/); assert.match(ch, /sells OTT vouchers at the till/);
  assert.match(howItWorksAnswer('ott', { ...ctx, text: 'can I use it on Talk360?' }), /Yes, Talk360 takes OTT vouchers/);
  assert.equal(matchHowItWorksAsk('Is it accepted at Checkers?'), 'ott'); assert.equal(matchHowItWorksAsk('does takealot take it?'), 'ott'); assert.equal(matchHowItWorksAsk('can I pay netflix with it'), 'ott');
  const s = howItWorksAnswer('send', ctx);
  assert.match(s, /It is free and lands in their WaPay balance/); assert.match(s, /straight away if they use WaPay, or when they join/); assert.doesNotMatch(s, /voucher PIN|R3/); assert.match(s, /withdraw it to their own bank account/); assert.ok(!/instantly|in minutes|within (?:seconds|a minute)/.test(s), "no time promised (2026-10-12)");
  assert.match(howItWorksAnswer('send', { ...ctx, withdrawLive: false }), /Cash withdrawals are coming soon/);
  assert.match(howItWorksAnswer('fuel', ctx), /coming to WaPay soon/); assert.match(howItWorksAnswer('fuel', { ...ctx, wicodeLive: true }), /Shell and Engen/);
  assert.match(howItWorksAnswer('deposit', ctx), /R20 costs R24/);
  assert.match(howItWorksAnswer('request', ctx), /R5 to R3000/);
  for (const [id, t] of Object.entries(TOPICS)) {
    const a = t.answer(ctx);
    assert.ok(!/—|–/.test(a), `${id}: no em dashes`); assert.ok(!/\b(bet|bets|betting|gambl\w*)\b/i.test(a), `${id}: no betting words`);
    assert.ok(!/\b(january|february|march|april|may|june|july|august|september|october|november|december|20\d\d)\b/i.test(a), `${id}: no date promises`);
  }
  assert.deepEqual(VAS_LIMITS.ELECTRICITY, [1000, 500000]);
});

test('the AI knowledge block carries the same facts; the processor answers questions before any flow starts; in-flow questions are asides', () => {
  const k = buildBrainKnowledge({ wicodeLive: false, withdrawLive: true });
  assert.match(k, /HOW IT WORKS/); assert.match(k, /Prepaid electricity: /); assert.match(k, /never start a flow yourself/);
  assert.match(howItWorksFacts(ctx), /Withdrawing money \(cash-out\): /);
  const p = read('../pages/api/webhooks/message-processor-v2.js');
  const fee = p.indexOf('const feeTopic = matchFeeAsk(text);'); const how = p.indexOf('const howTopic = matchHowItWorksAsk(text);'); const wd = p.indexOf('if (payoutAllowedFor(from)) {\n    const { matchWithdrawAsk }'); const det = p.indexOf('const detection = detectExplicitIntent(text);');
  assert.ok(fee > -1 && how > fee && wd > how && det > wd, 'order: fees, how it works, withdraw command, keyword router');
  assert.match(p, /async function handleHowItWorks\(\{ from, account, topic, text \}\)/);
  const c = read('../lib/payout-chat.js');
  assert.match(c, /looksLikeQuestion\(t\) && !stepInputParses\(state, t, data, account\)/, 'a question mid-flow never becomes input');
  assert.match(c, /Back to your withdrawal/);
});
