/**
 * Per-account pay-out freeze (lib/payout-freeze.js, 2026-10-20).
 *
 *   GET  /api/internal/payout-freeze?accountId=…            the freeze state
 *   POST /api/internal/payout-freeze { accountId, frozen: true|false, reason?, by? }
 *
 * Internal key. Freezing pauses pay-outs AND outbound sends from that one
 * account; receiving stays open. Every change raises a masked ops alert so the
 * founder sees it on WhatsApp and e-mail. The response never carries a number.
 */
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import prisma from '../../../lib/prisma.js';
import { setPayoutFreeze, freezeState } from '../../../lib/payout-freeze.js';

export default async function handler(req, res) {
  if (!requireInternalAuth(req, res)) return;
  const id = String((req.method === 'GET' ? req.query?.accountId : req.body?.accountId) || '').trim();
  if (!/^[a-z0-9]{20,40}$/i.test(id)) return res.status(400).json({ ok: false, error: 'BAD_ACCOUNT' });
  if (req.method === 'GET') {
    const row = await prisma.account.findUnique({ where: { id }, select: { profile: true } });
    if (!row) return res.status(404).json({ ok: false, error: 'NO_ACCOUNT' });
    return res.status(200).json({ ok: true, accountId: id, state: freezeState(row.profile) });
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'METHOD' });
  const frozen = req.body?.frozen === true || String(req.body?.frozen) === 'true';
  const out = await setPayoutFreeze({ prisma, accountId: id, frozen, reason: req.body?.reason || null, by: req.body?.by || 'ops' });
  if (!out.ok) return res.status(out.error === 'NO_ACCOUNT' ? 404 : 400).json(out);
  try {
    const { opsPersonAlert } = await import('../../../lib/ops-alerts.js');
    await opsPersonAlert({ text: `${frozen ? '⏸ Pay-outs frozen' : '▶️ Pay-outs unfrozen'} on account ${id.slice(0, 8)}… ${out.state?.reason ? `(${out.state.reason})` : ''}`.trim(), key: `payout-freeze:${id}:${frozen ? 'on' : 'off'}:${Date.now()}` });
  } catch {
    // the alert is best effort; the freeze already holds
  }
  console.log(JSON.stringify({ type: 'payout_freeze', accountId: id, frozen, by: String(req.body?.by || 'ops').slice(0, 40) }));
  return res.status(200).json(out);
}
