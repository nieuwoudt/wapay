/**
 * GET /api/admin/payout-requests?days=7   (admin session)
 *
 * Mission Control's pay-out requests card (founder 2026-10-24): every request with its fraud level 1 to 5,
 * the reasons and the result, and whether pay-outs are paused. Masked phones only.
 */
import prisma from '../../../lib/prisma.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { payoutRequestsView } from '../../../lib/payout-requests-view.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  try {
    return res.status(200).json({ ok: true, ...(await payoutRequestsView({ prisma, days: req.query?.days })) });
  } catch (error) {
    console.error(JSON.stringify({ type: 'admin_payout_requests_error', error: error?.message }));
    return res.status(500).json({ ok: false, error: 'READ_FAILED' });
  }
}
