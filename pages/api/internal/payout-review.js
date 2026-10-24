/**
 * The founder's pay-out review (x-internal-api-key, 2026-10-24).
 *
 *   GET  /api/internal/payout-review?days=7                       → the recent requests, levels, reasons, results
 *   GET  /api/internal/payout-review?accountId=…                  → the live triage for one account (no destination)
 *   POST /api/internal/payout-review { accountId, decision: 'clear', hours?, by, reason }   → past the review for a while
 *   POST /api/internal/payout-review { accountId, decision: 'unclear', by, reason }         → the clearance ends
 *
 * A clearance only lets a request past the review level (lib/payout-triage.js); the freeze, the global
 * hold, the daily cap and the ID check still apply. Freezing stays on /api/internal/payout-freeze.
 */
import prisma from '../../../lib/prisma.js';
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import { payoutTriage, setPayoutClearance } from '../../../lib/payout-triage.js';
import { payoutRequestsView } from '../../../lib/payout-requests-view.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET' && req.method !== 'POST') { res.setHeader('Allow', ['GET', 'POST']); return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' }); }
  if (!requireInternalAuth(req, res)) return;
  try {
    if (req.method === 'GET') {
      const accountId = String(req.query?.accountId || '').trim();
      if (accountId) {
        const account = await prisma.account.findUnique({ where: { id: accountId }, select: { id: true, waId: true, createdAt: true, profile: true } });
        if (!account) return res.status(404).json({ ok: false, error: 'NO_ACCOUNT' });
        const t = await payoutTriage({ prisma, account, amountCents: Number(req.query?.amountCents) || 0 });
        return res.status(200).json({ ok: true, accountId, level: t.level, score: t.score, reasons: t.reasons, facts: t.facts, cleared: t.cleared });
      }
      return res.status(200).json({ ok: true, ...(await payoutRequestsView({ prisma, days: req.query?.days })) });
    }
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const by = String(b.by || '').trim();
    const reason = String(b.reason || '').trim();
    if (!by || !reason) return res.status(400).json({ ok: false, error: 'NEED_REASON' });
    if (b.decision !== 'clear' && b.decision !== 'unclear') return res.status(400).json({ ok: false, error: 'BAD_DECISION' });
    const out = await setPayoutClearance({ prisma, accountId: b.accountId, hours: b.decision === 'clear' ? Number(b.hours) || 72 : 0, by, reason });
    console.log(JSON.stringify({ type: 'payout_review', decision: b.decision, accountId: String(b.accountId || '').slice(0, 40), by: by.slice(0, 40), ok: out.ok }));
    return res.status(out.ok ? 200 : 400).json(out);
  } catch (error) {
    console.error(JSON.stringify({ type: 'payout_review_error', error: error?.message }));
    return res.status(500).json({ ok: false, error: 'REVIEW_FAILED' });
  }
}
