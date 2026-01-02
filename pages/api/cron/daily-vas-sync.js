/**
 * GET /api/cron/daily-vas-sync
 *
 * Daily cron entrypoint:
 * - sync Blu DATA catalogue into DB
 * - log counts so we can detect if a vendor goes to 0 products
 *
 * Auth:
 * - Vercel Cron header: x-vercel-cron=1 (preferred)
 * - or query token: ?key=${CRON_SECRET}
 */

import { syncBluDataCatalogue } from '../../../lib/vas-catalog-sync.js';

function isCronAuthed(req) {
  if (req.headers['x-vercel-cron'] === '1') return true;
  const key = req.query?.key;
  return process.env.CRON_SECRET && key === process.env.CRON_SECRET;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ ok: false, error: `Method ${req.method} Not Allowed` });
  }

  if (!isCronAuthed(req)) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }

  try {
    const out = await syncBluDataCatalogue();
    console.log(JSON.stringify({ type: 'cron_daily_vas_sync', ...out, timestamp: new Date().toISOString() }));
    return res.status(200).json(out);
  } catch (e) {
    console.error('cron_daily_vas_sync_failed', e);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: e?.message || String(e) });
  }
}


