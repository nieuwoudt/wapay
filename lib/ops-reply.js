/**
 * A person from the WaPay team answers a customer inside their WhatsApp chat
 * (founder 2026-10-19, the Cytric case: "help the bot respond to him in chat").
 * Text only, one message, inside the customer's 24-hour window (the route's
 * ?force=1 overrides that for a number known to be reachable), sent through
 * lib/say.js so the assistant turn is recorded and the chat remembers what the
 * person said. Never money, never a full number in the logs.
 *
 * After the window (founder 2026-10-20, two people stuck past 24 hours): the
 * same text goes inside the approved UTILITY template
 * `wapay_support_followup` ("WaPay support here, about your message to us.
 * {{2}} Reply to this message if you still need help."), the only way the
 * Messaging Policy allows a business to write first. The customer asked for
 * help, so a follow-up on that request is a utility message, never marketing.
 * A customer who said stop is not written to on either rail.
 */
export const OPS_REPLY_MAX_CHARS = 1500;
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Meta refuses newlines, tabs and runs of spaces inside a template parameter. */
export function templateParam(text, max = 1000) {
  return String(text || '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/** The support follow-up template's name; `WAPAY_TEMPLATE_SUPPORT_FOLLOWUP=off` disables the rail. */
export function supportTemplateName(env = process.env) {
  const v = String(env.WAPAY_TEMPLATE_SUPPORT_FOLLOWUP ?? 'wapay_support_followup').trim();
  return v && v.toLowerCase() !== 'off' ? v : '';
}

/** The first name the template greets by: letters only, short, else "there". */
export function greetingName(displayName) {
  const first = String(displayName || '').trim().split(/\s+/)[0] || '';
  return /^[A-Za-z][A-Za-z'\-]{0,19}$/.test(first) ? first : 'there';
}

async function defaultSendTemplate(args) {
  const { sendWhatsAppTemplate } = await import('@wapay/whatsapp');
  return sendWhatsAppTemplate(args);
}
async function defaultRemember(args) {
  const { rememberSent } = await import('./say.js');
  return rememberSent(args);
}

export async function opsReply({ prisma, send, sendTemplate = defaultSendTemplate, remember = defaultRemember, accountId, text, force = false, now = Date.now(), env = process.env }) {
  const id = String(accountId || '').trim();
  const body = String(text || '').trim();
  if (!/^[a-z0-9]{20,40}$/i.test(id)) return { status: 400, body: { ok: false, error: 'BAD_ACCOUNT' } };
  if (!body || body.length > OPS_REPLY_MAX_CHARS) return { status: 400, body: { ok: false, error: 'BAD_TEXT' } };
  const account = await prisma.account.findUnique({ where: { id }, select: { id: true, waId: true, profile: true, displayName: true } });
  if (!account?.waId) return { status: 404, body: { ok: false, error: 'NO_ACCOUNT' } };
  const last = await prisma.conversationTurn.findFirst({ where: { accountId: id, role: 'user' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  const lastAt = last ? new Date(last.createdAt).getTime() : null;
  const windowOpen = lastAt != null && now - lastAt < WINDOW_MS;
  // A customer who said stop is not written to on any rail unless they wrote again after saying it (Messaging Policy, 2026-10-20).
  const optOutAt = account.profile && account.profile.messaging && account.profile.messaging.optOut ? Date.parse(account.profile.messaging.optOutAt || 0) || 0 : null;
  if (optOutAt != null && !(lastAt && lastAt > optOutAt)) return { status: 409, body: { ok: false, error: 'OPTED_OUT', optOutAt: account.profile.messaging.optOutAt || null } };
  if (!windowOpen && !force) {
    const templateName = supportTemplateName(env);
    if (!templateName) return { status: 409, body: { ok: false, error: 'WINDOW_CLOSED', lastInboundAt: last?.createdAt || null } };
    const parameters = [{ type: 'text', text: greetingName(account.displayName) }, { type: 'text', text: templateParam(body) }];
    const t = await sendTemplate({ to: account.waId, templateName, language: 'en', components: [{ type: 'body', parameters }] });
    if (t?.ok) await Promise.resolve(remember({ to: account.waId, text: body, kind: 'ops', waMessageId: t?.data?.messages?.[0]?.id || null })).catch(() => {});
    console.log(JSON.stringify({ type: 'ops_reply', accountId: id, to: `…${String(account.waId).slice(-4)}`, ok: !!t?.ok, error: t?.error || null, chars: body.length, windowOpen: false, rail: 'template', template: templateName }));
    return { status: t?.ok ? 200 : 502, body: { ok: !!t?.ok, error: t?.error || null, messageId: t?.data?.messages?.[0]?.id || null, rail: 'template', template: templateName, lastInboundAt: last?.createdAt || null } };
  }
  const r = await send({ to: account.waId, text: body, kind: 'ops' });
  console.log(JSON.stringify({ type: 'ops_reply', accountId: id, to: `…${String(account.waId).slice(-4)}`, ok: !!r?.ok, error: r?.error || null, chars: body.length, windowOpen }));
  return { status: r?.ok ? 200 : 502, body: { ok: !!r?.ok, error: r?.error || null, messageId: r?.data?.messages?.[0]?.id || null } };
}
