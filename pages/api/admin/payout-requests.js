/**
 * GET  /api/admin/payout-requests?days=7                          (admin session)
 * POST /api/admin/payout-requests { accountId, decision: 'clear' | 'freeze' }
 *
 * Mission Control's pay-out requests card (founder 2026-10-24): every request with its fraud level 1 to 5,
 * the reasons and the result, and whether pay-outs are paused. Masked phones only. From the card the
 * founder clears an account past the review for 72 hours, or freezes its pay-outs and sends (the same
 * freeze as /api/internal/payout-freeze). JSON only; the admin cookie is SameSite=Strict.
 */
import prisma from '../../../lib/prisma.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { payoutRequestsView } from '../../../lib/payout-requests-view.js';
import { setPayoutClearance } from '../../../lib/payout-triage.js';
import { setPayoutFreeze } from '../../../lib/payout-freeze.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const auth = requireAdmin(req);
  if (!auth.ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  if (req.method === 'POST') {
    if (!/application\/json/i.test(String(req.headers?.['content-type'] || ''))) return res.status(415).json({ ok: false, error: 'JSON_ONLY' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const by = auth.msisdn ? `admin •••${String(auth.msisdn).slice(-4)}` : 'mission-control';
    try {
      if (b.decision === 'clear') {
        const out = await setPayoutClearance({ prisma, accountId: b.accountId, hours: 72, by, reason: 'cleared from Mission Control (pay-out review)' });
        console.log(JSON.stringify({ type: 'admin_payout_review', decision: 'clear', ok: out.ok }));
        return res.status(out.ok ? 200 : 400).json(out);
      }
      if (b.decision === 'freeze') {
        const out = await setPayoutFreeze({ prisma, accountId: b.accountId, frozen: true, reason: 'frozen from Mission Control (pay-out review)', by });
        console.log(JSON.stringify({ type: 'admin_payout_review', decision: 'freeze', ok: out.ok }));
        return res.status(out.ok ? 200 : 400).json({ ok: out.ok, error: out.error || null });
      }
      return res.status(400).json({ ok: false, error: 'BAD_DECISION' });
    } catch (error) {
      console.error(JSON.stringify({ type: 'admin_payout_review_error', error: error?.message }));
      return res.status(500).json({ ok: false, error: 'REVIEW_FAILED' });
    }
  }
  try {
    return res.status(200).json({ ok: true, ...(await payoutRequestsView({ prisma, days: req.query?.days })) });
  } catch (error) {
    console.error(JSON.stringify({ type: 'admin_payout_requests_error', error: error?.message }));
    return res.status(500).json({ ok: false, error: 'READ_FAILED' });
  }
}
