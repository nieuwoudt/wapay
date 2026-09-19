/**
 * Phase 3 deletes the pre-model regex layer in two batches, "with the eval as
 * the gate" (docs/AGENT_ARCHITECTURE_V2.md section 8). This file is what makes
 * that sentence mean something.
 *
 * The gate only works if the eval actually exercises the thing being deleted.
 * On 2026-09-19 it did not: the golden corpus covers airtime, data,
 * electricity, send, redeem, deposit, balance and help in all eleven
 * languages, but REQUEST_MONEY, BUY_FUEL, the product-browse hook and the
 * category-context hook had NO cases at all, so deleting those hooks would
 * have proved nothing. Cases were added; this test stops the gap reopening.
 *
 * The rule it enforces: every hook on the deletion list must (a) still exist
 * in the processor, so this table cannot rot, and (b) have at least one eval
 * case that proves the agent does its job. A hook with no covering case is not
 * ready to delete, and the failure says so by name.
 *
 * Nothing here deletes anything. Deletion happens after promotion, which is
 * gated on the founder's pilot week.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const processor = read('../pages/api/webhooks/message-processor-v2.js');
const agentCases = JSON.parse(read('../tests/fixtures/agent-eval-cases.json'));
const golden = JSON.parse(read('../tests/fixtures/orchestrator-golden.json'));

const actions = new Set(golden.map((c) => c.expectAction).concat(agentCases.map((c) => c.expectAction)).filter(Boolean));
const groups = new Set(agentCases.map((c) => c.group).filter(Boolean));

/**
 * The deletion list. `marker` is a string that must appear in the processor
 * while the hook is still there; `covered` is what in the corpus proves the
 * agent can take over. Batch 1 is the question hooks, batch 2 the intent
 * hooks, exactly as section 8 orders them.
 */
const HOOKS = [
  // ---- batch 1: the question hooks -------------------------------------
  { batch: 1, name: 'fee ask', marker: 'const feeTopic = matchFeeAsk(text);', covered: { group: 'fees' } },
  { batch: 1, name: 'how it works', marker: 'matchHowItWorksAsk(text)', covered: { group: 'discovery' } },
  { batch: 1, name: 'withdraw matcher', marker: 'matchWithdrawAsk(text)', covered: { action: 'WITHDRAW' } },
  // ---- batch 2: the intent hooks ---------------------------------------
  { batch: 2, name: 'airtime intent', marker: "case 'BUY_AIRTIME':", covered: { action: 'BUY_AIRTIME' } },
  { batch: 2, name: 'data intent', marker: "case 'BUY_DATA':", covered: { action: 'BUY_DATA' } },
  { batch: 2, name: 'electricity intent', marker: "case 'BUY_ELECTRICITY':", covered: { action: 'BUY_ELECTRICITY' } },
  { batch: 2, name: 'send intent', marker: "case 'SEND_VOUCHER':", covered: { action: 'SEND_VOUCHER' } },
  { batch: 2, name: 'pay link intent', marker: "case 'REQUEST_MONEY':", covered: { action: 'REQUEST_MONEY' } },
  { batch: 2, name: 'deposit intent', marker: "case 'DEPOSIT_START':", covered: { action: 'DEPOSIT_START' } },
  { batch: 2, name: 'redeem voucher intent', marker: "case 'REDEEM_VOUCHER':", covered: { action: 'REDEEM_VOUCHER' } },
  // NOT deletable, and the eval cannot make it so: fuel is a founder pilot,
  // so the registry keeps start_fuel out of the tool list for the eval's
  // customer and BUY_FUEL can never be proposed in the corpus. The cases that
  // exist prove the RIGHT thing for today, that a capability which is not live
  // is explained and never proposed. This hook waits for fuel to go live.
  { batch: 2, name: 'fuel intent', marker: "case 'BUY_FUEL':", blockedBy: 'fuel is not live for the eval customer, so BUY_FUEL cannot be proposed in the corpus', covered: { group: 'not-live' } },
  { batch: 2, name: 'smart product query', marker: 'PRODUCT_QUERY_INDICATORS.some', covered: { group: 'discovery' } },
  { batch: 2, name: 'category context', marker: 'getActiveCategory', covered: { group: 'aside' } },
  { batch: 2, name: 'second help menu', marker: 'const explicitMenuAsk = MENU_ASK_RE.test', covered: { action: 'HELP' } },
];

test('the deletion table is honest: every hook it names still exists in the processor', () => {
  const missing = HOOKS.filter((h) => !processor.includes(h.marker)).map((h) => `${h.name} (${h.marker})`);
  assert.deepEqual(missing, [], 'a hook on the list is already gone, or its marker moved: update the table');
});

const isCovered = (h) => (h.covered.action ? actions.has(h.covered.action) : groups.has(h.covered.group));

test('every hook on the deletion list is either covered by the eval or recorded as blocked, with a reason', () => {
  const uncovered = HOOKS.filter((h) => !isCovered(h) && !h.blockedBy)
    .map((h) => `batch ${h.batch}: ${h.name} (wants ${h.covered.action || `group ${h.covered.group}`})`);
  assert.deepEqual(uncovered, [], 'these hooks cannot be deleted with the eval as the gate, because the eval does not exercise them and nothing says why');
});

test('a hook that is blocked says what would unblock it, and is not deletable', () => {
  const blocked = HOOKS.filter((h) => h.blockedBy);
  // Exactly one today: fuel. If this grows, the deletion batch shrinks.
  assert.deepEqual(blocked.map((h) => h.name), ['fuel intent']);
  for (const h of blocked) {
    assert.ok(h.blockedBy.length > 20, `${h.name} must say what is in the way`);
    assert.ok(processor.includes(h.marker), `${h.name} must still be in the processor`);
  }
});

test('the four that had no coverage on 2026-09-19 are covered now', () => {
  // Named individually so a future fixture edit that drops them fails loudly
  // rather than quietly returning us to deleting hooks blind.
  assert.ok(actions.has('REQUEST_MONEY'), 'pay links');
  // Fuel is covered by the 'not-live' group instead: see the blocked entry.
  assert.ok(agentCases.some((c) => c.group === 'not-live'), 'fuel, as a not-live capability');
  assert.ok(agentCases.some((c) => c.id === 'browse-products'), 'the product browse hook');
  assert.ok(agentCases.some((c) => c.id === 'bare-amount-no-context'), 'the category-context hook');
});

test('the corpus keeps its eleven languages, so promotion stays per language', () => {
  const langs = new Set(golden.map((c) => c.language));
  assert.equal(langs.size, 11, 'the golden corpus is the per-language gate');
  for (const l of ['en', 'af', 'zu', 'xh', 'nso', 'st', 'tn', 'ss', 've', 'ts', 'nr']) {
    assert.ok(langs.has(l), l);
  }
});

test('deletion happens after promotion, and promotion is gated: nothing here removes a hook', () => {
  // A guard against a future session reading this file as permission.
  const gate = read('../docs/AGENT_ARCHITECTURE_V2.md');
  assert.match(gate, /a week of shadow turns with no gate firing on money copy/);
  assert.ok(processor.includes('if (agentV3For(from))'), 'the pilot gate is still the only thing routing to the agent');
});
