/**
 * Three defects verified on 2026-09-16 by the architecture review (page:
 * Pay Agent Architecture; docs/AGENT_ARCHITECTURE_V2.md):
 *
 * 1. The AI's cash-out truth read the GLOBAL switch (payoutLive) while the
 *    home card, the withdraw matcher and how-it-works read the per-customer
 *    pilot list (payoutAllowedFor). With WAPAY_PAYOUT_ALLOWLIST set, a
 *    non-pilot customer saw "Withdraw: coming soon" on home and was told by
 *    the AI to type "withdraw R<amount>", which bounced them back to the AI.
 *    Now every knowledge/fee/prompt call site passes withdrawLive for THIS
 *    customer, and the orchestrator takes it as an option.
 * 2. Only 2 of 9 wallet-PIN states accepted PIN-shaped input strictly; the
 *    rest stripped non-digits from any sentence, so "send R50 to 0831" burned
 *    a PIN attempt (invariant 9).
 * 3. getUserBalance and the three VAS preview routes read wallets[0] with no
 *    balanceType filter; after the first withdrawal attempt a CASH wallet
 *    exists and "balance" could show the wrong one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { feeAnswer, feeFacts, feeSchedule } from '../lib/fee-facts.js';
import { buildBrainKnowledge, buildSpendDestinationsReply } from '../lib/spend-catalogue.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const processor = read('../pages/api/webhooks/message-processor-v2.js');
const orchestrator = read('../packages/ai/src/orchestrator.ts');

test('the AI knowledge, the fee answer and the spend reply follow the per-customer withdraw gate', () => {
  process.env.WAPAY_PAYOUT_ENABLED = 'true';
  // Global switch ON, but this customer is NOT on the pilot list.
  assert.match(feeSchedule({ withdrawLive: false }).withdraw.live ? 'live' : 'off', /off/);
  assert.match(feeAnswer('withdraw', null, { withdrawLive: false }), /coming soon/i);
  assert.match(feeAnswer('withdraw', null, { withdrawLive: true }), /PayShap/);
  assert.match(feeFacts({ withdrawLive: false }), /coming soon/i);
  assert.doesNotMatch(feeFacts({ withdrawLive: false }), /withdraw R200/);
  const offKnowledge = buildBrainKnowledge({ wicodeLive: false, withdrawLive: false });
  assert.match(offKnowledge, /CASH-OUT POSITION/);
  assert.doesNotMatch(offKnowledge, /WITHDRAWALS ARE LIVE/);
  assert.doesNotMatch(offKnowledge, /Withdrawals: R\d/);
  const onKnowledge = buildBrainKnowledge({ wicodeLive: false, withdrawLive: true });
  assert.match(onKnowledge, /WITHDRAWALS ARE LIVE/);
  assert.doesNotMatch(buildSpendDestinationsReply({ wicodeLive: false, withdrawLive: false }), /Withdraw\*/);
  assert.match(buildSpendDestinationsReply({ wicodeLive: false, withdrawLive: true }), /Withdraw\*/);
});

test('every processor call site passes withdrawLive: payoutAllowedFor(from) and the orchestrator honours it', () => {
  const sites = processor.match(/withdrawLive: payoutAllowedFor\(from\)/g) || [];
  assert.ok(sites.length >= 5, `expected the flag at the knowledge, prompt, spend-reply, product-list and fee-answer sites; found ${sites.length}`);
  assert.match(processor, /buildBrainKnowledge\(\{ wicodeLive: fuelLiveFor\(from\), withdrawLive: payoutAllowedFor\(from\), capabilityLines: promptLines\(\{ waId: from, account \}\) \}\)/);
  assert.match(processor, /feeAnswer\(topic, feeAskAmountCents\(text\), \{ withdrawLive: payoutAllowedFor\(from\) \}\)/);
  assert.match(orchestrator, /withdrawLive\?: boolean;/);
  assert.match(orchestrator, /agentPrompt\(tier1\.domain, opts\.knowledge, opts\.withdrawLive\)/);
  assert.match(orchestrator, /const PRODUCT_TRUTH = \(withdrawLive: boolean = process\.env\.WAPAY_PAYOUT_ENABLED === 'true'\)/);
  // No prompt text may read the global env directly any more.
  const envReadsInPrompts = (orchestrator.match(/process\.env\.WAPAY_PAYOUT_ENABLED === 'true' \?/g) || []).length;
  assert.equal(envReadsInPrompts, 0, 'prompt strings must use the withdrawLive argument, not the env');
});

test('every wallet-PIN state accepts only PIN-shaped input (invariant 9)', () => {
  const stateBody = (name) => {
    const start = processor.indexOf(`case '${name}':`);
    assert.ok(start > -1, `state ${name} exists`);
    return processor.slice(start, start + 3500);
  };
  for (const state of ['PAYOUT_PIN', 'PAYREQ_PIN', 'DATA_PIN', 'AIRTIME_PIN', 'ELECTRICITY_PIN', 'FUEL_PIN', 'VOUCHER_GIFT_PIN', 'VOUCHER_PIN_RESEND_AUTH']) {
    const body = stateBody(state);
    assert.match(body, /\^\\d\{4,6\}\$/, `${state} must test /^\\d{4,6}$/ before verifyPIN`);
    assert.doesNotMatch(body, /const pin = digitsOnly;/, `${state} must not feed stripped digits to verifyPIN`);
  }
  assert.equal((processor.match(/const pin = digitsOnly;/g) || []).length, 0);
  assert.equal((processor.match(/pinAttempt = text\.replace\(\/\\D\/g, ''\)/g) || []).length, 0);
});

test('balance readers select the SPEND wallet, never wallets[0] blindly', () => {
  const userManager = read('../pages/api/webhooks/user-manager.js');
  const balanceFn = userManager.slice(userManager.indexOf('export async function getUserBalance'));
  assert.match(balanceFn.slice(0, 900), /wallets: \{ where: \{ balanceType: 'SPEND' \} \}/);
  for (const route of ['airtime', 'data', 'electricity']) {
    const src = read(`../pages/api/vas/${route}/preview.js`);
    assert.match(src, /wallets\?\.find\(\(w\) => w\.balanceType === 'SPEND'\)/, `${route} preview picks the SPEND wallet`);
  }
});

test('a parked pay-out is reconciled on the next inbound message, with GetPaymentStatus only', () => {
  const start = processor.indexOf('Opportunistic pay-out reconciliation');
  assert.ok(start > -1);
  const hook = processor.slice(start, start + 2600);
  assert.match(hook, /status: 'PENDING'/);
  // PENDING after two minutes, INIT after five (2026-09-17): the INIT reconciler asks the rail first
  assert.match(hook, /\{ status: 'INIT', requestTs: \{ lt: new Date\(Date\.now\(\) - 5 \* 60 \* 1000\) \} \}/);
  assert.match(hook, /new OttPayoutClient\(\{ timeoutMs: 3000 \}\)/);
  assert.match(hook, /parked\.status === 'INIT'\s*\? await reconcileInitPayout\(\{ pr: parked, client: railClient \}\)\s*: await reconcilePayout\(\{ reference: parkedRef, client: railClient \}\)/);
  assert.match(hook, /payoutOutcomeMessage\(outcome\)/);
  assert.doesNotMatch(hook, /requestPayout|performPayout/);
});
