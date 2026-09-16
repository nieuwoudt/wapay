/**
 * Conversation turns — both sides of every chat turn, append-only
 * (2026-09-16). Replaces the 10-message JSON ring that lived in
 * Account.conversationData.history (pages/api/webhooks/user-manager.js).
 *
 * Rules:
 *   * Text is redacted BEFORE it is stored (redactForMemory). Long digit runs
 *     are bearer secrets until proven otherwise: a 16-digit Blu PIN or a
 *     12-digit OTT PIN IS money, an STS electricity token IS units, an SA ID
 *     or a bank account number is personal data. None of it may reach the
 *     table or the model-context window the table feeds.
 *   * Every write is best-effort: recordTurn never throws. A chat surface
 *     must never fail because memory could not be written.
 *   * Reads are cheap and bounded (limit + maxAgeDays), oldest-first for the
 *     prompt, and never include the inbound message currently being handled
 *     (excludeWaMessageId) so it is not in the prompt twice.
 */

const MAX_TEXT_CHARS = 1500;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// South Africa has no DST; calendar-day markers ("yesterday") use SAST.
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

const last2 = (digits) => `…${digits.slice(-2)}`;

// STS electricity tokens as typed by meters/receipts: 1234-5678-9012-3456-7890.
const STS_GROUPED_RE = /(?<!\d)\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}(?!\d)/g;
// Bank account numbers typed in the withdraw flow: "account 62345678901",
// "acc no: 12345678", "acct# 1234567890".
const ACCOUNT_RE = /\b(acc(?:ount|t)?\.?(?:\s*(?:number|no|nr|num)\.?)?\s*[:#-]?\s*)(\d{8,12})(?!\d)/gi;
// 13+ digit runs: 20 = STS token, 13 = SA ID, anything else = bearer code.
const LONG_RUN_RE = /\d{13,}/g;
// Exactly 12 digits: OTT voucher PINs.
const TWELVE_RE = /(?<!\d)\d{12}(?!\d)/g;
// 4 to 6 digits while the customer is expected to type a PIN.
const SHORT_PIN_RE = /(?<!\d)\d{4,6}(?!\d)/g;
// 12 to 20 digits typed with single spaces or dashes between groups
// ("1234-5678-9012-3456", "1234 5678 9012 3456"): a Blu or OTT voucher PIN
// typed cold, which detectExplicitIntent accepts after stripping separators.
const GROUPED_RE = /(?<!\d)\d(?:[\s-]?\d){11,19}(?!\d)/g;
// Login codes in outbound copy: "admin code: 123456", "code 4821", "OTP: 9012".
// The digits must not continue as a grouped run ("pin 1234-5678-9012-3456" is a
// voucher PIN for the grouped rule below, not a login code).
const LOGIN_CODE_RE = /(\b(?:code|otp|pin|wicode)\b[^\d\n]{0,6})(\d{4,8})(?![\s-]?\d)/gi;
// Any run of 4+ digits, separators allowed, when the customer was asked for
// something secret (a PIN, a bank account number, an ID number).
const SECRET_INPUT_RE = /(?<!\d)\d(?:[\s-]?\d){3,}(?!\d)/g;

/**
 * Redact everything that must never be remembered. Phone numbers (10-11
 * digits) and rand amounts survive so history still slot-fills.
 */
export function redactForMemory(text, { inPinState = false, secretInput = false } = {}) {
  let s = String(text ?? '');
  if (!s) return s;
  // A secret answer (a bank account number, an ID number) keeps no digits at
  // all, phone-length runs included: the customer was asked for a secret.
  if (secretInput) s = s.replace(SECRET_INPUT_RE, '[hidden]');
  // A message that is nothing but 4 to 6 digits is a PIN wherever it lands
  // (a lockout clears the state, then the customer sends the PIN again).
  if (inPinState || /^\s*\d{4,6}\s*$/.test(s)) s = s.replace(/(?<!\d)\d(?:[\s-]?\d){3,5}(?!\d)/g, '[PIN]');
  s = s.replace(LOGIN_CODE_RE, (m, lead) => `${lead}[code]`);
  s = s.replace(STS_GROUPED_RE, (m) => `[electricity token ${last2(m.replace(/\D/g, ''))}]`);
  s = s.replace(GROUPED_RE, (m) => {
    if (!/[\s-]/.test(m)) return m; // contiguous runs are labelled by the rules below
    const d = m.replace(/\D/g, '');
    return `[${d.length}-digit code ${last2(d)}]`;
  });
  s = s.replace(ACCOUNT_RE, (m, lead, digits) => `${lead}[account number ${last2(digits)}]`);
  s = s.replace(LONG_RUN_RE, (m) => {
    if (m.length === 20) return `[electricity token ${last2(m)}]`;
    if (m.length === 13) return `[ID number ${last2(m)}]`;
    return `[${m.length}-digit code ${last2(m)}]`;
  });
  s = s.replace(TWELVE_RE, (m) => `[voucher PIN ${last2(m)}]`);
  return s;
}

function logError(type, extra) {
  console.error(JSON.stringify({ type, ...extra }));
}

/**
 * Append one turn. Redacts, caps at 1,500 chars, inserts. Never throws.
 * @returns {Promise<{ ok: true, id: string } | { ok: false }>}
 */
export async function recordTurn({ prisma, accountId, role, text, kind, lang, waMessageId, refs, inPinState, secretInput } = {}) {
  try {
    if (!prisma || !accountId || !role) return { ok: false };
    const body = redactForMemory(text, { inPinState, secretInput }).slice(0, MAX_TEXT_CHARS);
    if (!body.trim()) return { ok: false };
    const row = await prisma.conversationTurn.create({
      data: {
        accountId,
        role,
        text: body,
        kind: kind ?? null,
        lang: lang ?? null,
        waMessageId: waMessageId ?? null,
        refs: refs && typeof refs === 'object' ? refs : undefined,
      },
      select: { id: true },
    });
    return { ok: true, id: row?.id };
  } catch (error) {
    logError('turn_record_error', { accountId, role, kind, error: error?.message });
    return { ok: false };
  }
}

/**
 * Recent turns for the prompt, oldest-first, bounded, minus the inbound
 * message being handled right now. Never throws (returns []).
 * @returns {Promise<Array<{ role: string, text: string, kind: string|null, createdAt: Date }>>}
 */
export async function recentTurns({ prisma, accountId, limit = 12, excludeWaMessageId, maxAgeDays = 7 } = {}) {
  try {
    if (!prisma || !accountId) return [];
    const since = new Date(Date.now() - maxAgeDays * DAY_MS);
    const where = { accountId, createdAt: { gte: since } };
    if (excludeWaMessageId) {
      // Explicit OR: a bare `not` would also drop rows whose waMessageId is NULL.
      where.OR = [{ waMessageId: null }, { waMessageId: { not: excludeWaMessageId } }];
    }
    const rows = await prisma.conversationTurn.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { role: true, text: true, kind: true, createdAt: true, waMessageId: true },
    });
    return (rows || [])
      .filter((r) => !excludeWaMessageId || r.waMessageId !== excludeWaMessageId)
      .reverse()
      .map(({ role, text, kind, createdAt }) => ({ role, text, kind: kind ?? null, createdAt }));
  } catch (error) {
    logError('turn_read_error', { accountId, error: error?.message });
    return [];
  }
}

const ROLE_LABEL = { user: 'User', assistant: 'Assistant', event: 'Event' };

function sastDayIndex(ms) {
  return Math.floor((ms + SAST_OFFSET_MS) / DAY_MS);
}

function ageMarker(createdAt, now) {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created) || now - created <= SIX_HOURS_MS) return '';
  const days = sastDayIndex(now) - sastDayIndex(created);
  if (days <= 0) return ' (earlier today)';
  if (days === 1) return ' (yesterday)';
  return ` (${days} days ago)`;
}

/**
 * Render turns as prompt lines: "User: ...", "Assistant: ...", "Event: ...",
 * with an age marker once a turn is older than six hours.
 */
export function renderTurns(turns, { now } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.now();
  return (turns || [])
    .map((t) => {
      const label = ROLE_LABEL[t.role] || 'Event';
      return `${label}${ageMarker(t.createdAt, nowMs)}: ${String(t.text ?? '').trim()}`;
    })
    .join('\n');
}

/** Retention sweep. Never throws. */
export async function purgeOldTurns({ prisma, olderThanDays = 30 } = {}) {
  try {
    if (!prisma) return { ok: false, count: 0 };
    const cutoff = new Date(Date.now() - olderThanDays * DAY_MS);
    const res = await prisma.conversationTurn.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return { ok: true, count: res?.count ?? 0 };
  } catch (error) {
    logError('turn_purge_error', { error: error?.message });
    return { ok: false, count: 0 };
  }
}

/** Erase one customer's history (POPIA / "forget me"). Never throws. */
export async function eraseTurns({ prisma, accountId } = {}) {
  try {
    if (!prisma || !accountId) return { ok: false, count: 0 };
    const res = await prisma.conversationTurn.deleteMany({ where: { accountId } });
    return { ok: true, count: res?.count ?? 0 };
  } catch (error) {
    logError('turn_erase_error', { accountId, error: error?.message });
    return { ok: false, count: 0 };
  }
}
