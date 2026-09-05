/**
 * WaPay for Business — the Overview payload (revenue, outstanding,
 * customers, methods, monthly series, 3/6/12-month totals, top customers,
 * recent payments). Derived from payment_requests; read-only apart from the
 * idempotent walk-in → customer linking. Session-gated, fails closed.
 */

import { requireBusinessContext } from '../../../lib/business-auth.js';
import { businessOverview, linkWalkInPayers } from '../../../lib/business.js';

export const config = { maxDuration: 25 };

const RANGES = { '7': 7, '30': 30, '90': 90, '365': 365, all: 3650 };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const ctx = await requireBusinessContext(req);
  if (!ctx.ok) return res.status(401).json({ error: 'UNAUTHORIZED' });

  const rangeKey = String(req.query.range || '30');
  const rangeDays = Object.hasOwn(RANGES, rangeKey) ? RANGES[rangeKey] : 30; // ?range=constructor must not 500
  try {
    await linkWalkInPayers({ businessId: ctx.business.id });
    const payload = await businessOverview({ businessId: ctx.business.id, rangeDays });
    res.setHeader('Cache-Control', 'private, no-store'); // never serve one owner's dashboard to the next sign-in
    return res.status(200).json({ business: { id: ctx.business.id, name: ctx.business.name }, ...payload });
  } catch (error) {
    console.error(JSON.stringify({ type: 'business_overview_error', businessId: ctx.business.id, error: error?.message }));
    return res.status(500).json({ error: 'Could not load the overview.' });
  }
}
