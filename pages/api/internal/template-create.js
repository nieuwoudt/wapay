/**
 * Message templates through the Graph API (2026-10-20).
 *
 *   GET  /api/internal/template-create            list the account's templates (name, status, category)
 *   POST /api/internal/template-create            create one: { name, category, language?, components }
 *
 * Internal key. Only UTILITY and AUTHENTICATION templates can be created here:
 * nothing promotional is added while the number's quality rating is not GREEN
 * (docs/WHATSAPP_POLICY_COMPLIANCE.md). Built for the support follow-up template
 * that lets a person answer a customer after their 24-hour window has closed, and
 * for re-filing receipts (a paid link) as utility instead of marketing. Nothing is
 * stored; the token never leaves the server (redacted from any error text).
 */
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import { qualityEnv } from '../../../lib/whatsapp-quality.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
export const ALLOWED_CATEGORIES = ['UTILITY', 'AUTHENTICATION'];

/** Shape check before anything reaches Meta. Pure. */
export function validateTemplateBody(b) {
  if (!b || typeof b !== 'object') return { ok: false, error: 'BAD_BODY' };
  if (!/^[a-z0-9_]{3,512}$/.test(String(b.name || ''))) return { ok: false, error: 'BAD_NAME' };
  if (!ALLOWED_CATEGORIES.includes(String(b.category || ''))) return { ok: false, error: 'BAD_CATEGORY' };
  if (b.language != null && !/^[a-z]{2}(_[A-Z]{2})?$/.test(String(b.language))) return { ok: false, error: 'BAD_LANGUAGE' };
  if (!Array.isArray(b.components) || !b.components.length) return { ok: false, error: 'BAD_COMPONENTS' };
  const body = b.components.find((c) => c && String(c.type).toUpperCase() === 'BODY');
  if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 1024) return { ok: false, error: 'BAD_BODY_TEXT' };
  if (/—/.test(body.text)) return { ok: false, error: 'EM_DASH' };
  return { ok: true };
}

function redact(text, token) {
  const s = String(text || '');
  return token ? s.split(token).join('[token]') : s;
}

export default async function handler(req, res) {
  if (!requireInternalAuth(req, res)) return;
  const { token } = qualityEnv(process.env);
  const waba = String(process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '').trim();
  if (!token || !waba) return res.status(503).json({ ok: false, error: 'NOT_CONFIGURED' });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    if (req.method === 'GET') {
      const r = await fetch(`${GRAPH}/${waba}/message_templates?fields=name,status,category,language,quality_score,components&limit=200`, { headers, signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (!r.ok || j.error) return res.status(502).json({ ok: false, error: redact(j?.error?.message || `HTTP ${r.status}`, token) });
      return res.status(200).json({ ok: true, templates: (j.data || []).map((t) => ({ name: t.name, status: t.status, category: t.category, language: t.language, quality: t.quality_score?.score || null, components: String(req.query.components) === '1' ? t.components || null : undefined })) });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'METHOD' });
    const v = validateTemplateBody(req.body);
    if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
    const payload = { name: req.body.name, category: req.body.category, language: req.body.language || 'en', components: req.body.components };
    if (req.body.allow_category_change === true) payload.allow_category_change = true;
    const r = await fetch(`${GRAPH}/${waba}/message_templates`, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    if (!r.ok || j.error) return res.status(502).json({ ok: false, error: redact(j?.error?.error_user_msg || j?.error?.message || `HTTP ${r.status}`, token), code: j?.error?.code || null, subcode: j?.error?.error_subcode || null });
    return res.status(200).json({ ok: true, id: j.id || null, status: j.status || null, category: j.category || null });
  } catch (e) {
    return res.status(502).json({ ok: false, error: redact(e?.name === 'TimeoutError' ? 'timeout' : e?.message, token) });
  }
}
