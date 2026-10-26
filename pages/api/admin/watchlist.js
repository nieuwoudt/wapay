/**
 * GET /api/admin/watchlist?days=30   (admin session) → the numbers we should be watching (lib/watchlist.js).
 * Founder 2026-10-26. Masked numbers only.
 */
import prisma from '../../../lib/prisma.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { watchlist } from '../../../lib/watchlist.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  try {
    return res.status(200).json({ ok: true, ...(await watchlist({ prisma, days: Math.min(90, Math.max(1, Number(req.query?.days) || 30)) })) });
  } catch (error) {
    console.error(JSON.stringify({ type: 'admin_watchlist_error', error: error?.message }));
    return res.status(500).json({ ok: false, error: 'READ_FAILED' });
  }
}
