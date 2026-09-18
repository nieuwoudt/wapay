/**
 * Phase 2 of docs/AGENT_ARCHITECTURE_V2.md (2026-09-16): the Pay agent is
 * wired into the processor behind the shadow list WAPAY_AGENT_V3_MSISDNS.
 * These locks pin the shape that keeps money safe: guards before the model,
 * a per-customer budget, proposals through the same PIN-gated flows, the
 * output gates before any send, a fact-built fallback, and a ledger row for
 * every turn.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const processor = read('../pages/api/webhooks/message-processor-v2.js');
const between = (a, b) => processor.slice(processor.indexOf(a), processor.indexOf(b, processor.indexOf(a)));

const turn = between('async function handleAgentTurn(', 'async function handleAIChat(');

test('the shadow gate: a listed number reaches the agent after the guard hooks and before every question hook and the two-tier engine', () => {
  const gate = 'if (agentV3For(from)) {\n    return await handleAgentTurn({ from, text, account, messageId });';
  assert.ok(processor.includes(gate), 'the gate exists exactly once');
  const at = processor.indexOf(gate);
  assert.ok(at > processor.indexOf('if (matchBusinessSignupAsk(text))'), 'after the business hooks');
  assert.ok(at < processor.indexOf('if (matchTransactionsAsk(text))'), 'before the transactions hook');
  assert.ok(at < processor.indexOf('const feeTopic = matchFeeAsk(text);'), 'before the fee hook');
  assert.ok(at < processor.indexOf('return await handleAIChat({'), 'before the two-tier engine');
  // The list itself is lib/shadow-list.js and is tested by running it
  // (tests/shadow-list.test.mjs). What stays a source assertion is the thing
  // only the source can say: the processor uses THAT gate and does not grow a
  // second, looser one of its own.
  assert.ok(!/function agentV3For\s*\(/.test(processor), 'the gate is not redefined inside the processor');
  assert.match(processor, /import \{ agentV3For \} from '\.\.\/\.\.\/\.\.\/lib\/shadow-list\.js'/);
  assert.ok(!processor.includes('process.env.WAPAY_AGENT_V3_MSISDNS'), 'the processor never reads the list variable directly');
});

test('inside the turn: guards run before any model call, the budget before the context load, the ledger records every path', () => {
  const guardAt = turn.indexOf('const guard = agentGuard(text);');
  const budgetAt = turn.indexOf('agentTurnsInLastHour({ prisma, accountId: account.id })');
  const loadAt = turn.indexOf('loadContextPack({ prisma, account })');
  const modelAt = turn.indexOf('await runAgentTurn({');
  assert.ok(guardAt > 0 && guardAt < budgetAt && budgetAt < loadAt && loadAt < modelAt, 'guard → budget → context → model');
  // the three guard kinds each hand off to the existing flow, none to the model
  assert.match(turn, /guard\.kind === 'VOUCHER_PIN'[\s\S]*?handleVoucherRedemption\(\{ from, pin: guard\.pin, account \}\)/);
  assert.match(turn, /guard\.kind === 'PAY_REQUEST_CODE'\) \{\s*handled = await handlePayRequestStart\(/);
  assert.match(turn, /handled = await startVoucherPinResend\(/);
  // the current line reaches the model redacted (labelled PINs, codes, IDs, account numbers)
  assert.match(turn, /\{ role: 'user', content: currentRedacted \}/);
  assert.match(turn, /timeoutMs: 6000/);
  // a failed transport throws so the webhook releases the claim
  assert.match(turn, /if \(sent && sent\.ok === false\) throw Object\.assign\(new Error\('AGENT_SEND_FAILED'\)/);
  assert.doesNotMatch(turn.slice(turn.indexOf('const guard = agentGuard(text);')), /await sendWhatsAppText\(/, 'every send goes through deliver()');
  assert.match(turn, /WAPAY_AGENT_TURNS_PER_HOUR \|\| 60/);
  // ledger rows on: guard, budget, error, proposal, reply/clarify
  assert.equal((turn.match(/await ledger\(/g) || []).length, 5);
  assert.match(turn, /outcome: 'BUDGET'/);
  // the current inbound never appears twice in the messages
  assert.match(turn, /excludeWaMessageId: messageId/);
  assert.match(turn, /turnsRaw\.slice\(0, -1\)/);
});

test('a proposal is dispatched through dispatchOrchestratorAction with an empty reply; the agent never sends its own money text', () => {
  const prop = turn.slice(turn.indexOf("result.outcome === 'proposal'"), turn.indexOf('// A reply or a clarifying question'));
  assert.match(prop, /dispatchOrchestratorAction\(\{[\s\S]*?result: \{ action, slots: slots \|\| \{\}, reply: ''/);
  assert.doesNotMatch(prop, /sendWhatsAppText/, 'no direct send on a proposal');
  // the withdraw case exists in the dispatcher, re-checks the per-customer gate, and re-validates its slots
  const wd = between("case 'WITHDRAW': {", "case 'HOME':");
  assert.match(wd, /if \(!payoutAllowedFor\(from\)\)/);
  assert.match(wd, /Number\.isInteger\(result\.slots\?\.amountCents\) && result\.slots\.amountCents > 0/);
  assert.match(wd, /\/\^\[A-Z_\]\{3,20\}\$\/\.test\(result\.slots\.method\)/);
  assert.match(wd, /handleWithdrawStart\(\{ from, account, ask: \{ amountCents: askAmount, method: askMethod \}, text \}\)/);
  assert.ok(processor.indexOf("case 'WITHDRAW': {") > processor.indexOf('async function dispatchOrchestratorAction('), 'inside the dispatcher');
  assert.doesNotMatch(between('const ACTION_CAPABILITY', '};'), /WITHDRAW/, 'the dispatcher gate is not the withdraw gate; handleWithdrawStart runs its own');
});

test('every reply and clarify passes the output gate and the provenance guard; a blocked reply becomes the fact-built fallback; clarify parks AGENT_CLARIFY', () => {
  const rep = turn.slice(turn.indexOf('// A reply or a clarifying question'));
  const sanAt = rep.indexOf('sanitizeUserText(result.text');
  const gateAt = rep.indexOf('outputGate(out, { withdrawLive })');
  const receiptAt = rep.indexOf('looksLikeReceipt(out, knownAmountsFromPack(pack))');
  const sendAt = rep.indexOf("deliver({ to: from, text: out, kind: blocked ? 'fallback' : 'agent' })");
  const parkAt = rep.indexOf("updateConversationState(from, 'AGENT_CLARIFY', { pendingIntent: result.pendingIntent })");
  const ledgerAt = rep.indexOf('await ledger(');
  assert.ok(sanAt > 0 && sanAt < gateAt && gateAt < receiptAt && receiptAt < sendAt, 'sanitize → gate → provenance → send');
  assert.ok(sendAt < parkAt && parkAt < ledgerAt, 'send → park the clarify → ledger row (a throw before the send leaves no row and no state)');
  assert.match(rep, /if \(blocked\) out = await fallback\(\);/, 'one localized fallback for every blocked reply');
  assert.match(rep, /const parked = !blocked && result\.outcome === 'clarify' && !!result\.pendingIntent;/, 'a blocked clarify is never parked');
  assert.match(rep, /kind: blocked \? 'fallback' : 'agent'/);
  // the error path: fallback from the record, never a canned "didn't catch that"
  const err = turn.slice(turn.indexOf("result.outcome === 'error'"), turn.indexOf("result.outcome === 'proposal'"));
  assert.match(err, /await fallback\(\)/);
  assert.match(turn, /const fallback = async \(\) => localizeOutbound\(agentFallbackLine\(pack\), await userLang\(account\)\);/, 'the fallback is localized on every path');
  assert.doesNotMatch(err, /didn't (quite )?(catch|understand)/i);
  assert.doesNotMatch(turn, /Help Menu/);
});

test('agentFallbackLine states only record facts and no partner or betting word', () => {
  const src = between('function agentFallbackLine(pack)', 'async function handleAgentTurn(');
  const formatRands = (c) => 'R' + (c / 100).toFixed(2);
  const formatSast = () => 'Tue 16 Sep, 11:00';
  const fn = new Function('formatRands', 'formatSast', src + '\nreturn agentFallbackLine;')(formatRands, formatSast);
  const a = fn({ balances: { spendCents: 12345 }, movements: [{ at: new Date(), kind: 'AIRTIME', amountCents: 3000, status: 'SUCCESS' }] });
  assert.match(a, /Balance to spend: R123\.45\./);
  assert.match(a, /last movement: Tue 16 Sep, 11:00, airtime R30\.00 \(success\)/);
  assert.doesNotMatch(a, /OTT|bet|wager|—/);
  const b = fn({ balances: { spendCents: 0 }, movements: [] });
  assert.match(b, /Balance to spend: R0\.00\. What would you like to do next\?/);
  assert.doesNotMatch(b, /type "help"/i, 'the fallback ends with an offer, not a menu hint');
  assert.equal(fn(null).includes('R0.00'), true);
});

test('AGENT_CLARIFY: the state clears first, the answer goes back to the agent with the pending intent, and a de-listed number falls through to the normal router', () => {
  const hook = between("if (state === 'AGENT_CLARIFY') {\n    const pendingIntent", 'if (state) {\n    // Universal intent-switch escape');
  assert.match(hook, /const pendingIntent = data\?\.pendingIntent \|\| null;/);
  assert.ok(hook.indexOf("updateConversationState(from, null)") < hook.indexOf('handleAgentTurn({ from, text, account, messageId, pendingIntent })'), 'cleared before the turn');
  assert.match(hook, /state = null; data = null;/);
  // the hook sits after the home triggers (a "home" while clarifying still goes home) and before the intent-switch escape
  assert.ok(processor.indexOf("if (state === 'AGENT_CLARIFY') {\n    const pendingIntent") < processor.indexOf('// Universal intent-switch escape'));
  assert.ok(processor.indexOf("if (state === 'AGENT_CLARIFY') {\n    const pendingIntent") > processor.indexOf('const sendsAtEntry = outboundSendCount();'));
});

test('the imports are the dormant Phase 2 modules, nothing new', () => {
  assert.match(processor, /import \{ orchestrate, runAgentTurn, buildAgentSystemPrompt \} from '@wapay\/ai';/);
  assert.match(processor, /import \{ buildToolDefinitions, executeTool \} from '\.\.\/\.\.\/\.\.\/lib\/agent\/tools\/index\.js';/);
  assert.match(processor, /import \{ agentGuard, outputGate \} from '\.\.\/\.\.\/\.\.\/lib\/agent\/guards\.js';/);
  assert.match(processor, /import \{ recordAgentTurn, agentTurnsInLastHour \} from '\.\.\/\.\.\/\.\.\/lib\/agent\/turn-ledger\.js';/);
  assert.match(processor, /feeFacts \} from '\.\.\/\.\.\/\.\.\/lib\/fee-facts\.js';/);
});
