/**
 * Fee facts (2026-09-13): the bot can state every customer-facing fee, from
 * the same functions that charge it, and price questions never fall into the
 * voucher-redemption keyword trap or the AI's "I don't want to guess".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { matchFeeAsk, feeAnswer, feeFacts, feeSchedule, feeAskAmountCents } from '../lib/fee-facts.js';
import { depositFeeCents } from '../lib/deposits.js';
import { buildBrainKnowledge, spendDestinationLines } from '../lib/spend-catalogue.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

test('the founder screenshot exchange is a fee question, routed by topic', () => {
  assert.equal(matchFeeAsk('How much does it cost to deposit money on here?'), 'deposit');
  assert.equal(matchFeeAsk('But how much does it cost?'), 'general');
  assert.equal(matchFeeAsk('No how much does cash deposits into my wallet cost?'), 'voucher');
  assert.equal(matchFeeAsk('what are your fees'), 'general');
  assert.equal(matchFeeAsk('is it free to send money to my brother?'), 'send');
  assert.equal(matchFeeAsk('what does a please pay me link cost me'), 'request');
  assert.equal(matchFeeAsk('how much is the withdrawal fee'), 'withdraw');
  assert.equal(matchFeeAsk('cash-out fee?'), 'withdraw');
});

test('not fee questions: balances, product prices, plain commands', () => {
  for (const t of ['how much money do I have', 'what is my balance', 'how much is 1GB data', 'how much airtime can I buy', 'deposit R100', 'please pay me R50', 'withdraw R200', 'hi', ''])
    assert.equal(matchFeeAsk(t), null, t);
});

test('answers carry the real numbers from the charging functions', () => {
  const s = feeSchedule();
  assert.equal(s.deposit.examples[0].feeCents, depositFeeCents(2000));
  const a = feeAnswer('deposit');
  assert.match(a, /4\.2% \+ R2\.30/);
  assert.match(a, /R20 costs R24/); assert.match(a, /R100 costs R107/);
  assert.match(a, /keeps 6%/); assert.match(a, /R100 voucher adds R94/);
  const exact = feeAnswer('deposit', 25000);
  assert.match(exact, /R250 costs R263/, 'the named amount gets an exact quote');
  assert.equal(feeAskAmountCents('how much does it cost to deposit R250?'), 25000);
  const g = feeAnswer('general');
  for (const frag of ['What WaPay costs', 'free', 'R3 flat', 'under R50', 'No monthly fees']) assert.ok(g.includes(frag), frag);
  assert.ok(!/—/.test(g) && !/PayShap/.test(g) && !/\bbet/i.test(g), 'customer copy rules');
});

test('withdraw fees follow the payout switch', () => {
  const prev = process.env.WAPAY_PAYOUT_ENABLED;
  try {
    delete process.env.WAPAY_PAYOUT_ENABLED;
    assert.match(feeAnswer('withdraw'), /not available just yet/);
    assert.ok(!/coming soon/.test(spendDestinationLines()) && !/Withdraw/.test(spendDestinationLines()), 'no withdraw line while off');
    assert.match(buildBrainKnowledge({ wicodeLive: false }), /COMING SOON through our payouts partner/);
    process.env.WAPAY_PAYOUT_ENABLED = 'true';
    const w = feeAnswer('withdraw');
    assert.match(w, /R8 to your bank/); assert.match(w, /R10 for a bank transfer/); assert.match(w, /R18 up to R700, R23 up to R1500, R30 above/);
    assert.match(spendDestinationLines(), /🏧 \*Withdraw\*/);
    const k = buildBrainKnowledge({ wicodeLive: false });
    assert.match(k, /WITHDRAWALS ARE LIVE/); assert.ok(!/not available YET/.test(k), 'the coming-soon paragraph is gone when live');
    assert.match(k, /FEES YOU CAN QUOTE/); assert.match(k, /R20 costs R24/);
  } finally {
    if (prev === undefined) delete process.env.WAPAY_PAYOUT_ENABLED; else process.env.WAPAY_PAYOUT_ENABLED = prev;
  }
});

test('processor wiring: fee hook before the keyword router, deposit trap ignores cost words, product list reads the catalogue', () => {
  const p = read('../pages/api/webhooks/message-processor-v2.js');
  assert.match(p, /import \{ matchFeeAsk, feeAnswer, feeAskAmountCents \} from '\.\.\/\.\.\/\.\.\/lib\/fee-facts\.js';/);
  const hook = p.indexOf('const feeTopic = matchFeeAsk(text);');
  assert.ok(hook > -1 && hook < p.indexOf('const detection = detectExplicitIntent(text);'), 'fee questions never reach the keyword router');
  assert.match(p, /const wantsDeposit =\s*\n\s*!\/\\b\(fee\|fees\|cost\|costs\|charge\|charges\)\\b\/\.test\(squashed\) && \(/);
  assert.match(p, /async function handleFeeAsk\(\{ from, account, topic, text \}\)/);
  assert.match(p, /addToConversationHistory\(from, 'user', text\);\s*\n\s*await addToConversationHistory\(from, 'assistant', msg\);/, 'both turns land in the AI context');
  assert.match(p, /Here is everything your WaPay money can do right now\*\\n\\n\$\{spendDestinationLines\(\{ wicodeLive: fuelLiveFor\(from\), withdrawLive: payoutAllowedFor\(from\) \}\)\}/, '"what can I buy" opens with the catalogue-built list, gated per customer');
  assert.ok(!/🛒 \*WaPay VAS Products\*/.test(p), 'the three-item dump is gone');
  // Tightened 2026-09-15: the menu follows the PER-USER gate, so it never
  // advertises withdrawal to a customer the pilot allowlist will refuse.
  // Phase 1 (2026-09-16): the Help Menu renders from the registry, whose WITHDRAW gate is payoutAllowedFor.
  assert.match(p, /helpLines\(\{ waId: from, account \}\)/, 'the Help Menu renders from the registry');
  assert.match(read('../lib/capabilities.js'), /payoutAllowedFor\(/, 'the registry withdraw gate is the per-user one');
});

test('the AI prompt never freezes the payout flag and never plants a betting word', () => {
  const ai = read('../packages/ai/src/orchestrator.ts');
  // 2026-09-16: evaluated per call AND per customer (withdrawLive from the pilot allowlist).
  assert.match(ai, /const PRODUCT_TRUTH = \(withdrawLive: boolean = process\.env\.WAPAY_PAYOUT_ENABLED === 'true'\): string =>/, 'evaluated per call, per customer');
  assert.match(ai, /\$\{PRODUCT_TRUTH\(withdrawLive\)\}/);
  assert.ok(!/betting/i.test(ai), 'Meta policy: no betting words in the prompt');
  assert.match(ai, /withdrawals are live, tell them to type/);
  assert.match(feeFacts(), /FEES YOU CAN QUOTE/);
});
