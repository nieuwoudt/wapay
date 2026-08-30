/**
 * Admin console login — request / verify / logout.
 *
 * POST {action:'request', msisdn}        → always {ok:true} (no allowlist oracle)
 * POST {action:'verify', msisdn, code}   → Set-Cookie session on success
 * POST {action:'logout'}                 → clears the cookie
 * GET                                    → {authed, configured} status probe
 *
 * Fails closed when WAPAY_ADMIN_MSISDNS / WAPAY_ADMIN_SESSION_SECRET are
 * unset — the login form tells the operator to configure them.
 */

import { sendWhatsAppText, sendWhatsAppTemplate } from '@wapay/whatsapp';
import {
  requestAdminOtp,
  verifyAdminOtp,
  verifyAdminPassword,
  adminPasswordConfigured,
  adminPasswordHashShape,
  adminAuthConfigured,
  adminCookie,
  clearAdminCookie,
  requireAdmin,
} from '../../../lib/admin-auth.js';

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // The hash SHAPE (never the hash) is included only for an internal-key
    // caller, so a mangled paste is diagnosable instead of guessed at.
    const internalKey = process.env.WAPAY_INTERNAL_API_KEY || '';
    const isInternal = internalKey && req.headers['x-internal-api-key'] === internalKey;
    return res.status(200).json({
      authed: requireAdmin(req).ok,
      configured: adminAuthConfigured(),
      passwordLogin: adminPasswordConfigured(),
      ...(isInternal ? { passwordHash: adminPasswordHashShape(), build: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null } : {}),
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const { action, msisdn, code, password } = req.body || {};

  if (action === 'logout') {
    res.setHeader('Set-Cookie', clearAdminCookie());
    return res.status(200).json({ ok: true });
  }

  if (!adminAuthConfigured()) {
    return res.status(503).json({ ok: false, error: 'ADMIN_LOGIN_NOT_CONFIGURED' });
  }

  if (action === 'password') {
    const out = await verifyAdminPassword({ msisdn, password });
    if (!out.ok) {
      // One shape for wrong-number and wrong-password: never an oracle.
      // HASH_MALFORMED is an operator error (the env holds something that is
      // not an argon2 hash), so it is reported as a server misconfiguration
      // rather than hidden behind the credentials answer.
      if (out.error === 'HASH_MALFORMED') {
        return res.status(503).json({ ok: false, error: 'HASH_MALFORMED' });
      }
      const status = out.error === 'LOCKED_OUT' ? 429 : out.error === 'NOT_CONFIGURED' ? 503 : 401;
      return res.status(status).json({ ok: false, error: out.error === 'LOCKED_OUT' ? 'LOCKED_OUT' : 'BAD_CREDENTIALS' });
    }
    res.setHeader('Set-Cookie', adminCookie(out.token));
    return res.status(200).json({ ok: true });
  }

  if (action === 'request') {
    const out = await requestAdminOtp({
      msisdn,
      sendTemplate: sendWhatsAppTemplate, // authentication template: crosses the 24h window
      send: sendWhatsAppText, // fallback when the window happens to be open
    });
    // Public callers get a bare {ok:true} — never an allowlist oracle. An
    // internal-key caller additionally gets the delivery diagnosis (never the
    // code) so "no code arrived" can be diagnosed instead of guessed.
    const internalKey = process.env.WAPAY_INTERNAL_API_KEY || '';
    const isInternal = internalKey && req.headers['x-internal-api-key'] === internalKey;
    if (!isInternal) return res.status(200).json({ ok: true });

    // When every template candidate failed, ask Meta what the SENDING WABA
    // actually has approved — the local catalogue can be stale or hold
    // approvals from a different business account (which is exactly how the
    // #132001 blocker arose). Template names/languages are not secrets.
    if (out?.diag && out.diag.templateOk === false) {
      try {
        const waba = process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID;
        const token = process.env.META_WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
        if (waba && token) {
          const r = await fetch(
            `https://graph.facebook.com/v21.0/${waba}/message_templates?fields=name,language,status,category&limit=200`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const j = await r.json();
          out.diag.wabaId = waba;
          out.diag.metaTemplates = Array.isArray(j?.data)
            ? j.data
                .filter((t) => t.status === 'APPROVED')
                .map((t) => `${t.name}:${t.language}:${t.category}`)
            : { error: j?.error?.message || 'unreadable' };
        }
      } catch (e) {
        out.diag.metaTemplates = { error: e?.message || 'fetch failed' };
      }
    }
    return res.status(200).json(out);
  }

  if (action === 'verify') {
    const out = await verifyAdminOtp({ msisdn, code });
    if (!out.ok) return res.status(401).json({ ok: false });
    res.setHeader('Set-Cookie', adminCookie(out.token));
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'action' });
}
