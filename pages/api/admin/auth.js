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

import { sendWhatsAppText } from '@wapay/whatsapp';
import {
  requestAdminOtp,
  verifyAdminOtp,
  adminAuthConfigured,
  adminCookie,
  clearAdminCookie,
  requireAdmin,
} from '../../../lib/admin-auth.js';

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ authed: requireAdmin(req).ok, configured: adminAuthConfigured() });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const { action, msisdn, code } = req.body || {};

  if (action === 'logout') {
    res.setHeader('Set-Cookie', clearAdminCookie());
    return res.status(200).json({ ok: true });
  }

  if (!adminAuthConfigured()) {
    return res.status(503).json({ ok: false, error: 'ADMIN_LOGIN_NOT_CONFIGURED' });
  }

  if (action === 'request') {
    const out = await requestAdminOtp({ msisdn, send: sendWhatsAppText });
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
