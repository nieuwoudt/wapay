/**
 * The tool registry for the pay agent (docs/AGENT_ARCHITECTURE_V2.md C10).
 *
 *   buildToolDefinitions({ waId, account, pack }) -> OpenAI function tools,
 *     strict: read tools always, proposal tools only for capabilities live
 *     for THIS customer (lib/capabilities.js), the reply tool always.
 *   executeTool({ name, args, ctx }) -> the tool's result, never a throw:
 *     read tools      { ok, result } | { ok: false, error }
 *     proposal tools  { ok, proposal: { action, slots } }
 *     reply           { ok, reply: { kind, text, pendingIntent } }
 *     propose_note    { ok, accepted, note }: keeps what the customer said
 *                     about themselves, unless they asked us not to.
 *
 * Plain JavaScript beside the helpers: no model client, no localizer, no
 * ledger writer is imported anywhere under lib/agent/tools (tests lock it).
 * The AI proposes; the deterministic flow confirms and executes.
 */
import { isCapabilityLiveFor } from '../../capabilities.js';
import { executeReadTool } from './read.js';
import { executeProposalTool, executeProposeNote, cleanPendingIntent } from './proposals.js';
import {
  READ_TOOLS, PROPOSAL_TOOLS, NOTE_TOOL, REPLY_TOOL, REPLY_TOOL_NAME, NOTE_TOOL_NAME,
  toolDefinition, readToolByName, proposalToolByName,
} from './schemas.js';

export { REPLY_TOOL_NAME, NOTE_TOOL_NAME, PROPOSAL_ACTIONS, SLOT_KEYS } from './schemas.js';

export function isReadTool(name) { return !!readToolByName(name); }
export function isProposalTool(name) { return !!proposalToolByName(name); }
export function isReplyTool(name) { return String(name || '') === REPLY_TOOL_NAME; }

/** The proposal tools this customer may be offered, in registry order. */
export function proposalToolsFor({ waId, account } = {}) {
  const ctx = { waId, account };
  return PROPOSAL_TOOLS.filter((t) => !t.capabilityId || isCapabilityLiveFor(t.capabilityId, ctx));
}

/**
 * The tool list for one turn. Same registry state, same bytes: the list is
 * built from frozen definitions, so the provider's prompt cache holds.
 */
export function buildToolDefinitions({ waId, account, pack } = {}) {
  const ctx = { waId: waId || pack?.waId || account?.waId || null, account };
  return [
    ...READ_TOOLS.map(toolDefinition),
    ...proposalToolsFor(ctx).map(toolDefinition),
    toolDefinition(NOTE_TOOL),
    toolDefinition(REPLY_TOOL),
  ];
}

function parseArgs(args) {
  if (args == null) return {};
  if (typeof args === 'string') {
    try { const v = JSON.parse(args); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  }
  return typeof args === 'object' ? args : {};
}

function executeReply(args) {
  const kind = args.kind === 'clarify' ? 'clarify' : 'reply';
  const text = String(args.text ?? '').trim();
  if (!text) return { ok: false, error: 'EMPTY_REPLY' };
  const pendingIntent = kind === 'clarify' ? cleanPendingIntent(args.pendingIntent) : null;
  return { ok: true, reply: { kind, text, pendingIntent } };
}

/**
 * Run one tool by name. `ctx` = { prisma, account, waId, pack, now } and,
 * for tests, an optional `payoutClient` stub (GetPaymentStatus only).
 * Never throws.
 */
export async function executeTool({ name, args, ctx = {} } = {}) {
  const toolName = String(name || '');
  const parsed = parseArgs(args);
  const turnCtx = { ...ctx, waId: ctx.waId || ctx.pack?.waId || ctx.account?.waId || null };
  try {
    if (toolName === REPLY_TOOL_NAME) return executeReply(parsed);
    if (toolName === NOTE_TOOL_NAME) return await executeProposeNote(parsed, turnCtx);
    if (isProposalTool(toolName)) {
      const def = proposalToolByName(toolName);
      if (def.capabilityId && !isCapabilityLiveFor(def.capabilityId, { waId: turnCtx.waId, account: turnCtx.account })) {
        return { ok: false, error: 'NOT_LIVE' };
      }
      return executeProposalTool(toolName, parsed);
    }
    if (isReadTool(toolName)) return await executeReadTool(toolName, parsed, turnCtx);
    return { ok: false, error: 'UNKNOWN_TOOL' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}
