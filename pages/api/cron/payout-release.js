/**
 * GET /api/cron/payout-release
 *
 * Sends every SCHEDULED pay-out whose business day has come (lib/payout-approval.js releaseDuePayouts): a bank
 * pay-out the customer chose to send on the next business day (R12, founder 2026-11-07), approved or approved
 * automatically, goes from 08:00 SAST that day. Scheduled in vercel.json at 06:00 UTC (08:00 SAST) every day; a
 * row that is not due yet is left alone, so the weekend runs send nothing. The daily sweep in daily-vas-sync is
 * the floor if a run is missed. Idempotent: each row is claimed atomically before the rail call.
 *
 * Auth (any one): Authorization: Bearer CRON_SECRET (what Vercel sends), or the internal key
 * (x-internal-api-key) so an operator can run it by hand.
 */
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import { isCronAuthed } from '../../../lib/cron-auth.js';
import { releaseDuePayouts } from '../../../lib/payout-approval.js';

function isAuthed(req, res) {
  if (isCronAuthed(req)) return true;
  if (process.env.WAPAY_INTERNAL_API_KEY && typeof req.headers['x-internal-api-key'] === 'string') {
    return requireInternalAuth(req, res); // writes the 401 itself on a mismatch
  }
  res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ ok: false, error: `Method ${req.method} Not Allowed` });
  }
  if (!isAuthed(req, res)) return;
  const startedAt = Date.now();
  try {
    const out = await releaseDuePayouts({ take: Math.min(50, Number(req.query?.limit) || 50) });
    console.log(JSON.stringify({ type: 'cron_payout_release', ok: true, scheduled: out.scheduled, due: out.due, sent: out.sent, pending: out.pending, failed: out.failed, rejected: out.rejected, floatShort: out.floatShort, errors: out.errors, ms: Date.now() - startedAt, timestamp: new Date().toISOString() }));
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    console.error(JSON.stringify({ type: 'cron_payout_release', ok: false, error: e?.message || String(e), ms: Date.now() - startedAt, timestamp: new Date().toISOString() }));
    return res.status(500).json({ ok: false, error: 'RELEASE_FAILED', message: e?.message || String(e) });
  }
}
