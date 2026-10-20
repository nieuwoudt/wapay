/**
 * Float loads (lib/float-loads.js, 2026-10-20).
 *   GET  /api/admin/float-load?key=OTT_PAYOUT          loads + reconciliation for one float (or all loads without key)
 *   POST /api/admin/float-load { key, amountCents, loadedAt?, reference?, note? }
 * Admin session or the internal key. Operator-entered money movements only; nothing touches a customer.
 */
import prisma from '../../../lib/prisma.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { recordFloatLoad, listFloatLoads, floatRecon, FLOAT_KEYS } from '../../../lib/float-loads.js';

export default async function handler(req, res) {
  const auth = requireAdmin(req);
  if (!auth.ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  try {
    if (req.method === 'GET') {
      const key = req.query?.key ? String(req.query.key).toUpperCase() : null;
      if (key && !FLOAT_KEYS.includes(key)) return res.status(400).json({ error: 'BAD_KEY', keys: FLOAT_KEYS });
      const loads = await listFloatLoads({ prisma, key, limit: 50 });
      const recon = key ? await floatRecon({ prisma, key }) : null;
      return res.status(200).json({ ok: true, key, loads, recon });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    const b = req.body || {};
    const out = await recordFloatLoad({ prisma, key: b.key, amountCents: Number(b.amountCents), loadedAt: b.loadedAt, reference: b.reference, note: b.note, by: auth.who || auth.msisdn || 'admin' });
    if (!out.ok) return res.status(400).json(out);
    console.log(JSON.stringify({ type: 'float_load_recorded', key: out.load.key, amountCents: out.load.amountCents, loadedAt: out.load.loadedAt, replayed: out.replayed }));
    const recon = await floatRecon({ prisma, key: out.load.key });
    return res.status(200).json({ ...out, recon });
  } catch (e) {
    console.error(JSON.stringify({ type: 'float_load_failed', error: e?.message }));
    return res.status(500).json({ error: 'FAILED' });
  }
}
