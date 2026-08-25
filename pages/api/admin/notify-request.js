/**
 * POST /api/admin/notify-request { code: "PRXXXXXX" }
 *
 * Repair endpoint: re-runs the durable PAID notifications for a request.
 * Safe to call repeatedly — the metadata flags make delivery exactly-once.
 * Exists because a lost ITN invocation used to lose both notifications
 * permanently (founder live test PRMDCUQA, 2026-08-25).
 *
 * Guarded by the internal API key (x-internal-api-key).
 */

import { requireInternalAuth } from '../../../lib/internal-auth.js';
import { deliverRequestPaidNotifications } from '../../../lib/request-notify.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }
  if (!requireInternalAuth(req, res)) return;

  const code = String(req.body?.code || '').toUpperCase();
  if (!/^PR[A-Z]{6}$/.test(code)) {
    return res.status(400).json({ ok: false, error: 'BAD_CODE' });
  }
  const outcome = await deliverRequestPaidNotifications({ code });
  return res.status(200).json({ ok: true, code, ...outcome });
}
