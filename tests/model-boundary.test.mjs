/**
 * No personal data reaches a model, ever (BUGLOG #111; founder 2026-10-16:
 * "you can never leak personal information to the AI, ever"). Lisa's
 * 2026-10-15 turn is the case: her ID and then her PIN went to the AI after
 * her withdrawal timed out. These tests feed the model boundary her shapes
 * (a synthetic ID and PIN, never hers) and capture exactly what a provider
 * would have received.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecrets, guardChatMessages, guardTranslation, guardEmbeddingInput, guardEmbeddingBatch, tokenize, restore, newVault, ModelBoundaryError, runWithPrivacy, addPrivacyNames, privacyScopeNames, runAgentTurn } from '@wapay/ai';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const ID = '8001015009087'; // a synthetic SA ID (valid date and check digit)

test('secrets: an ID, a passport, a named PIN, an account number; a bare PIN only as the current line', () => {
  assert.deepEqual(findSecrets(ID, { current: true }), ['NUMBER']);
  assert.deepEqual(findSecrets('my passport is FN123456'), ['ID_DOCUMENT']);
  assert.deepEqual(findSecrets('my pin is 2580'), ['PIN']);
  assert.deepEqual(findSecrets('2580', { current: true }), ['PIN']);
  assert.deepEqual(findSecrets('2580'), [], 'a number in our own text is not a PIN');
  assert.deepEqual(findSecrets('R50 1234567890'), ['NUMBER'], 'an amount never hides the account number after it');
  for (const fine of ['buy 1000MB data', 'withdraw R1 500 000', 'started 2026-10-15', 'ref WPC92BDD9664297F', 'withdraw 342 PayShap', 'send R50 to 0821234567']) {
    assert.deepEqual(findSecrets(fine), [], fine);
  }
});

test("Lisa's two messages are refused before any provider sees them", () => {
  for (const current of [ID, 'FN123456', '2580', `my id is ${ID}`]) {
    assert.throws(() => guardChatMessages([{ role: 'system', content: 'You are Pay.' }, { role: 'user', content: current }], { currentIndex: 1 }), (e) => e instanceof ModelBoundaryError && e.code === 'AI_PRIVACY_BLOCK', current);
  }
});

test('names, phones and e-mails become tokens and come back; our own references become tokens, never a refusal', () => {
  const g = guardChatMessages([
    { role: 'system', content: 'Name: Ruth Mahlangu. Recent: deposit R50, ref 123456789. Saved people: Thandi.' },
    { role: 'user', content: 'send R50 to Thandi on 082 123 4567, receipt to ruth@example.com' },
  ], { names: ['Ruth Mahlangu', 'Thandi'], currentIndex: 1 });
  const all = g.messages.map((m) => m.content).join('\n');
  for (const leak of ['Ruth', 'Mahlangu', 'Thandi', '082 123 4567', '1234567', '123456789', 'ruth@example.com']) assert.ok(!all.includes(leak), `no ${leak}`);
  assert.match(all, /\[\[N\d\]\]/); assert.match(all, /\[\[P1\]\]/); assert.match(all, /\[\[E1\]\]/); assert.match(all, /ref \[\[S1\]\]/);
  assert.equal(restore('Done, R50 to [[P1]] for [[N2]].', g.vault), 'Done, R50 to 082 123 4567 for Thandi.');
});

test('the privacy scope: names learned during a request are kept from every model call in it, and nested scopes share it', () => {
  runWithPrivacy(['Lisa'], () => {
    addPrivacyNames(['Ruth Mahlangu']);
    runWithPrivacy(['Gift'], () => {
      assert.deepEqual(privacyScopeNames().sort(), ['Lisa', 'Mahlangu', 'Ruth', 'Ruth Mahlangu']);
    });
    const g = guardChatMessages([{ role: 'user', content: 'hi, this is Ruth' }], { currentIndex: 0 });
    assert.doesNotMatch(g.messages[0].content, /Ruth/);
  });
  assert.deepEqual(privacyScopeNames(), [], 'outside a request there is no scope');
});

test('translation: our own copy goes with every name and secret as a token; nothing unsafe is translated', () => {
  runWithPrivacy(['Ruth Mahlangu'], () => {
    const g = guardTranslation('Please confirm:\nWithdraw R342 to account ⟦0⟧ at Capitec\nName on the account: Ruth Mahlangu\nPassport FN123456');
    assert.ok(g);
    assert.doesNotMatch(g.text, /Ruth|Mahlangu|FN123456/);
    assert.match(restore(g.text, g.vault), /Name on the account: Ruth Mahlangu\nPassport FN123456/);
  });
});

test('embeddings: a query carrying a secret is never embedded; the client batch is checked at the lowest level', () => {
  assert.equal(guardEmbeddingInput(`airtime for ${ID}`), null);
  assert.equal(guardEmbeddingInput('cheap MTN data 1GB'), 'cheap MTN data 1GB');
  assert.deepEqual(guardEmbeddingBatch(['MTN 1000MB 30 days', 'Eskom prepaid code 1234567']), ['MTN 1000MB 30 days', 'Eskom prepaid code [[S1]]']);
});

function fakeClient(script) {
  const seen = [];
  return {
    seen,
    chat: { completions: { async create(params) { seen.push(JSON.parse(JSON.stringify(params.messages))); return script(seen.length, params); } } },
  };
}

test('the agent loop: the provider sees tokens only, tool arguments and the reply come back as values, a tool result is tokenised', async () => {
  const toolArgs = [];
  const client = fakeClient((n) => n === 1
    ? { choices: [{ message: { content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_people', arguments: JSON.stringify({ msisdn: '[[P1]]' }) } }] } }] }
    : { choices: [{ message: { content: 'Hi [[N1]], R50 is ready for [[N2]] on [[P1]].' } }] });
  const out = await runAgentTurn({
    system: 'Name: Ruth Mahlangu.',
    messages: [{ role: 'user', content: 'send R50 to 0821234567' }],
    tools: [{ type: 'function', function: { name: 'get_people', description: 'x', parameters: { type: 'object', properties: {} } } }],
    executeTool: async (name, args) => { toolArgs.push(args); return { ok: true, result: { movements: [{ counterparty: 'Thandi Nkosi', amountCents: 5000 }], product: { name: 'MTN 1GB 30 days' }, ref: '123456789' } }; },
    client, names: ['Ruth Mahlangu'],
  });
  assert.equal(out.outcome, 'reply');
  assert.deepEqual(toolArgs, [{ msisdn: '0821234567' }], 'the tool gets the real number');
  const sent = JSON.stringify(client.seen);
  for (const leak of ['Ruth', 'Mahlangu', 'Thandi', 'Nkosi', '0821234567', '123456789']) assert.ok(!sent.includes(leak), `the provider never saw ${leak}`);
  assert.ok(sent.includes('MTN 1GB 30 days'), 'a product name is not a person: the model sees it');
  assert.equal(out.text, 'Hi Ruth Mahlangu, R50 is ready for Thandi Nkosi on 0821234567.');
});

test('the agent loop: a secret in the current line ends the turn with AI_PRIVACY_BLOCK and the provider is never called', async () => {
  for (const line of [ID, 'FN123456', '2580', `withdraw to 1234567890`]) {
    const client = fakeClient(() => ({ choices: [{ message: { content: 'Now enter your WaPay PIN' } }] }));
    const out = await runAgentTurn({ system: 'x', messages: [{ role: 'user', content: line }], tools: [], executeTool: async () => ({ ok: true }), client });
    assert.equal(out.outcome, 'error'); assert.equal(out.error, 'AI_PRIVACY_BLOCK');
    assert.equal(client.seen.length, 0, `no provider call for ${line}`);
  }
});

test('structure: every model call in the codebase goes through the boundary, and nowhere else may call a provider', () => {
  const hits = [];
  const walk = (dir) => {
    for (const f of readdirSync(join(root, dir))) {
      const rel = join(dir, f);
      if (/node_modules|\/dist\b|\.next|tests\//.test(rel)) continue;
      if (statSync(join(root, rel)).isDirectory()) { walk(rel); continue; }
      if (!/\.(m?js|ts|tsx)$/.test(f)) continue;
      if (/api\.openai\.com|api\.anthropic\.com|chat\.completions\.create|responses\.create|embeddings\.create|new OpenAI\(|new Anthropic\(/.test(read(rel))) hits.push(rel);
    }
  };
  for (const d of ['lib', 'pages', 'packages', 'apps', 'scripts']) { try { walk(d); } catch { /* absent */ } }
  assert.deepEqual(hits.sort(), ['lib/localize.js', 'lib/vas-embeddings.js', 'packages/ai/src/agent.ts', 'packages/ai/src/orchestrator.ts', 'scripts/eval-agent.mjs'], 'a new model call must cross the boundary and be added here');
  assert.match(read('packages/ai/src/orchestrator.ts'), /const \{ messages \} = guardChatMessages\(\s*\[\{ role: 'system' as const, content: args\.system \}, \{ role: 'user' as const, content: args\.user \}\]/);
  assert.match(read('packages/ai/src/orchestrator.ts'), /messages: messages as any,/);
  assert.match(read('packages/ai/src/agent.ts'), /assertGuarded\(params\.messages as any\[\], names\);/);
  assert.match(read('lib/localize.js'), /const guarded = guardTranslation\(frozenText\);/);
  assert.match(read('lib/vas-embeddings.js'), /input: guardEmbeddingBatch\(texts\)/);
  assert.doesNotMatch(read('scripts/eval-agent.mjs'), /chat\.completions\.create/, 'the eval script only hands its client to runAgentTurn');
  const proc = read('pages/api/webhooks/message-processor-v2.js');
  assert.match(proc, /export async function processMessage\(\{ from, text, messageId, profile, sharedContact, referral = null \}\) \{\n  return runWithPrivacy\(/);
  const ai = proc.slice(proc.indexOf('async function handleAIChat('));
  assert.ok(ai.indexOf('bareSecretKind(text)') < ai.indexOf('await orchestrate('), 'a bare secret is answered before the model');
});

test('tokenize is pure on our tokens: a second pass changes nothing', () => {
  const v = newVault();
  const once = tokenize('call 0821234567', v);
  assert.equal(tokenize(once, v), once);
});
