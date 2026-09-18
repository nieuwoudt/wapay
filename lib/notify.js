/**
 * notifyCustomer — C21 of docs/AGENT_ARCHITECTURE_V2.md.
 *
 * The one way WaPay starts a conversation the customer did not just ask for:
 * a pay-out that settles overnight, a deposit that lands hours later, a gift
 * that finally cleared. Everything else is a reply inside a turn.
 *
 * Why it exists: Meta ACCEPTS a free-form send outside the customer's 24 hour
 * window and drops it silently afterwards (BUGLOG #33), so `{ ok: true }` from
 * the text rail proves nothing once the window has closed. Before this helper
 * the pay-out sweep sent plain text, which meant a customer whose withdrawal
 * settled the next morning was never told.
 *
 * The rails, in order, and only when the window is closed:
 *   1. Direct Send (a UTILITY-categorised text, no template) when enabled.
 *   2. An approved UTILITY template, when one is configured for this kind.
 *   3. Free-form text, as a last resort, so an open window still gets through.
 * Inside the window it is simply a text, which is cheaper and reads better.
 *
 * Whatever goes out is recorded as an assistant turn by lib/say.js, so the
 * agent's next turn can see what WaPay told this customer while they were away.
 *
 * Never throws: a notification that cannot be delivered must never fail the
 * money flow that produced it. The caller gets { ok, rail, error }.
 */
import prisma from './prisma.js';

/** The window Meta allows a free-form business reply in, from the last inbound. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

const log = (type, data) => console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));

/**
 * Is this customer inside their 24 hour window? Answered from the turns table,
 * which records every inbound message (lib/say.js recordInbound).
 *
 * Fails OPEN (true) when the answer cannot be read: an unnecessary template is
 * a small cost, a dropped pay-out notice is a customer who is not told.
 * @returns {Promise<boolean>}
 */
export async function windowIsOpen({ prisma: db = prisma, accountId, now = Date.now() } = {}) {
  if (!accountId) return false;
  try {
    if (typeof db?.conversationTurn?.findFirst !== 'function') return true;
    const last = await db.conversationTurn.findFirst({
      where: { accountId, role: 'user' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (!last?.createdAt) return false;
    return now - new Date(last.createdAt).getTime() < WINDOW_MS;
  } catch (error) {
    log('notify_window_check_failed', { accountId, error: error?.message });
    return true;
  }
}

/**
 * Deliver a message the customer did not ask for.
 *
 * @param {object} args
 * @param {string} args.to           the customer's WhatsApp id
 * @param {string} args.accountId    used for the window check and the memory row
 * @param {string} args.text         what to say, already localized and gated
 * @param {string} [args.kind]       the memory kind ('receipt', 'event', 'flow')
 * @param {string} [args.templateEnv] env var holding an approved template name
 * @param {Array}  [args.templateParams] body parameters, in order, for that template
 * @param {object} [args.deps]       injection point for tests
 * @returns {Promise<{ ok: boolean, rail: string|null, error?: string, waMessageId?: string|null }>}
 */
export async function notifyCustomer({
  to,
  accountId = null,
  text,
  kind = 'event',
  templateEnv = null,
  templateParams = [],
  deps = {},
} = {}) {
  if (!to || !text) return { ok: false, rail: null, error: 'MISSING_ARGS' };
  const db = deps.prisma || prisma;
  const load = async () => {
    const say = deps.say || (await import('./say.js'));
    const wa = deps.wa || (await import('@wapay/whatsapp'));
    return { say, wa };
  };

  let say;
  let wa;
  try {
    ({ say, wa } = await load());
  } catch (error) {
    log('notify_transport_unavailable', { to, error: error?.message });
    return { ok: false, rail: null, error: 'TRANSPORT_UNAVAILABLE' };
  }

  const open = await windowIsOpen({ prisma: db, accountId, now: deps.now || Date.now() });

  // Inside the window a plain text is correct: cheaper, better copy, and it
  // lands in the same thread the customer is already reading.
  if (open) {
    const r = await say.sendWhatsAppText({ to, text, kind }).catch((e) => ({ ok: false, error: e?.message }));
    log('notify_sent', { to, accountId, rail: 'text', open: true, ok: !!r?.ok });
    return { ok: !!r?.ok, rail: 'text', error: r?.ok ? undefined : r?.error, waMessageId: r?.data?.messages?.[0]?.id || null };
  }

  // Outside it, the rails that actually cross, in order.
  if (typeof wa.sendWhatsAppUtilityDirect === 'function' && wa.directSendEnabled?.()) {
    const r = await wa.sendWhatsAppUtilityDirect({ to, text }).catch((e) => ({ ok: false, error: e?.message }));
    if (r?.ok) {
      await recordOutbound({ say, to, text, kind });
      log('notify_sent', { to, accountId, rail: 'direct', open: false, ok: true });
      return { ok: true, rail: 'direct', waMessageId: r?.data?.messages?.[0]?.id || r?.messageId || null };
    }
  }

  const templateName = templateEnv ? process.env[templateEnv] : null;
  if (templateName && typeof wa.sendWhatsAppTemplate === 'function') {
    const r = await wa
      .sendWhatsAppTemplate({
        to,
        templateName,
        language: 'en',
        components: templateParams.length
          ? [{ type: 'body', parameters: templateParams.map((p) => ({ type: 'text', text: String(p) })) }]
          : [],
      })
      .catch((e) => ({ ok: false, error: e?.message }));
    if (r?.ok) {
      await recordOutbound({ say, to, text, kind });
      log('notify_sent', { to, accountId, rail: 'template', template: templateName, open: false, ok: true });
      return { ok: true, rail: 'template', waMessageId: r?.data?.messages?.[0]?.id || r?.messageId || null };
    }
    log('notify_template_failed', { to, template: templateName, error: r?.error });
  }

  // Last resort: Meta may still accept it, and an open window we failed to
  // detect is the common case.
  const r = await say.sendWhatsAppText({ to, text, kind }).catch((e) => ({ ok: false, error: e?.message }));
  log('notify_sent', { to, accountId, rail: 'text_fallback', open: false, ok: !!r?.ok });
  return { ok: !!r?.ok, rail: 'text_fallback', error: r?.ok ? undefined : r?.error, waMessageId: r?.data?.messages?.[0]?.id || null };
}

/**
 * A direct or template send bypasses lib/say.js, so the assistant turn is
 * recorded here instead. Best effort: memory must never fail a delivery.
 */
async function recordOutbound({ say, to, text, kind }) {
  try {
    if (typeof say.recordOutboundTurn === 'function') return await say.recordOutboundTurn({ to, text, kind });
    const turns = await import('./turns.js');
    const db = (await import('./prisma.js')).default;
    const account = await db.account.findUnique({ where: { waId: to }, select: { id: true } });
    if (account?.id) await turns.recordTurn({ prisma: db, accountId: account.id, role: 'assistant', text, kind: kind || 'event' });
  } catch (error) {
    log('notify_memory_failed', { to, error: error?.message });
  }
}
