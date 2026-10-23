/**
 * say — the outbound text send that remembers what it said (2026-09-16).
 *
 * Drop-in for the package's sendWhatsAppText ({ to, text, category? } ->
 * { ok, data?, error? }). On a successful send it appends the assistant
 * side of the turn to conversation_turns (lib/turns.js), so memory of what
 * WaPay said is recorded by construction rather than at each call site.
 *
 * Extras over the transport, all optional: `kind` (agent | flow | guard |
 * home | receipt ..., default 'flow'), `lang`, `refs`.
 *
 * Never throws. A memory failure never fails a send; a transport failure is
 * returned as the transport's own { ok: false, error } shape.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { recordTurn } from './turns.js';

// One message per customer turn (docs/WHATSAPP_POLICY_COMPLIANCE.md): when a
// step finishes and another step continues in the same turn (the PIN chosen on
// demand, then the pay-out it was for), the finished step's line rides on top of
// the next text to that customer instead of going out on its own. Scoped to the
// turn and to the one number: a line never lands in a message to anyone else.
const leadScope = new AsyncLocalStorage();

/**
 * Run `fn` with `line` waiting for the first text sent to `to` inside it, which
 * then reads `${line}\n\n${text}`. Resolves { out, used }: used false means no
 * text to `to` went out, and the caller sends the line itself.
 */
export async function withLeadLine({ to, line }, fn) {
  const box = { to: String(to || ''), line: String(line || ''), used: false };
  const out = await leadScope.run(box, fn);
  return { out, used: box.used };
}

const ACCOUNT_TTL_MS = 10 * 60 * 1000;
// WhatsApp text body limit is 4,096; split a little under it.
const MAX_SEND_CHARS = 4000;

let transportOverride = null;
let prismaOverride = null;
const accountCache = new Map(); // waId -> { id, expiresAt }

// Per-number send cap (docs/WHATSAPP_POLICY_COMPLIANCE.md, 2026-10-20): no hook,
// flow or agent may send a storm of texts to one number. The ninth text to the
// same number inside twenty seconds is refused with { ok: false, error: 'SEND_CAP' }
// and logged; a long text split into chunks counts once. Legitimate turns never
// reach four. WAPAY_SEND_CAP changes the count (never below three).
export const SEND_CAP_WINDOW_MS = 20 * 1000;
const recentSends = new Map(); // to -> number[] (send times inside the window)

export function sendCap(env = process.env) {
  const n = Number(env.WAPAY_SEND_CAP);
  return Number.isFinite(n) && n >= 3 ? Math.floor(n) : 8;
}

/** Test seam. */
export function resetSendCap() {
  recentSends.clear();
}

function overSendCap(to, now = Date.now()) {
  const key = String(to || '');
  const list = (recentSends.get(key) || []).filter((t) => now - t < SEND_CAP_WINDOW_MS);
  if (list.length >= sendCap()) {
    recentSends.set(key, list);
    return true;
  }
  list.push(now);
  recentSends.set(key, list);
  if (recentSends.size > 5000) recentSends.clear(); // a bounded map on a long-lived process
  return false;
}

/** Test seam: inject a fake transport and/or prisma. Clears the account cache. */
export function configureSay({ transport, prisma } = {}) {
  if (transport !== undefined) transportOverride = transport;
  if (prisma !== undefined) prismaOverride = prisma;
  accountCache.clear();
  recentSends.clear();
}

async function getTransport() {
  if (transportOverride) return transportOverride;
  const mod = await import('@wapay/whatsapp');
  return mod.sendWhatsAppText;
}

async function getPrisma() {
  if (prismaOverride) return prismaOverride;
  const mod = await import('./prisma.js');
  return mod.default;
}

async function resolveAccountId(waId) {
  if (!waId) return null;
  const now = Date.now();
  const hit = accountCache.get(waId);
  if (hit && hit.expiresAt > now) return hit.id;
  try {
    const prisma = await getPrisma();
    const account = await prisma.account.findUnique({ where: { waId }, select: { id: true } });
    if (!account?.id) return null; // not cached: the account may be created moments later
    accountCache.set(waId, { id: account.id, expiresAt: now + ACCOUNT_TTL_MS });
    return account.id;
  } catch (error) {
    console.error(JSON.stringify({ type: 'say_account_lookup_error', error: error?.message }));
    return null;
  }
}

/** Split at the last paragraph break, else line break, else space, else hard. */
export function splitForSend(text, max = MAX_SEND_CHARS) {
  const s = String(text ?? '');
  if (s.length <= max) return [s];
  const chunks = [];
  let rest = s;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut <= 0) cut = window.lastIndexOf('\n');
    if (cut <= 0) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks.filter((c) => c.length > 0);
}

/**
 * Send a text and record the assistant turn on success.
 * @returns {Promise<{ ok: boolean, data?: any, error?: string }>}
 */
export async function sendWhatsAppText(args = {}) {
  try {
    const { to, category, kind, lang, refs, inPinState, secret, now } = args;
    let { text, recordAs } = args;
    const lead = leadScope.getStore();
    const withLead = !!(lead && !lead.used && lead.line && String(to || '') === lead.to);
    if (withLead) {
      text = `${lead.line}\n\n${text}`;
      if (recordAs) recordAs = `${lead.line}\n\n${recordAs}`;
    }
    if (overSendCap(to, typeof now === 'function' ? now() : Date.now())) {
      console.error(JSON.stringify({ type: 'say_send_cap', to: `…${String(to).slice(-4)}`, kind: kind || 'flow' }));
      return { ok: false, error: 'SEND_CAP' };
    }
    const transport = await getTransport();
    const chunks = splitForSend(text);

    let result = { ok: false, error: 'empty message' };
    for (const chunk of chunks) {
      const sendArgs = { to, text: chunk };
      if (category) sendArgs.category = category;
      result = await transport(sendArgs);
      if (!result?.ok) return result;
    }
    // The lead line went out with this text; a failed send leaves it for the caller to send itself.
    if (withLead) lead.used = true;

    // Memory is best-effort AFTER a successful send: a database failure
    // here must never turn a delivered message into { ok: false } for the
    // money flow that sent it. A secret send (a login code) is never stored.
    if (!secret) {
      try {
        const accountId = await resolveAccountId(to);
        if (accountId) {
          await recordTurn({
            prisma: await getPrisma(),
            accountId,
            role: 'assistant',
            // recordAs: what memory keeps instead of the sent text (a claim
            // message carries a sender-chosen name and a bearer PIN).
            text: recordAs || text,
            kind: kind || 'flow',
            lang,
            waMessageId: result?.data?.messages?.[0]?.id,
            refs,
            inPinState,
          });
        }
      } catch (memoryError) {
        console.error(JSON.stringify({ type: 'say_memory_error', error: memoryError?.message }));
      }
    }
    return result;
  } catch (error) {
    console.error(JSON.stringify({ type: 'say_send_error', error: error?.message }));
    return { ok: false, error: error?.message || 'send failed' };
  }
}

/** Record the customer's side of a turn. Never throws. */
export async function recordInbound({ accountId, waId, text, waMessageId, inPinState, secretInput, nameInput = false, lang, kind } = {}) {
  try {
    const id = accountId || (await resolveAccountId(waId));
    if (!id) return { ok: false };
    const prisma = await getPrisma();
    // A redelivered message (Meta retries after a 500) must not store the
    // customer's line twice.
    if (waMessageId && typeof prisma?.conversationTurn?.findFirst === 'function') {
      const dup = await prisma.conversationTurn.findFirst({ where: { waMessageId, role: 'user' }, select: { id: true } }).catch(() => null);
      if (dup) return { ok: true, id: dup.id, duplicate: true };
    }
    return await recordTurn({
      prisma,
      accountId: id,
      role: 'user',
      text,
      kind,
      lang,
      waMessageId,
      inPinState,
      secretInput,
      nameInput,
    });
  } catch (error) {
    console.error(JSON.stringify({ type: 'say_inbound_error', error: error?.message }));
    return { ok: false };
  }
}

/**
 * Remember an outbound message that went through another transport (an
 * interactive button message such as the deposit or payment-link card). The
 * conversation audit of 2026-10-19 (BUGLOG #120) found those sends missing
 * from memory: the transcript looked silent and the chat could not see that
 * it had just sent the link. Best-effort, never throws.
 */
export async function rememberSent({ to, text, kind = 'flow', waMessageId = null, refs } = {}) {
  try {
    const accountId = await resolveAccountId(to);
    if (!accountId || !text) return false;
    await recordTurn({ prisma: await getPrisma(), accountId, role: 'assistant', text, kind, waMessageId: waMessageId || undefined, refs });
    return true;
  } catch (error) {
    console.error(JSON.stringify({ type: 'say_memory_error', error: error?.message }));
    return false;
  }
}
