/**
 * GET /api/cron/adumo-reconcile
 *
 * Every Adumo pay-link intent still PENDING past its grace period (the payer
 * never came back, the webhook never arrived) is checked against Adumo's
 * reporting (getState by our merchant reference) and settled, once, only
 * when Adumo says SETTLED for the same gross (lib/adumo-reporting.js). Same
 * auth as payout-reconcile: the Vercel cron header, ?key=CRON_SECRET, or the
 * internal key. Never throws; counts or an error, never a stack.
 */
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import { adumoReportingConfigured, reconcileAdumoIntents } from '../../../lib/adumo-reporting.js';

export const config = { maxDuration: 60 };

function isCronAuthed(req) {
  if (req.headers['x-vercel-cron'] === '1') return true;
  const key = req.query?.key;
  return !!(process.env.CRON_SECRET && key === process.env.CRON_SECRET);
}
function isAuthed(req, res) {
  if (isCronAuthed(req)) return true;
  if (process.env.WAPAY_INTERNAL_API_KEY && typeof req.headers['x-internal-api-key'] === 'string') {
    return requireInternalAuth(req, res);
  }
  res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method' });
  if (!isAuthed(req, res)) return;
  if (!adumoReportingConfigured()) return res.status(200).json({ ok: true, skipped: 'ADUMO_CLIENT_ID / ADUMO_CLIENT_SECRET not set', count: 0 });
  try {
    const olderThanMs = Math.max(1, Number(req.query.olderThanMinutes ?? 5)) * 60 * 1000;
    const results = await reconcileAdumoIntents({ olderThanMs, limit: Number(req.query.limit) || 20 });
    const settled = results.filter((r) => r.status === 'SETTLED').length;
    console.log(JSON.stringify({ type: 'cron_adumo_reconcile', count: results.length, settled }));
    return res.status(200).json({ ok: true, count: results.length, settled, results: results.map((r) => ({ mref: r.mref, status: r.status, checked: r.checked ?? null, found: r.found ?? null, transactionState: r.transactionState || null, error: r.error || null, mismatch: r.mismatch || null })) });
  } catch (error) {
    console.error(JSON.stringify({ type: 'cron_adumo_reconcile', error: error?.message }));
    return res.status(200).json({ ok: false, error: String(error?.message || error).slice(0, 160) });
  }
}
