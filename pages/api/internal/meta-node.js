/**
 * GET /api/internal/meta-node?id=<digits>&fields=name,account_review_status   (internal key)
 *
 * Reads one Graph node with the WhatsApp token. Built on 2026-10-20 to tell a
 * WhatsApp Business Account id from a business portfolio id when Meta's e-mails
 * cite one. Digits-only ids, a field whitelist, nothing stored, the token never
 * leaves the server.
 */
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import { qualityEnv } from '../../../lib/whatsapp-quality.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
export const FIELDS_OK = new Set(['id', 'name', 'account_review_status', 'business_verification_status', 'owner_business_info', 'timezone_id', 'message_template_namespace', 'currency', 'verified_name', 'display_phone_number', 'quality_rating', 'messaging_limit_tier', 'status', 'name_status', 'primary_page', 'vertical', 'link']);

export function pickFields(raw) {
  return String(raw || 'id,name').split(',').map((f) => f.trim()).filter((f) => FIELDS_OK.has(f));
}

export default async function handler(req, res) {
  if (!requireInternalAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'METHOD' });
  const id = String(req.query.id || '');
  if (!/^\d{5,32}$/.test(id)) return res.status(400).json({ ok: false, error: 'BAD_ID' });
  const fields = pickFields(req.query.fields);
  if (!fields.length) return res.status(400).json({ ok: false, error: 'BAD_FIELDS' });
  const { token } = qualityEnv(process.env);
  if (!token) return res.status(503).json({ ok: false, error: 'NOT_CONFIGURED' });
  try {
    const r = await fetch(`${GRAPH}/${id}?fields=${fields.join(',')}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    if (!r.ok || j.error) return res.status(502).json({ ok: false, error: String(j?.error?.message || `HTTP ${r.status}`).split(token).join('[token]'), code: j?.error?.code || null });
    return res.status(200).json({ ok: true, node: j });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e?.name === 'TimeoutError' ? 'timeout' : e?.message).split(token).join('[token]') });
  }
}
