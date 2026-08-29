/**
 * Orchestration engine wiring — the AI proposes, the processor disposes.
 *
 * Locks the money-safety invariants of the two-tier engine:
 * - the processor's free-text path calls orchestrate() and dispatches every
 *   declared action through dispatchOrchestratorAction;
 * - model slots are UNTRUSTED: msisdn re-validated (normalise + isValid),
 *   amounts integer-checked, and the model's meter slot is never written
 *   into flow state (the flow collects the meter itself);
 * - SEND_VOUCHER goes through resolveGift + the preview->YES->PIN flow,
 *   never directly to an execute route;
 * - the dispatch function contains NO direct money movement;
 * - the engine itself: structured outputs (strict json_schema) at
 *   temperature 0, 15s timeout, and prompts that ban invented balances,
 *   statuses, and features.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ORCHESTRATOR_ACTIONS, ORCHESTRATOR_DOMAINS, SA_LANGUAGES } from '@wapay/ai';

const processorSource = readFileSync(
  fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)),
  'utf8'
);
const engineSource = readFileSync(
  fileURLToPath(new URL('../packages/ai/src/orchestrator.ts', import.meta.url)),
  'utf8'
);

/** The body of dispatchOrchestratorAction, sliced from the processor. */
function dispatchSource() {
  const start = processorSource.indexOf('async function dispatchOrchestratorAction');
  assert.ok(start > -1, 'processor must define dispatchOrchestratorAction');
  const end = processorSource.indexOf('\nasync function ', start);
  assert.ok(end > start);
  return processorSource.slice(start, end);
}

// ---------------------------------------------------------------------------
// Processor wiring
// ---------------------------------------------------------------------------

test('processor free-text path uses orchestrate, not the legacy single call', () => {
  assert.match(processorSource, /import \{[^}]*orchestrate[^}]*\} from '@wapay\/ai'/);
  assert.ok(!/chatWithAI\(/.test(processorSource), 'legacy chatWithAI call must be gone');
  // v1.3: every turn injects the data-driven, claim-gated spend knowledge.
  assert.match(
    processorSource,
    /await orchestrate\(text, contextString, \{\s*knowledge: buildBrainKnowledge\(\{ wicodeLive: isWicodeLive\(\) \}\),\s*\}\)/
  );
  assert.match(processorSource, /dispatchOrchestratorAction\(\{ from, text, account, result \}\)/);
});

test('every declared action has a dispatch case', () => {
  const body = dispatchSource();
  for (const action of ORCHESTRATOR_ACTIONS) {
    if (action === 'NONE') continue; // NONE falls through to the reply path
    assert.match(
      body,
      new RegExp(`case '${action}'`),
      `dispatch must handle ${action}`
    );
  }
});

test('model slots are re-validated before any flow starts', () => {
  const body = dispatchSource();
  assert.match(body, /normaliseMsisdn\(/, 'msisdn goes through normalisation');
  assert.match(body, /isValidSaMsisdn\(/, 'msisdn must pass SA validation');
  assert.match(body, /Number\.isInteger\(result\.slots\?\.amountCents\)/, 'amount must be an integer');
});

test('the model meter slot never enters flow state — the flow collects the meter', () => {
  const body = dispatchSource();
  const electricityCase = body.slice(body.indexOf("case 'BUY_ELECTRICITY'"), body.indexOf("case 'SEND_VOUCHER'"));
  assert.ok(electricityCase.length > 0, 'BUY_ELECTRICITY case exists');
  assert.match(
    electricityCase,
    /updateConversationState\(from, 'ELECTRICITY_METER', \{ amountCents \}\)/,
    'meter state carries ONLY the amount'
  );
  assert.ok(
    !/meterNumber/.test(electricityCase),
    'the model meter slot must not appear in the electricity dispatch'
  );
});

test('SEND_VOUCHER dispatch reuses resolveGift + the PIN-gated preview flow', () => {
  const body = dispatchSource();
  const sendCase = body.slice(body.indexOf("case 'SEND_VOUCHER'"), body.indexOf("case 'LIST_PRODUCTS'"));
  assert.match(sendCase, /resolveGift\(\{/);
  assert.match(sendCase, /productHint: 'SEND_MONEY'/);
  assert.match(sendCase, /startVoucherGiftPreviewAndConfirm\(/);
});

test('dispatch contains no direct money movement', () => {
  const body = dispatchSource();
  for (const banned of ['postEntry', 'settleHold', 'reserveHold', '/execute', 'OttClient', 'getVoucher']) {
    assert.ok(!body.includes(banned), `dispatch must not reference ${banned}`);
  }
});

// ---------------------------------------------------------------------------
// The engine itself
// ---------------------------------------------------------------------------

test('engine: structured outputs, temperature 0, fail-fast timeout', () => {
  assert.match(engineSource, /type: 'json_schema'/);
  assert.match(engineSource, /strict: true/);
  assert.match(engineSource, /temperature: 0/, 'legacy gpt-4 branch stays deterministic');
  assert.match(engineSource, /CURRENT message only/, 'the language rule pins the reply language');
  assert.match(engineSource, /timeout: 10_000/);
  assert.match(engineSource, /maxRetries: 0/, 'no provider retries inside the webhook budget');
  assert.ok(!/JSON\.parse\((?!content)/.test(engineSource), 'only the schema-guaranteed content is parsed');
});

test('engine: prompts carry the money-truth rules and the honest product list', () => {
  assert.match(engineSource, /NEVER state a balance/i);
  assert.match(engineSource, /never invent transaction status|NEVER promise/i);
  assert.match(engineSource, /SPEND-ONLY/, 'withdrawals honestly unavailable');
  assert.match(engineSource, /CANNOT be exchanged for cash/, 'the OTT written answer is baked in');
  assert.ok(!/PayShap/.test(engineSource), 'no PayShap cash-out claim survives in prompts');
  assert.match(engineSource, /R3 fee/, 'send-money fee is stated');
});

test('engine: all 11 official languages are declared', () => {
  const expected = ['en', 'af', 'zu', 'xh', 'nso', 'st', 'tn', 'ss', 've', 'ts', 'nr'];
  for (const lang of expected) {
    assert.ok(SA_LANGUAGES.includes(lang), `SA_LANGUAGES must include ${lang}`);
  }
  assert.equal(SA_LANGUAGES.length, 12, '11 languages + other');
  assert.equal(ORCHESTRATOR_DOMAINS.length, 7);
});

test('engine: model tiers are env-tunable (Claude migration path)', () => {
  assert.match(engineSource, /WAPAY_ORCHESTRATOR_MODEL/);
  assert.match(engineSource, /WAPAY_CATEGORY_AGENT_MODEL/);
  assert.match(engineSource, /gpt-5\.5/, 'latest mainline orchestrator (132/132 eval 2026-08-20)');
  assert.match(engineSource, /gpt-5\.4-mini/, 'latest mini for category agents');
  assert.match(engineSource, /reasoning_effort/, 'GPT-5 family params adapted');
  assert.match(engineSource, /max_completion_tokens/, 'GPT-5 family params adapted');
});

// ---------------------------------------------------------------------------
// Adversarial-review hardening (2026-08-18)
// ---------------------------------------------------------------------------

/** Extract a small top-level helper function's source and evaluate it. */
function extractProcessorFn(name) {
  const start = processorSource.indexOf(`function ${name}(`);
  assert.ok(start > -1, `processor must define ${name}`);
  const end = processorSource.indexOf('\n}', start);
  const body = processorSource.slice(start, end + 2);
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return ${name};`)();
}

test('voucher confirm + PIN prompt show the FULL recipient number (model slots need eyes on them)', () => {
  assert.match(
    processorSource,
    /To: \$\{normalisedRecipient\}/,
    'confirm message must show the unmasked destination'
  );
  assert.match(
    processorSource,
    /WaPay voucher to \$\{recipientMsisdn\}/,
    'PIN prompt must show the unmasked destination'
  );
  assert.match(processorSource, /check the number carefully/i);
});

test('fake-receipt guard: receipt-shaped AI replies are blocked, honest fee talk is not', () => {
  const looksLikeReceipt = extractProcessorFn('looksLikeReceipt');
  // The fake proof-of-payment shapes an attacker would request:
  assert.ok(looksLikeReceipt('✅ Deposit received: R1,000.00. New balance: R1,042.50. Ref: PF-88231'));
  assert.ok(looksLikeReceipt('Payment successful — R500 credited to your wallet'));
  assert.ok(looksLikeReceipt('Your new balance is R2 000'));
  // Legitimate conversational replies that mention amounts:
  assert.ok(!looksLikeReceipt('Sending money costs a flat R3 fee.'));
  assert.ok(!looksLikeReceipt('Deposits are between R10 and R3000.'));
  assert.ok(!looksLikeReceipt('You can send R10 to R1000 as a WaPay voucher.'));
  // Wiring: the guard is applied to reply-only turns and observable in logs.
  assert.match(processorSource, /orchestrator_reply_blocked/);
  assert.match(processorSource, /looksLikeReceipt\(reply\)/);
});

test('bearer-digit redaction: voucher PINs never reach history or logs, phone numbers survive', () => {
  const redactBearerDigits = extractProcessorFn('redactBearerDigits');
  const redacted = redactBearerDigits('ek het n voucher gekoop 1234567890123456 laai asb R50');
  assert.ok(!redacted.includes('1234567890123456'), 'a 16-digit PIN must be redacted');
  assert.match(redacted, /1234…\[16-digits-redacted\]/);
  assert.equal(
    redactBearerDigits('send R50 to 0837654321'),
    'send R50 to 0837654321',
    'phone numbers stay intact for slot-filling'
  );
  // Wiring: history writes and the structured log both go through redaction.
  assert.match(processorSource, /addToConversationHistory\(from, 'user', redactBearerDigits\(text\)\)/);
  assert.match(processorSource, /text: redactBearerDigits\(text\)/);
  assert.match(processorSource, /msisdn: result\.slots\?\.msisdn \? maskMsisdn\(/);
});
