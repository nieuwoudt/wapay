/**
 * The Pay agent loop (packages/ai/src/agent.ts) and prompt assembler
 * (packages/ai/src/prompt.ts), driven with a fake model client: no provider,
 * no network, no OPENAI_API_KEY.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runAgentTurn,
  buildAgentSystemPrompt,
  buildAgentPromptParts,
  REPLY_TOOL_NAME,
  TOOLS_LINE,
  RECORD_MARKER,
  COMPOSITION_RULES,
} from '@wapay/ai';

const usage = { prompt_tokens: 100, completion_tokens: 20 };

const textResponse = (content) => ({ choices: [{ message: { role: 'assistant', content } }], usage });
const toolResponse = (calls, content = null) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content,
        tool_calls: calls.map((c, i) => ({
          id: `call_${i}_${c.name}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        })),
      },
    },
  ],
  usage,
});

/** A scripted client: one response per call, records every params object it saw. */
function fakeClient(script) {
  const seen = [];
  return {
    seen,
    chat: {
      completions: {
        create: async (params, options) => {
          seen.push({ params, options });
          const next = script.shift();
          if (!next) throw new Error('script exhausted');
          return typeof next === 'function' ? next(params) : next;
        },
      },
    },
  };
}

const tool = (name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, strict: true } });
const tools = [tool('get_transactions'), tool('get_fee_quote'), tool('start_send'), tool(REPLY_TOOL_NAME)];

const executeTool = async (name, args) => {
  if (name === 'get_transactions') return { ok: true, result: { rows: [], totals: { count: 0, sumCents: 0, byKind: {} } } };
  if (name === 'get_fee_quote') return { ok: true, result: { text: 'Sending costs R3.', schedule: {} } };
  if (name === 'start_send') return { ok: true, proposal: { action: 'SEND_VOUCHER', slots: { amountCents: args.amountCents ?? null, msisdn: args.msisdn ?? null } } };
  if (name === REPLY_TOOL_NAME) return { ok: true, reply: { kind: args.kind, text: args.text, pendingIntent: args.pendingIntent ?? null } };
  return { ok: false, error: 'UNKNOWN_TOOL' };
};

const base = { system: 'SYSTEM', messages: [{ role: 'user', content: 'hi' }], tools, executeTool, model: 'gpt-5.5' };

test('plain assistant text is a reply, with GPT-5 params and tool_choice auto on round 1', async () => {
  const client = fakeClient([textResponse('Hi there 😊')]);
  const out = await runAgentTurn({ ...base, client });
  assert.equal(out.outcome, 'reply');
  assert.equal(out.text, 'Hi there 😊');
  assert.equal(out.pendingIntent, null);
  assert.equal(out.proposal, null);
  assert.equal(out.model, 'gpt-5.5');
  assert.equal(client.seen.length, 1);
  const p = client.seen[0].params;
  assert.equal(p.tool_choice, 'auto');
  assert.equal(p.messages[0].role, 'system');
  assert.equal(p.max_completion_tokens >= 400, true);
  assert.equal(p.reasoning_effort, 'none');
  assert.equal('temperature' in p, false);
  assert.equal(out.timings.modelMs.length, 1);
  assert.equal(client.seen[0].options.timeout, 8000);
});

test('the reply tool with kind clarify returns clarify plus the pending intent', async () => {
  const pendingIntent = { action: 'BUY_AIRTIME', slots: { amountCents: 5000 } };
  const client = fakeClient([toolResponse([{ name: REPLY_TOOL_NAME, args: { kind: 'clarify', text: 'For which number? 📱', pendingIntent } }])]);
  const out = await runAgentTurn({ ...base, client });
  assert.equal(out.outcome, 'clarify');
  assert.equal(out.text, 'For which number? 📱');
  assert.deepEqual(out.pendingIntent, pendingIntent);
  assert.equal(client.seen.length, 1);
  assert.deepEqual(out.toolCalls.map((c) => c.name), [REPLY_TOOL_NAME]);
});

test('a start_send call is a proposal that ends the loop with no second model call', async () => {
  const client = fakeClient([
    toolResponse([{ name: 'start_send', args: { amountCents: 5000, msisdn: '0821234567' } }], 'Sending R50 now.'),
    textResponse('should never be requested'),
  ]);
  const out = await runAgentTurn({ ...base, client });
  assert.equal(out.outcome, 'proposal');
  assert.deepEqual(out.proposal, { action: 'SEND_VOUCHER', slots: { amountCents: 5000, msisdn: '0821234567' } });
  assert.equal(out.text, 'Sending R50 now.');
  assert.equal(client.seen.length, 1);
  assert.equal(out.toolCalls[0].ok, true);
});

test('two read-tool rounds then a forced compose with tool_choice none on the third call', async () => {
  const client = fakeClient([
    toolResponse([{ name: 'get_transactions', args: { range: 'week', kind: null } }]),
    toolResponse([{ name: 'get_fee_quote', args: { kind: 'send', amountCents: null } }]),
    (params) => {
      assert.equal(params.tool_choice, 'none');
      return textResponse('This week: nothing yet. Sending costs R3. 💰');
    },
    textResponse('never'),
  ]);
  const out = await runAgentTurn({ ...base, client, maxRounds: 2 });
  assert.equal(out.outcome, 'reply');
  assert.equal(out.text, 'This week: nothing yet. Sending costs R3. 💰');
  assert.equal(client.seen.length, 3);
  assert.deepEqual(client.seen.map((s) => s.params.tool_choice), ['auto', 'auto', 'none']);
  // Tool results were appended as tool messages after the assistant tool_calls turn.
  const third = client.seen[2].params.messages;
  assert.equal(third.filter((m) => m.role === 'tool').length, 2);
  assert.equal(third.filter((m) => m.role === 'assistant' && m.tool_calls).length, 2);
  const toolMsg = third.find((m) => m.role === 'tool');
  assert.equal(JSON.parse(toolMsg.content).ok, true);
  assert.deepEqual(out.toolCalls.map((c) => c.name), ['get_transactions', 'get_fee_quote']);
  // Usage is summed over every model call.
  assert.deepEqual(out.usage, { inputTokens: 300, outputTokens: 60 });
});

test('executeTool throwing becomes a { ok:false } tool result and the loop continues', async () => {
  const client = fakeClient([
    toolResponse([{ name: 'get_transactions', args: {} }]),
    (params) => {
      const toolMsg = params.messages.find((m) => m.role === 'tool');
      const parsed = JSON.parse(toolMsg.content);
      assert.equal(parsed.ok, false);
      assert.match(parsed.error, /boom/);
      return textResponse('I could not fetch that right now. Try again in a moment.');
    },
  ]);
  const throwing = async () => {
    throw new Error('boom');
  };
  const out = await runAgentTurn({ ...base, client, executeTool: throwing });
  assert.equal(out.outcome, 'reply');
  assert.equal(client.seen.length, 2);
  assert.equal(out.toolCalls[0].ok, false);
});

test('a slow model call is outcome error with AI_TIMEOUT, never a throw', async () => {
  const client = { chat: { completions: { create: () => new Promise(() => {}) } } };
  const out = await runAgentTurn({ ...base, client, timeoutMs: 40 });
  assert.equal(out.outcome, 'error');
  assert.equal(out.error, 'AI_TIMEOUT');
  assert.equal(out.text, '');
});

test('a provider quota error maps to AI_QUOTA_EXCEEDED and an unknown one to AI_UNAVAILABLE', async () => {
  const quota = { chat: { completions: { create: async () => { throw Object.assign(new Error('quota'), { code: 'insufficient_quota' }); } } } };
  const other = { chat: { completions: { create: async () => { throw new Error('socket hang up'); } } } };
  assert.equal((await runAgentTurn({ ...base, client: quota })).error, 'AI_QUOTA_EXCEEDED');
  assert.equal((await runAgentTurn({ ...base, client: other })).error, 'AI_UNAVAILABLE');
});

test('the tool-call budget caps executions across rounds and every call id still gets a result', async () => {
  const calls = [];
  const client = fakeClient([
    toolResponse([{ name: 'get_transactions' }, { name: 'get_fee_quote' }, { name: 'get_transactions' }, { name: 'get_fee_quote' }]),
    (params) => {
      assert.equal(params.tool_choice, 'none');
      assert.equal(params.messages.filter((m) => m.role === 'tool').length, 4);
      return textResponse('done');
    },
  ]);
  const exec = async (name, args) => {
    calls.push(name);
    return executeTool(name, args);
  };
  const out = await runAgentTurn({ ...base, client, executeTool: exec, maxToolCalls: 3 });
  assert.equal(out.outcome, 'reply');
  assert.equal(calls.length, 3);
  assert.equal(client.seen.length, 2);
});

test('a GPT-4 family model gets the legacy params', async () => {
  const client = fakeClient([textResponse('ok')]);
  await runAgentTurn({ ...base, client, model: 'gpt-4o-mini' });
  const p = client.seen[0].params;
  assert.equal(p.temperature, 0);
  assert.equal(typeof p.max_tokens, 'number');
  assert.equal('reasoning_effort' in p, false);
});

const promptInput = {
  registryLines: ['Airtime: buy for any number (R5 to R1000), type "buy airtime"', 'Send money: a WaPay voucher to any number, flat R3'],
  feesBlock: 'Send: R3 flat\nDeposit by card: 3.5% + R2',
  customerRecord: 'KNOWN CUSTOMER FACTS\nBalance: R120.00',
  focusKnowledge: null,
  language: 'en',
};

test('the system prompt is assembled in the contract order and ends with the tools line', () => {
  const text = buildAgentSystemPrompt({ ...promptInput, focusKnowledge: 'HOW SENDING WORKS: the recipient gets a voucher.' });
  const order = ['PERSONALITY', 'COMPOSITION RULES', 'MONEY TRUTH RULES', 'LANGUAGE SIGNALS', 'WHAT THIS CUSTOMER CAN DO', 'FEES', 'HOW SENDING WORKS', RECORD_MARKER, 'KNOWN CUSTOMER FACTS', 'TOOLS:'];
  let last = -1;
  for (const marker of order) {
    const at = text.indexOf(marker, last + 1);
    assert.ok(at > last, `${marker} out of order`);
    last = at;
  }
  assert.ok(text.endsWith(TOOLS_LINE));
  assert.ok(text.includes('- Airtime: buy for any number'));
  assert.ok(text.includes('Send: R3 flat'));
  // The reused orchestrator constants carry dashes in their own text; the
  // agent's own rules and the tools line are dash-free.
  assert.doesNotMatch(COMPOSITION_RULES + TOOLS_LINE, /[–—]/, 'no em or en dashes in the agent rules');
});

test('the prefix before the record is identical across turns and differs when the registry differs', () => {
  const a = buildAgentPromptParts(promptInput);
  const b = buildAgentPromptParts({ ...promptInput, customerRecord: 'KNOWN CUSTOMER FACTS\nBalance: R900.00', focusKnowledge: 'FOCUS', language: 'zu' });
  assert.equal(a.prefix, b.prefix);
  assert.notEqual(a.tail, b.tail);
  const fullA = buildAgentSystemPrompt(promptInput);
  const fullB = buildAgentSystemPrompt({ ...promptInput, customerRecord: 'other' });
  assert.equal(fullA.slice(0, a.prefix.length), fullB.slice(0, a.prefix.length));
  assert.ok(fullA.startsWith(a.prefix));

  const c = buildAgentPromptParts({ ...promptInput, registryLines: [...promptInput.registryLines, 'Withdraw: PayShap to your own bank'] });
  assert.notEqual(a.prefix, c.prefix);
  const d = buildAgentPromptParts({ ...promptInput, feesBlock: 'Send: R5 flat' });
  assert.notEqual(a.prefix, d.prefix);
});
