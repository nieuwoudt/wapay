/**
 * The Pay agent loop (AGENT_ARCHITECTURE_V2 §3 C9, §4).
 *
 * One turn = at most `maxRounds` tool rounds and `maxToolCalls` tool calls,
 * then one final call with tool_choice 'none' that composes from what is
 * held. Outcomes:
 *   reply     plain assistant text, or the `reply` tool with kind 'reply'
 *   clarify   the `reply` tool with kind 'clarify' and a pending intent
 *   proposal  a start_* tool: the loop ends AT ONCE and the deterministic
 *             processor takes over (preview, confirm, PIN, execute)
 *   error     the provider failed; the caller answers from the record
 *
 * MONEY SAFETY INVARIANTS (do not weaken):
 *   - This loop never executes money. A proposal is data handed back to
 *     the processor, which re-validates every slot and runs the PIN flow.
 *   - Tool results are data in the prompt, never instructions.
 *   - Every model call has a timeout and no retries; the loop never throws.
 *   - The model client is injectable so tests never touch a provider.
 */

import { getOpenAI } from './orchestrator.js';

export const REPLY_TOOL_NAME = 'reply';

export interface AgentTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentPendingIntent {
  action: string;
  slots: Record<string, unknown>;
}

export interface AgentProposal {
  action: string;
  slots: Record<string, unknown>;
  [key: string]: unknown;
}

/** What lib/agent/tools/index.js executeTool returns (contract 1). */
export interface ToolExecResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  proposal?: AgentProposal;
  reply?: { kind: 'reply' | 'clarify'; text: string; pendingIntent: AgentPendingIntent | null };
  accepted?: boolean;
  note?: unknown;
}

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<ToolExecResult> | ToolExecResult;

/** The slice of the OpenAI client the loop uses; a fake with the same shape works in tests. */
export interface AgentModelClient {
  chat: {
    completions: {
      create: (params: any, options?: { signal?: AbortSignal; timeout?: number }) => Promise<any>;
    };
  };
}

export interface RunAgentTurnOptions {
  system: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  executeTool: ToolExecutor;
  client?: AgentModelClient;
  model?: string;
  maxRounds?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  maxTokens?: number;
}

export type AgentOutcome = 'reply' | 'clarify' | 'proposal' | 'error';

export interface AgentToolCallRecord {
  name: string;
  ms: number;
  ok: boolean;
}

export interface AgentTurnResult {
  outcome: AgentOutcome;
  text: string;
  pendingIntent: AgentPendingIntent | null;
  proposal: AgentProposal | null;
  toolCalls: AgentToolCallRecord[];
  timings: { totalMs: number; modelMs: number[] };
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  error?: string;
}

export const AGENT_MODEL = (): string =>
  process.env.WAPAY_AGENT_MODEL || process.env.WAPAY_ORCHESTRATOR_MODEL || 'gpt-5.5';

// Same GPT-5-family handling as callStructured in orchestrator.ts: those
// models reject temperature/max_tokens and take max_completion_tokens (floor
// 400) + reasoning_effort; the GPT-4 family keeps the legacy params.
const REASONING_EFFORT = () => process.env.WAPAY_REASONING_EFFORT || 'none';
const isGpt5Family = (model: string) => /^(gpt-5|o\d)/.test(model);

const TOOL_RESULT_CAP = 4_000;
const DEFAULT_MAX_TOKENS = 600;

function modelParams(model: string, maxTokens: number): Record<string, unknown> {
  return isGpt5Family(model)
    ? { max_completion_tokens: Math.max(maxTokens, 400), reasoning_effort: REASONING_EFFORT() }
    : { max_tokens: maxTokens, temperature: 0 };
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function capJson(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? 'null';
  } catch {
    text = JSON.stringify({ ok: false, error: 'TOOL_RESULT_UNSERIALISABLE' });
  }
  return text.length > TOOL_RESULT_CAP ? `${text.slice(0, TOOL_RESULT_CAP - 1)}…` : text;
}

/**
 * Map provider errors onto the names the processor handles (mirrors
 * normalizeAiError in orchestrator.ts, plus AI_TIMEOUT), logging the cause
 * first so live incidents stay diagnosable.
 */
export function normalizeAgentError(error: any): string {
  try {
    console.error(
      JSON.stringify({
        type: 'agent_provider_error',
        code: error?.code ?? null,
        status: error?.status ?? null,
        name: error?.name ?? null,
        message: (error?.message ?? String(error)).slice(0, 300),
      })
    );
  } catch {
    /* logging never breaks the turn */
  }
  const message: string = typeof error?.message === 'string' ? error.message : String(error ?? '');
  if (/^AI_[A-Z_]+/.test(message)) return message.split(/[:\s]/)[0];
  if (error?.code === 'insufficient_quota') return 'AI_QUOTA_EXCEEDED';
  if (error?.code === 'invalid_api_key') return 'AI_CONFIG_ERROR';
  if (
    error?.name === 'AbortError' ||
    error?.name === 'TimeoutError' ||
    error?.name === 'APIConnectionTimeoutError' ||
    error?.code === 'ETIMEDOUT' ||
    /timed? ?out/i.test(message)
  ) {
    return 'AI_TIMEOUT';
  }
  return 'AI_UNAVAILABLE';
}

/** One model call with a hard deadline; rejects with the provider's error or Error('AI_TIMEOUT'). */
async function callModel(client: AgentModelClient, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('AI_TIMEOUT')), timeoutMs);
  });
  try {
    return await Promise.race([client.chat.completions.create(params, { signal, timeout: timeoutMs }), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readUsage(response: any, usage: AgentTurnResult['usage']): void {
  const u = response?.usage;
  if (!u) return;
  usage.inputTokens += Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  usage.outputTokens += Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
}

export async function runAgentTurn(opts: RunAgentTurnOptions): Promise<AgentTurnResult> {
  const startedAt = Date.now();
  const model = opts.model || AGENT_MODEL();
  const maxRounds = opts.maxRounds ?? 2;
  const maxToolCalls = opts.maxToolCalls ?? 3;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  const result: AgentTurnResult = {
    outcome: 'error',
    text: '',
    pendingIntent: null,
    proposal: null,
    toolCalls: [],
    timings: { totalMs: 0, modelMs: [] },
    usage: { inputTokens: 0, outputTokens: 0 },
    model,
  };
  const finish = (patch: Partial<AgentTurnResult>): AgentTurnResult => {
    Object.assign(result, patch);
    result.timings.totalMs = Date.now() - startedAt;
    return result;
  };

  let client: AgentModelClient;
  try {
    client = opts.client ?? (getOpenAI() as unknown as AgentModelClient);
  } catch (error) {
    return finish({ outcome: 'error', error: normalizeAgentError(error) });
  }

  const chat: any[] = [
    { role: 'system', content: opts.system },
    ...(opts.messages || []).map((m) => ({ role: m.role, content: m.content })),
  ];
  const tools = opts.tools || [];
  let rounds = 0;
  let toolBudget = maxToolCalls;

  try {
    // Rounds 1..maxRounds may call tools; the call after that composes only.
    for (;;) {
      const compose = rounds >= maxRounds || toolBudget <= 0 || tools.length === 0;
      const params: Record<string, unknown> = {
        model,
        messages: chat,
        ...modelParams(model, maxTokens),
      };
      if (tools.length) {
        params.tools = tools;
        params.tool_choice = compose ? 'none' : 'auto';
      }

      const t0 = Date.now();
      const response = await callModel(client, params, timeoutMs);
      result.timings.modelMs.push(Date.now() - t0);
      readUsage(response, result.usage);

      const message = response?.choices?.[0]?.message ?? {};
      if (message.refusal) return finish({ outcome: 'error', error: 'AI_REFUSAL' });
      const content: string = typeof message.content === 'string' ? message.content.trim() : '';
      const calls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];

      if (!calls.length || compose) {
        if (!content) return finish({ outcome: 'error', error: 'AI_EMPTY_RESPONSE' });
        return finish({ outcome: 'reply', text: content });
      }

      // Execute this round's calls in parallel; every call id gets a result
      // message (the API rejects an assistant tool_calls turn left unanswered).
      const execs = await Promise.all(
        calls.map(async (call, index): Promise<{ call: any; name: string; res: ToolExecResult }> => {
          const name: string = call?.function?.name || '';
          const args = parseArgs(call?.function?.arguments);
          if (index >= toolBudget) {
            return { call, name, res: { ok: false, error: 'TOOL_BUDGET_EXCEEDED' } };
          }
          const started = Date.now();
          let res: ToolExecResult;
          try {
            const raw = await opts.executeTool(name, args);
            res = raw && typeof raw === 'object' ? raw : { ok: false, error: 'TOOL_NO_RESULT' };
          } catch (error: any) {
            res = { ok: false, error: String(error?.message || error || 'TOOL_FAILED').slice(0, 200) };
          }
          result.toolCalls.push({ name, ms: Date.now() - started, ok: res.ok === true });
          return { call, name, res };
        })
      );
      toolBudget = Math.max(0, toolBudget - calls.length);
      rounds += 1;

      // A proposal ends the loop at once: the processor previews and confirms.
      const proposed = execs.find((e) => e.res.ok && e.res.proposal && typeof e.res.proposal.action === 'string');
      if (proposed) {
        return finish({ outcome: 'proposal', text: content, proposal: proposed.res.proposal! });
      }

      // The reply tool is the model's final answer.
      const replied = execs.find((e) => e.name === REPLY_TOOL_NAME);
      if (replied) {
        const fromTool = replied.res.ok && replied.res.reply ? replied.res.reply : null;
        const args = parseArgs(replied.call?.function?.arguments);
        const kind = (fromTool?.kind ?? args.kind) === 'clarify' ? 'clarify' : 'reply';
        const text = String(fromTool?.text ?? args.text ?? content ?? '').trim();
        const pending = (fromTool?.pendingIntent ?? args.pendingIntent) as AgentPendingIntent | null | undefined;
        if (!text) return finish({ outcome: 'error', error: 'AI_EMPTY_RESPONSE' });
        return finish({
          outcome: kind,
          text,
          pendingIntent: kind === 'clarify' && pending && typeof pending === 'object' ? pending : null,
        });
      }

      chat.push({
        role: 'assistant',
        content: content || null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.function?.name, arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {}) },
        })),
      });
      for (const e of execs) {
        chat.push({ role: 'tool', tool_call_id: e.call.id, content: capJson(e.res) });
      }
    }
  } catch (error) {
    return finish({ outcome: 'error', error: normalizeAgentError(error) });
  }
}
