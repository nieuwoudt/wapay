/**
 * GET /api/admin/link-map?days=30                (admin session) → the Links tab: where links are made,
 *                                                   shared, opened and paid from (lib/link-map.js)
 * GET /api/admin/link-map?code=PRXXXXXX           → one link's story, event by event
 * GET /api/admin/link-map?days=30&format=csv      → the visits as CSV (areas and devices only)
 *
 * Founder 2026-10-25. Areas come from the internet connection (Vercel's edge), never GPS, never the IP.
 */
import prisma from '../../../lib/prisma.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { linkMapView, linkTimeline, linkVisitsCsv } from '../../../lib/link-map.js';

export const config = { maxDuration: 25 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  try {
    if (req.query?.code) {
      const out = await linkTimeline({ prisma, code: req.query.code });
      return res.status(out.ok ? 200 : out.error === 'NOT_FOUND' ? 404 : 400).json(out);
    }
    if (req.query?.format === 'csv') {
      const csv = await linkVisitsCsv({ prisma, days: req.query?.days });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="wapay-link-visits-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.status(200).send(csv);
    }
    return res.status(200).json({ ok: true, ...(await linkMapView({ prisma, days: req.query?.days })) });
  } catch (error) {
    console.error(JSON.stringify({ type: 'admin_link_map_error', error: error?.message }));
    return res.status(500).json({ ok: false, error: /link_visits|linkVisit/.test(String(error?.message)) ? 'NO_TABLE_YET' : 'READ_FAILED' });
  }
}
