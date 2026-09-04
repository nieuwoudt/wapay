/**
 * WaPay for Business — customers.
 *
 * GET  ?q=&sort=recent|spend|name|outstanding&archived=1
 *      → every customer with derived money stats (paid, count, avg, last,
 *        outstanding). One bounded scan, no N+1.
 * POST {action:'create', msisdn, name?, email?, notes?, tags?}
 * POST {action:'import', text}   → paste CSV / vCard / numbers
 * POST {action:'update', id, name?, email?, notes?, tags?}
 * POST {action:'archive'|'restore', id}
 *
 * Every write is scoped to the session's business; another business's
 * customer id is simply "not found". Numbers are normalised to 0-form and
 * must be valid SA cellphones. Session-gated, fails closed.
 */

import { requireBusinessContext } from '../../../lib/business-auth.js';
import {
  listCustomersWithStats,
  upsertCustomer,
  updateCustomer,
  archiveCustomer,
  parseContactsImport,
  importCustomers,
  linkWalkInPayers,
} from '../../../lib/business.js';

export const config = { maxDuration: 25 };

export default async function handler(req, res) {
  const ctx = await requireBusinessContext(req);
  if (!ctx.ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const businessId = ctx.business.id;

  if (req.method === 'GET') {
    try {
      await linkWalkInPayers({ businessId });
      const out = await listCustomersWithStats({
        businessId,
        q: String(req.query.q || ''),
        sort: String(req.query.sort || 'recent'),
        includeArchived: req.query.archived === '1',
      });
      return res.status(200).json(out);
    } catch (error) {
      console.error(JSON.stringify({ type: 'business_customers_error', businessId, error: error?.message }));
      return res.status(500).json({ error: 'Could not load customers.' });
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const body = req.body || {};
  try {
    if (body.action === 'create') {
      const { customer, created } = await upsertCustomer({
        businessId, msisdn: body.msisdn, name: body.name, email: body.email, notes: body.notes, tags: body.tags, source: 'MANUAL',
      });
      return res.status(200).json({ ok: true, created, customer });
    }
    if (body.action === 'import') {
      const rows = parseContactsImport(String(body.text || '').slice(0, 200000));
      const out = await importCustomers({ businessId, rows });
      return res.status(200).json({ ok: true, parsed: rows.length, ...out });
    }
    if (body.action === 'update') {
      const customer = await updateCustomer({ businessId, customerId: String(body.id || ''), name: body.name, email: body.email, notes: body.notes, tags: body.tags });
      if (!customer) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
      return res.status(200).json({ ok: true, customer });
    }
    if (body.action === 'archive' || body.action === 'restore') {
      const customer = await archiveCustomer({ businessId, customerId: String(body.id || ''), restore: body.action === 'restore' });
      if (!customer) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
      return res.status(200).json({ ok: true, customer });
    }
    return res.status(400).json({ error: 'action' });
  } catch (error) {
    if (error?.code === 'BAD_MSISDN') return res.status(400).json({ ok: false, error: 'BAD_MSISDN' });
    console.error(JSON.stringify({ type: 'business_customers_write_error', businessId, action: body.action, error: error?.message }));
    return res.status(500).json({ ok: false, error: 'WRITE_FAILED' });
  }
}
