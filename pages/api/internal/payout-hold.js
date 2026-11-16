/**
 * The global pay-out hold (x-internal-api-key). Founder 2026-10-24: "don't do any more payouts until I
 * say we can". See lib/payout-hold.js for what it stops and what stays open.
 *
 *   GET  /api/internal/payout-hold                                    → { held, since, last }
 *   POST /api/internal/payout-hold { held: true|false, by, reason }   → switches it, logs who and why
 *
 * Lifting it is the founder's decision only. `by` and `reason` are required on every switch.
 */
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import { readPayoutHold, setPayoutHold, setPayoutApproval, readPayoutMode } from '../../../lib/payout-hold.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET' && req.method !== 'POST') { res.setHeader('Allow', ['GET', 'POST']); return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' }); }
  if (!requireInternalAuth(req, res)) return;
  if (req.method === 'GET') return res.status(200).json({ ok: true, ...(await readPayoutHold()), mode: (await readPayoutMode()).mode });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    // Approval mode (2026-10-26): POST { approval: true|false, by, reason } turns founder approval of every pay-out on or off.
    if (typeof body.approval === 'boolean' || body.approval !== undefined) {
      const mode = await setPayoutApproval({ on: body.approval, by: body.by, reason: body.reason });
      console.log(JSON.stringify({ type: 'payout_approval_set', on: mode.approval, by: String(body.by || '').slice(0, 60), at: new Date().toISOString() }));
      return res.status(200).json({ ok: true, ...mode });
    }
    const state = await setPayoutHold({ held: body.held, by: body.by, reason: body.reason });
    console.log(JSON.stringify({ type: 'payout_hold_set', held: state.held, by: String(body.by || '').slice(0, 60), at: new Date().toISOString() }));
    return res.status(200).json({ ok: true, ...state });
  } catch (error) {
    if (error?.code === 'BAD_HELD' || error?.code === 'NEED_REASON') return res.status(400).json({ ok: false, error: error.code, message: error.message });
    console.error(JSON.stringify({ type: 'payout_hold_set_failed', error: error?.message }));
    return res.status(500).json({ ok: false, error: 'HOLD_WRITE_FAILED' });
  }
}
