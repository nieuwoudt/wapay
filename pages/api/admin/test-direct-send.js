/**
 * Founder test hook for Meta Direct Send (beta) — fire ONE utility-category
 * message and return Meta's raw verdict, so eligibility can be tested in
 * seconds instead of engineering a payment scenario.
 *
 * Locked down three ways:
 *  - requireAdmin: session cookie or internal key, like every admin route;
 *  - recipients restricted to the WAPAY_ADMIN_MSISDNS allowlist — an
 *    authenticated console can still never use this as a bulk/spam rail;
 *  - refuses outright when WHATSAPP_DIRECT_SEND is not enabled, with the
 *    activation steps in the error.
 *
 * POST { to, text? }  →  { ok, messageId?, error? }
 */

import { requireAdmin, isAdminMsisdn, normSa } from '../../../lib/admin-auth.js';
import { sendWhatsAppUtilityDirect, directSendEnabled } from '@wapay/whatsapp';

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });

  if (!directSendEnabled()) {
    return res.status(409).json({
      error: 'DIRECT_SEND_DISABLED',
      how: 'Accept the Direct Send beta terms in WhatsApp Manager, set WHATSAPP_DIRECT_SEND=true in Vercel, and REDEPLOY (env changes do nothing until a redeploy).',
    });
  }

  const to = normSa(req.body?.to);
  if (!to || !isAdminMsisdn(to)) {
    // Test messages go to admins only — this endpoint must never be usable
    // to message customers.
    return res.status(400).json({ error: 'RECIPIENT_NOT_ALLOWLISTED' });
  }

  const text = String(req.body?.text || '').slice(0, 500) ||
    'WaPay Direct Send test: this utility message was sent with NO template. If you are reading it, Direct Send works.';

  const result = await sendWhatsAppUtilityDirect({ to, text: `🔧 ${text}` });
  console.log(JSON.stringify({ type: 'admin_direct_send_test', to: `…${to.slice(-4)}`, ok: result?.ok, error: result?.error || null }));
  return res.status(result?.ok ? 200 : 502).json(result);
}
