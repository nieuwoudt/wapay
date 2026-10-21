/**
 * GET /api/internal/float — the live OTT pay-out float, read directly from
 * the rail (lib/payout-float.js readPayoutFloat) with a generous timeout, so
 * ops can poll it while a bank transfer is expected (2026-10-21: the float
 * ran empty and the founder's top-up was watched for). Internal-key gated;
 * reads only.
 */
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import { readPayoutFloat } from '../../../lib/payout-float.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!requireInternalAuth(req, res)) return;
  const t0 = Date.now();
  try {
    const f = await readPayoutFloat({ timeoutMs: 20000 });
    return res.status(200).json({ ok: true, at: new Date().toISOString(), ms: Date.now() - t0, float: f });
  } catch (e) {
    return res.status(200).json({ ok: false, at: new Date().toISOString(), ms: Date.now() - t0, error: e?.code || e?.message || String(e) });
  }
}
