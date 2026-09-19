/**
 * The founder's live session, 2026-09-19. Three failures on his own phone,
 * replayed here so none of them can come back.
 *
 * 1. "buy R10 airtime" → "which number?" → "0787051175" →
 *    "❌ Amount must be between R5 and R1000". The amount he had already
 *    chosen was thrown away and the phone number was read as a rand figure.
 * 2. The same flow, answered "mine": the purchase was CANCELLED.
 * 3. Two honest answers about his own history were replaced by the fact-built
 *    fallback line, because the receipt guard called them invented receipts.
 *    Both fired the RECEIPT gate, which is one of the three that decide
 *    promotion, so they also reset his clean-day clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSlots } from '../lib/slot-parser.js';
import { looksLikeReceipt, knownAmountsFromPack } from '../pages/api/webhooks/message-processor-v2.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const processor = read('../pages/api/webhooks/message-processor-v2.js');
const selfRe = eval(processor.match(/const SELF_NUMBER = (\/.*\/i);/)[1]);

test('a phone number typed in the normal 0-form is read as a rand amount, so the chosen amount must win', () => {
  // This is the parse that broke the purchase. It is not a bug in the parser:
  // a bare run of digits IS ambiguous. The flow has to prefer what it asked
  // for, which is a number, over what it already knows, which is the amount.
  assert.equal(parseSlots('0787051175', { waId: '27787051175' }).amountCents, 78705117500);
  assert.equal(parseSlots('0787051175', { waId: '27787051175' }).msisdn, '0787051175');

  const state = processor.slice(processor.indexOf("case 'AIRTIME_MSISDN':"), processor.indexOf("case 'AIRTIME_CONFIRM'"));
  assert.match(state, /const amountCents = data\?\.amountCents \|\| filledSlots\.amountCents;/,
    'the amount already chosen wins over anything parsed out of the reply');
  assert.ok(!/String\(filledSlots\.amountCents \|\| ''\)\.replace/.test(state),
    'the prefix heuristic that silently stopped working is gone');
});

test('"mine" means my own number, and never cancels the purchase', () => {
  for (const yes of ['me', 'mine', 'Mine', 'my number', 'my phone', 'myself', 'my own', 'this one', 'same', 'for me', 'self']) {
    assert.equal(selfRe.test(yes), true, yes);
  }
  for (const no of ['my mother', 'my brother', '0787051175', 'cancel', 'stop', 'my mum needs it', '']) {
    assert.equal(selfRe.test(no), false, no);
  }
  const state = processor.slice(processor.indexOf("case 'AIRTIME_MSISDN':"), processor.indexOf("case 'AIRTIME_CONFIRM'"));
  // The decisive ordering: none of those words carry digits, and the
  // not-a-phone-number branch below reads "no digits" as "cancel".
  assert.ok(
    state.indexOf('matchSelfNumber(text) && account.msisdn && data?.amountCents') < state.indexOf('digitsOnly.length < 8'),
    'the self branch runs before the cancel branch',
  );
  // And the data flow learned the same vocabulary.
  const dataState = processor.slice(processor.indexOf("case 'DATA_MSISDN':"), processor.indexOf("case 'DATA_NETWORK'"));
  assert.match(dataState, /matchSelfNumber\(normalized\)/);
});

test('an honest history answer is not a receipt: totals of R0 and figures a tool returned are allowed', () => {
  const pack = {
    balances: { spendCents: 6600, cashCents: 0, heldSpendCents: 0, heldCashCents: 0 },
    movements: [{ kind: 'PAYOUT', amountCents: 2000, feeCents: 0, status: 'FAILED' }],
  };
  const known = knownAmountsFromPack(pack);

  // What he actually got blocked: a summary ending in a zero total.
  const summary = 'Last week, I do not see any completed buys in your history. Completed spending total: R0. Balance is R66.';
  assert.equal(looksLikeReceipt(summary, known), false, 'R0 is not an invented figure');

  // A figure that only a tool returned (a total over more rows than the pack
  // carries) is quotable once the tool's cents are merged in.
  const withTool = { settled: known.settled, balances: new Set([...known.balances, 125000]) };
  assert.equal(
    looksLikeReceipt('Your total spend last month was R1250. Balance is R66.', withTool),
    false,
    'a tool-provided total may be quoted',
  );
  assert.equal(
    looksLikeReceipt('Your total spend last month was R1250. Balance is R66.', known),
    true,
    'the same figure with no tool behind it is still blocked',
  );

  // The anti-fraud property is untouched: a success claim still needs settled money.
  assert.equal(looksLikeReceipt('✅ Received R1250. New balance R66.', withTool), true,
    'a tool figure may be quoted but never called paid');
  assert.equal(looksLikeReceipt('✅ Payment of R999 received. Reference: ABC.', known), true,
    'an invented success claim is still blocked');
});

test('the turn feeds the tools\' own figures into the guard', () => {
  const turn = processor.slice(processor.indexOf('async function handleAgentTurn('), processor.indexOf('async function handleAIChat('));
  assert.match(turn, /const known = knownAmountsFromPack\(pack\);/);
  assert.match(turn, /for \(const c of result\.toolAmountsCents \|\| \[\]\) if \(Number\.isInteger\(c\) && c > 0\) known\.balances\.add\(c\);/);
  assert.ok(!/known\.settled\.add/.test(turn), 'a tool figure is quotable, never settled');
  const agentTs = read('../packages/ai/src/agent.ts');
  assert.match(agentTs, /toolAmountsCents/);
  assert.match(agentTs, /if \(res\.ok\) collectCents\(res, result\.toolAmountsCents!\);/);
  assert.ok(!/out\.push\(String/.test(agentTs), 'numbers only: no tool text travels with it');
});
