/**
 * GET /api/cron/daily-vas-sync
 *
 * Daily cron entrypoint:
 * - sync Blu DATA catalogue into DB
 * - log counts so we can detect if a vendor goes to 0 products
 * - refresh semantic-search embeddings for changed products (best-effort;
 *   an embeddings failure never fails the cron response)
 *
 * Auth:
 * - Vercel Cron header: x-vercel-cron=1 (preferred)
 * - or query token: ?key=${CRON_SECRET}
 */

import { syncBluDataCatalogue } from '../../../lib/vas-catalog-sync.js';
import { syncProductEmbeddings } from '../../../lib/vas-embeddings.js';
import prisma from '../../../lib/prisma.js';

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

    // Best-effort embeddings refresh: must never fail the cron response.
    let embeddings;
    try {
      embeddings = await syncProductEmbeddings({ prisma });
    } catch (e) {
      console.error(JSON.stringify({
        type: 'cron_embeddings_sync_failed',
        error: e?.message || String(e),
        timestamp: new Date().toISOString(),
      }));
      embeddings = { embedded: 0, skipped: 0, failed: 0, error: e?.message || String(e) };
    }

    return res.status(200).json({ ...out, embeddings });
  } catch (e) {
    console.error('cron_daily_vas_sync_failed', e);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: e?.message || String(e) });
  }
}


