/**
 * WaPay for Business — one customer's profile: identity, lifetime and
 * period stats, 12-month spend series, top items, every payment link with
 * its line items and status. Read-only; scoped to the session's business
 * (another business's customer id is "not found"). Fails closed.
 */

import { requireBusinessContext } from '../../../lib/business-auth.js';
import { getCustomerProfile } from '../../../lib/business.js';

export const config = { maxDuration: 25 };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const ctx = await requireBusinessContext(req);
  if (!ctx.ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const customerId = String(req.query.id || '');
  if (!customerId) return res.status(400).json({ error: 'id required' });
  try {
    const profile = await getCustomerProfile({ businessId: ctx.business.id, customerId });
    if (!profile) return res.status(404).json({ error: 'NOT_FOUND' });
    return res.status(200).json(profile);
  } catch (error) {
    console.error(JSON.stringify({ type: 'business_customer_error', businessId: ctx.business.id, error: error?.message }));
    return res.status(500).json({ error: 'Could not load the customer.' });
  }
}
