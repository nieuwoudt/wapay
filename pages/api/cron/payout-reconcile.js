/**
 * GET /api/cron/payout-reconcile
 *
 * The scheduled pay-out sweep: every pay-out still PENDING (the webhook never
 * came) or still INIT (a crash between the ledger and OTT) past its grace
 * period is reconciled by asking OTT GetPaymentStatus and applying the
 * answer, never by a second PerformPayout (lib/payouts.js
 * sweepPayoutsAndNotify). A customer whose pay-out finalised is told in the
 * webhook's words. Idempotent: a finalised row is a no-op next time.
 *
 * Auth (any one):
 * - Vercel Cron header: x-vercel-cron=1
 * - query token: ?key=${CRON_SECRET}
 * - the internal key (x-internal-api-key, lib/internal-auth.js), so the same
 *   sweep can be run by hand from an operator script
 *
 * Never throws: every failure is a structured 'cron_payout_reconcile' line
 * and a JSON body, so a scheduler sees counts or an error, never a stack.
 * Note: this route is NOT in vercel.json crons yet (Hobby = one daily cron;
 * daily-vas-sync also runs the sweep as the daily floor).
 */

import { requireInternalAuth } from '../../../lib/internal-auth.js';
import { sweepPayoutsAndNotify } from '../../../lib/payouts.js';

function isCronAuthed(req) {
  if (req.headers['x-vercel-cron'] === '1') return true;
  const key = req.query?.key;
  return !!(process.env.CRON_SECRET && key === process.env.CRON_SECRET);
}

/** Cron auth first; the internal key is an accepted alternative only when it is configured AND presented. */
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
  const olderThanMs = Math.max(0, Number(req.query?.olderThanMinutes ?? 2)) * 60 * 1000;
  // Floor of five minutes: an INIT row may still be inside PerformPayout.
  const initOlderThanMs = Math.max(5, Number(req.query?.initOlderThanMinutes ?? 10)) * 60 * 1000;
  const limit = Number(req.query?.limit) || 20;
  try {
    const sweep = await sweepPayoutsAndNotify({ olderThanMs, initOlderThanMs, limit });
    const line = { type: 'cron_payout_reconcile', ok: true, skipped: sweep.skipped || null, ...sweep.counts, ms: Date.now() - startedAt, timestamp: new Date().toISOString() };
    console.log(JSON.stringify(line));
    return res.status(200).json({ ok: true, skipped: sweep.skipped || null, counts: sweep.counts, notified: sweep.notified });
  } catch (e) {
    console.error(JSON.stringify({ type: 'cron_payout_reconcile', ok: false, error: e?.message || String(e), ms: Date.now() - startedAt, timestamp: new Date().toISOString() }));
    return res.status(500).json({ ok: false, error: 'SWEEP_FAILED', message: e?.message || String(e) });
  }
}
