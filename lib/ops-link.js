/**
 * Tap-to-pay links for the operator pay-out (2026-10-21): the founder was on
 * an iPad, away from the machine that holds the internal key, while a customer
 * waited for her own money during the WhatsApp restriction. A link carries a
 * signed, expiring description of ONE pay-out (account, saved destination,
 * amount, fixed intent, who, why); the page it opens shows the dry run and
 * executes on a tap. The signature key derives from WAPAY_INTERNAL_API_KEY,
 * so only this deployment can mint or honour a link; the fixed intent makes a
 * second tap idempotent (requestPayout dedupes on it).
 */
import crypto from 'node:crypto';

export const OPS_LINK_TTL_MS = 45 * 60 * 1000;

function key(env = process.env) {
  const secret = env.WAPAY_OPS_LINK_SECRET || env.WAPAY_INTERNAL_API_KEY || '';
  return secret ? crypto.createHash('sha256').update(`wapay-ops-link:v1:${secret}`).digest() : null;
}
const b64 = (b) => Buffer.from(b).toString('base64url');
const sign = (payload, k) => b64(crypto.createHmac('sha256', k).update(payload).digest());

export function mintOpsPayoutLink({ accountId, destinationId, amountCents, by, reason, intentId, now = Date.now(), ttlMs = OPS_LINK_TTL_MS, env = process.env } = {}) {
  const k = key(env);
  if (!k || !accountId || !destinationId || !Number.isInteger(amountCents) || amountCents <= 0 || !by || !reason) return null;
  const id = intentId && /^[A-Za-z0-9-]{8,64}$/.test(String(intentId)) ? String(intentId) : `ops-${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const body = JSON.stringify({ a: String(accountId), d: String(destinationId), c: amountCents, i: id, b: String(by).slice(0, 60), r: String(reason).slice(0, 200), e: now + ttlMs });
  const payload = b64(body);
  return `${payload}.${sign(payload, k)}`;
}

/** Never throws. */
export function verifyOpsPayoutLink(token, { now = Date.now(), env = process.env } = {}) {
  const k = key(env);
  if (!k) return { ok: false, reason: 'NO_SECRET' };
  if (typeof token !== 'string' || !token.includes('.') || token.length > 2000) return { ok: false, reason: 'MISSING' };
  const [payload, sig] = token.split('.');
  const expect = sign(payload, k);
  const a = Buffer.from(expect, 'utf8');
  const b = Buffer.from(String(sig || ''), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'BAD_SIGNATURE' };
  let body;
  try { body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'MALFORMED' }; }
  if (!body || typeof body !== 'object' || !body.a || !body.d || !Number.isInteger(body.c) || body.c <= 0 || !body.i) return { ok: false, reason: 'MALFORMED' };
  if (typeof body.e !== 'number' || now > body.e) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, data: { accountId: body.a, destinationId: body.d, amountCents: body.c, intentId: body.i, by: body.b || 'ops', reason: body.r || '', expiresAt: body.e } };
}
