/**
 * A person from the WaPay team answers a customer inside their WhatsApp chat
 * (founder 2026-10-19, the Cytric case: "help the bot respond to him in chat").
 * Text only, one message, inside the customer's 24-hour window (the route's
 * ?force=1 overrides that for a number known to be reachable), sent through
 * lib/say.js so the assistant turn is recorded and the chat remembers what the
 * person said. Never money, never a template, never a full number in the logs.
 */
export const OPS_REPLY_MAX_CHARS = 1500;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function opsReply({ prisma, send, accountId, text, force = false, now = Date.now() }) {
  const id = String(accountId || '').trim();
  const body = String(text || '').trim();
  if (!/^[a-z0-9]{20,40}$/i.test(id)) return { status: 400, body: { ok: false, error: 'BAD_ACCOUNT' } };
  if (!body || body.length > OPS_REPLY_MAX_CHARS) return { status: 400, body: { ok: false, error: 'BAD_TEXT' } };
  const account = await prisma.account.findUnique({ where: { id }, select: { id: true, waId: true, profile: true } });
  if (!account?.waId) return { status: 404, body: { ok: false, error: 'NO_ACCOUNT' } };
  const last = await prisma.conversationTurn.findFirst({ where: { accountId: id, role: 'user' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  const lastAt = last ? new Date(last.createdAt).getTime() : null;
  const windowOpen = lastAt != null && now - lastAt < WINDOW_MS;
  if (!windowOpen && !force) return { status: 409, body: { ok: false, error: 'WINDOW_CLOSED', lastInboundAt: last?.createdAt || null } };
  // A customer who said stop is not written to unless they wrote again after saying it (Messaging Policy, 2026-10-20).
  const optOutAt = account.profile && account.profile.messaging && account.profile.messaging.optOut ? Date.parse(account.profile.messaging.optOutAt || 0) || 0 : null;
  if (optOutAt != null && !(lastAt && lastAt > optOutAt)) return { status: 409, body: { ok: false, error: 'OPTED_OUT', optOutAt: account.profile.messaging.optOutAt || null } };
  const r = await send({ to: account.waId, text: body, kind: 'ops' });
  console.log(JSON.stringify({ type: 'ops_reply', accountId: id, to: `…${String(account.waId).slice(-4)}`, ok: !!r?.ok, error: r?.error || null, chars: body.length, windowOpen }));
  return { status: r?.ok ? 200 : 502, body: { ok: !!r?.ok, error: r?.error || null, messageId: r?.data?.messages?.[0]?.id || null } };
}
