/**
 * Agent turn ledger — one append-only row per agent turn (2026-09-16,
 * AGENT_ARCHITECTURE_V2 C17). Feeds Mission Control (gates fired, cost,
 * latency), the per-customer hourly budget of model calls, and the audit
 * chain message → proposal → preview → ledger entry.
 *
 * Rules:
 *   * Never throws. A turn must never fail because its ledger row could not
 *     be written, and a budget check must never block a customer because the
 *     count could not be read (0 on error).
 *   * No bearer digits, no full phone numbers. waId is stored as its last 4
 *     digits; JSON payloads pass through redactForMemory (PINs, tokens, IDs,
 *     account numbers) and then an msisdn mask (10-11 digit runs keep the last
 *     4). The masking walks every string in the payload, keys included.
 *   * JSON payloads are capped at 8,000 chars so a runaway tool result cannot
 *     bloat the table; a capped payload keeps a labelled head.
 */

import { redactForMemory } from '../turns.js';

const JSON_CAP_CHARS = 8000;
const ERROR_CAP_CHARS = 500;
const HOUR_MS = 60 * 60 * 1000;

// 10-11 digit runs: SA phone numbers in national (0831234567) or
// international (27831234567) form. Anything longer or shorter is left to
// redactForMemory (12+ = bearer codes and IDs) or is not a phone number.
const MSISDN_RUN_RE = /(?<!\d)\d{10,11}(?!\d)/g;

const ellipsis = '…';

/** …4567 from any phone-number shape; null when there is nothing to keep. */
export function maskWaId(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  return `${ellipsis}${digits.slice(-4)}`;
}

/** Redact bearer digits, then mask 10-11 digit runs down to their last 4. */
export function maskString(text) {
  const s = redactForMemory(String(text ?? ''));
  return s.replace(MSISDN_RUN_RE, (m) => `${ellipsis}${m.slice(-4)}`);
}

/** Deep-mask every string in a JSON-ish value (keys included). */
export function maskValue(value, depth = 0) {
  if (depth > 12) return null;
  if (value == null) return value;
  if (typeof value === 'string') return maskString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => maskValue(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[maskString(k)] = maskValue(v, depth + 1);
    return out;
  }
  return null; // functions, symbols, bigints: nothing to store
}

/**
 * Masked, capped JSON payload for a Json? column. Returns undefined (column
 * left NULL) for nothing, a masked copy when it fits, or a labelled head when
 * the serialised form exceeds the cap.
 */
export function prepareJson(value) {
  if (value === undefined || value === null) return undefined;
  const masked = maskValue(value);
  let text;
  try {
    text = JSON.stringify(masked);
  } catch {
    return { truncated: true, error: 'unserialisable' };
  }
  if (typeof text !== 'string') return undefined;
  if (text.length <= JSON_CAP_CHARS) return masked;
  // The stored form itself must stay under the cap: the head is re-escaped
  // when the wrapper is serialised, so shrink it until the wrapper fits.
  let head = text.slice(0, JSON_CAP_CHARS - 80);
  let wrapper = { truncated: true, chars: text.length, head };
  for (let i = 0; i < 8; i += 1) {
    const over = JSON.stringify(wrapper).length - JSON_CAP_CHARS;
    if (over <= 0) break;
    head = head.slice(0, Math.max(0, head.length - over));
    wrapper = { truncated: true, chars: text.length, head };
  }
  return wrapper;
}

function intOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function strOrNull(v, cap) {
  if (v == null) return null;
  const s = String(v);
  if (!s) return null;
  return cap ? s.slice(0, cap) : s;
}

function logError(type, extra) {
  console.error(JSON.stringify({ type, ...extra }));
}

/**
 * Append one turn row. Masks, caps, inserts. Never throws.
 * @param {{ prisma: any, row: object }} args
 * @returns {Promise<{ ok: true, id: string } | { ok: false }>}
 */
export async function recordAgentTurn({ prisma, row } = {}) {
  try {
    if (!prisma?.agentTurn?.create || !row || typeof row !== 'object') return { ok: false };
    const { accountId, waId, path, outcome } = row;
    if (!accountId || !path || !outcome) return { ok: false };
    const created = await prisma.agentTurn.create({
      data: {
        accountId: String(accountId),
        waId: maskWaId(waId),
        path: String(path),
        outcome: String(outcome),
        promptHash: strOrNull(row.promptHash, 128),
        model: strOrNull(row.model, 128),
        toolCalls: prepareJson(row.toolCalls),
        proposal: prepareJson(row.proposal),
        policyDecision: strOrNull(row.policyDecision, 64),
        gatesFired: prepareJson(row.gatesFired),
        ms: intOrNull(row.ms),
        inputTokens: intOrNull(row.inputTokens),
        outputTokens: intOrNull(row.outputTokens),
        error: row.error == null ? null : maskString(row.error).slice(0, ERROR_CAP_CHARS),
      },
      select: { id: true },
    });
    return { ok: true, id: created?.id };
  } catch (error) {
    logError('agent_turn_record_error', { accountId: row?.accountId, path: row?.path, error: error?.message });
    return { ok: false };
  }
}

/**
 * Rows this account wrote in the last hour: the per-customer model-call
 * budget. Never throws; 0 on any error so a broken count never blocks a turn.
 * @returns {Promise<number>}
 */
export async function agentTurnsInLastHour({ prisma, accountId, now = Date.now() } = {}) {
  try {
    if (!prisma?.agentTurn?.count || !accountId) return 0;
    const since = new Date(now - HOUR_MS);
    // Only turns that reached the model count: guard hand-offs and refusals
    // are free, so a capped customer is not capped again by asking.
    const n = await prisma.agentTurn.count({ where: { accountId, path: 'agent', createdAt: { gte: since } } });
    return Number.isFinite(n) ? n : 0;
  } catch (error) {
    logError('agent_turn_count_error', { accountId, error: error?.message });
    return 0;
  }
}
