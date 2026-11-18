/**
 * Who may read the incident list (GET/POST /api/internal/incidents, 2026-11-18).
 *
 * The incident responder is an agent that may run outside the founder's machine. It needs the open
 * findings and nothing else, so it gets its own key: WAPAY_RESPONDER_KEY opens the incident route and
 * no other route in the product. It cannot read a customer, a balance or a conversation, and it cannot
 * move money. The internal key (operators and sessions that already hold it) opens the route as well.
 *
 * Fails closed: with neither key configured nobody is let in, and a responder key shorter than 32
 * characters is treated as not configured (a short key is a typing mistake, not a key).
 */
import crypto from 'node:crypto';

export const RESPONDER_KEY_MIN = 32;

const same = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const header = (req, name) => {
  const v = req?.headers?.[name];
  return typeof v === 'string' && v ? v : null;
};

/**
 * @returns {{ ok: true, as: 'responder'|'internal' } | { ok: false, status: 401|503, error: string }}
 */
export function responderAuth(req, env = process.env) {
  const responderKey = String(env.WAPAY_RESPONDER_KEY || '').trim();
  const internalKey = String(env.WAPAY_INTERNAL_API_KEY || '').trim();
  const responderOn = responderKey.length >= RESPONDER_KEY_MIN;
  if (!responderOn && !internalKey) return { ok: false, status: 503, error: 'CONFIG' };
  const presentedResponder = header(req, 'x-responder-key');
  if (responderOn && presentedResponder && same(presentedResponder, responderKey)) return { ok: true, as: 'responder' };
  const presentedInternal = header(req, 'x-internal-api-key');
  if (internalKey && presentedInternal && same(presentedInternal, internalKey)) return { ok: true, as: 'internal' };
  return { ok: false, status: 401, error: 'AUTH' };
}
