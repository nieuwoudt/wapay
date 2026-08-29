/**
 * UniFuel / wiCode layer for Mission Control (v1.3.1 amendment 3):
 * WaPay-originated issuance + redemption stats and the live redeemable
 * catalogue, via the authenticated service-to-service API. Admin-gated,
 * cached ~60s, degrades to configured:false when the partnership envs are
 * absent — never 500s the dashboard.
 */

import { requireAdmin } from '../../../lib/admin-auth.js';
import { fetchStats, fetchCatalog, isUnifuelConfigured } from '../../../lib/unifuel-client.js';

export const config = { maxDuration: 25 };

const CACHE_TTL_MS = 60_000;
let cache = { at: 0, data: null };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });

  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).json(cache.data);
  }

  if (!isUnifuelConfigured()) {
    return res.status(200).json({ configured: false });
  }

  const [stats, catalog] = await Promise.all([
    fetchStats().catch(() => ({ ok: false })),
    fetchCatalog().catch(() => ({ ok: false })),
  ]);

  const data = {
    configured: true,
    generatedAt: new Date().toISOString(),
    stats: stats.ok ? stats : null,
    catalog: catalog.ok ? catalog : null,
  };
  cache = { at: Date.now(), data };
  res.setHeader('Cache-Control', 'private, max-age=60');
  return res.status(200).json(data);
}
