/**
 * WaPay for Business — reconciliation export. GET ?days=90 → CSV of every
 * payment link in the window (all statuses) with customer, reference, items,
 * amount, fee, net and the link itself. The whole point of the portal for
 * the design-partner laundry: no more matching links to customers by hand.
 * Read-only, session-gated, fails closed.
 */

import { requireBusinessContext } from '../../../lib/business-auth.js';
import { exportLinksCsv } from '../../../lib/business.js';

export const config = { maxDuration: 25 };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const ctx = await requireBusinessContext(req);
  if (!ctx.ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const days = Math.min(3650, Math.max(1, Number(req.query.days) || 90));
  try {
    const csv = await exportLinksCsv({ businessId: ctx.business.id, sinceDays: days });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="wapay-business-payments-${stamp}.csv"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).send(csv);
  } catch (error) {
    console.error(JSON.stringify({ type: 'business_export_error', businessId: ctx.business.id, error: error?.message }));
    return res.status(500).json({ error: 'Could not export.' });
  }
}
