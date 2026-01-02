/**
 * POST /api/admin/sync-vas-catalog
 *
 * Triggers a Blu -> DB catalogue sync (DATA bundles for all networks).
 *
 * Auth:
 * - header: x-admin-key: ${ADMIN_API_KEY}
 * - or query: ?key=${ADMIN_API_KEY}
 */

import { syncBluDataCatalogue } from '../../../lib/vas-catalog-sync.js';

function isAuthed(req) {
  const key = req.headers['x-admin-key'] || req.query?.key;
  return process.env.ADMIN_API_KEY && key === process.env.ADMIN_API_KEY;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ ok: false, error: `Method ${req.method} Not Allowed` });
  }

  if (!isAuthed(req)) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }

  const vendors = Array.isArray(req.body?.vendors) ? req.body.vendors : undefined;
  try {
    const out = await syncBluDataCatalogue({ vendors });
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: e?.message || String(e) });
  }
}


