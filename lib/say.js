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

import { recordTurn } from './turns.js';

const ACCOUNT_TTL_MS = 10 * 60 * 1000;
// WhatsApp text body limit is 4,096; split a little under it.
const MAX_SEND_CHARS = 4000;

let transportOverride = null;
let prismaOverride = null;
const accountCache = new Map(); // waId -> { id, expiresAt }

/** Test seam: inject a fake transport and/or prisma. Clears the account cache. */
export function configureSay({ transport, prisma } = {}) {
  if (transport !== undefined) transportOverride = transport;
  if (prisma !== undefined) prismaOverride = prisma;
  accountCache.clear();
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
    const { to, text, category, kind, lang, refs, inPinState, secret, recordAs } = args;
    const transport = await getTransport();
    const chunks = splitForSend(text);

    let result = { ok: false, error: 'empty message' };
    for (const chunk of chunks) {
      const sendArgs = { to, text: chunk };
      if (category) sendArgs.category = category;
      result = await transport(sendArgs);
      if (!result?.ok) return result;
    }

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
export async function recordInbound({ accountId, waId, text, waMessageId, inPinState, secretInput, lang, kind } = {}) {
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
    });
  } catch (error) {
    console.error(JSON.stringify({ type: 'say_inbound_error', error: error?.message }));
    return { ok: false };
  }
}
