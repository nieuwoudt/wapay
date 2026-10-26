/**
 * GET  /api/admin/payout-approvals                                  (admin session) → the pay-out mode and every
 *                                                                     pay-out waiting for the founder
 * POST /api/admin/payout-approvals { reference, decision: 'approve' | 'reject', reason? }
 *
 * Founder 2026-10-26: every pay-out is approved by hand (lib/payout-approval.js). JSON only; the admin cookie is
 * SameSite=Strict.
 */
import prisma from '../../../lib/prisma.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { listAwaitingApproval, approvePayout, rejectPayout } from '../../../lib/payout-approval.js';
import { readPayoutMode } from '../../../lib/payout-hold.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const auth = requireAdmin(req);
  if (!auth.ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  try {
    if (req.method === 'GET') {
      const [mode, waiting] = await Promise.all([readPayoutMode({ prisma }), listAwaitingApproval({ prisma })]);
      return res.status(200).json({ ok: true, mode, waiting });
    }
    if (!/application\/json/i.test(String(req.headers?.['content-type'] || ''))) return res.status(415).json({ ok: false, error: 'JSON_ONLY' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const by = auth.msisdn ? `admin •••${String(auth.msisdn).slice(-4)}` : 'mission-control';
    if (b.decision === 'approve') {
      const out = await approvePayout({ prisma, reference: b.reference, by });
      return res.status(out.ok ? 200 : 409).json(out);
    }
    if (b.decision === 'reject') {
      const out = await rejectPayout({ prisma, reference: b.reference, by, reason: String(b.reason || 'not approved').slice(0, 200) });
      return res.status(out.ok ? 200 : 409).json(out);
    }
    return res.status(400).json({ ok: false, error: 'BAD_DECISION' });
  } catch (error) {
    console.error(JSON.stringify({ type: 'admin_payout_approval_error', error: error?.message }));
    return res.status(500).json({ ok: false, error: 'APPROVAL_FAILED' });
  }
}
