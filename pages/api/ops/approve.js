/**
 * GET  /api/ops/approve?token=…              → the waiting pay-out the founder's link names (nothing moves)
 * POST /api/ops/approve { token, decision }   → approve (send it) or reject (money back to the customer)
 *
 * The token is the credential (lib/payout-approval.js: signed, three days, one pay-out); a decided pay-out answers
 * NOT_WAITING, so a second tap does nothing.
 */
import prisma from '../../../lib/prisma.js';
import { verifyApprovalToken, approvalView, approvePayout, rejectPayout } from '../../../lib/payout-approval.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const token = req.method === 'GET' ? req.query?.token : req.body?.token;
  const v = verifyApprovalToken(token);
  if (!v.ok) return res.status(401).json({ ok: false, error: 'LINK', reason: v.reason });
  try {
    if (req.method === 'GET') {
      const rows = await prisma.providerRequest.findMany({ where: { route: 'ott-payout', metadata: { path: ['reference'], equals: v.reference } }, take: 1 });
      if (!rows[0]) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
      return res.status(200).json({ ok: true, payout: await approvalView({ prisma, row: rows[0] }), expiresAt: v.expiresAt });
    }
    const decision = req.body?.decision;
    if (decision === 'approve') { const out = await approvePayout({ prisma, reference: v.reference, by: 'founder (approval link)' }); return res.status(out.ok ? 200 : 409).json(out); }
    if (decision === 'reject') { const out = await rejectPayout({ prisma, reference: v.reference, by: 'founder (approval link)', reason: 'not approved' }); return res.status(out.ok ? 200 : 409).json(out); }
    return res.status(400).json({ ok: false, error: 'BAD_DECISION' });
  } catch (error) {
    console.error(JSON.stringify({ type: 'ops_approve_error', error: error?.message }));
    return res.status(500).json({ ok: false, error: 'APPROVAL_FAILED' });
  }
}
