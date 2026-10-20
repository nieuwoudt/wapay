/**
 * GET /api/admin/whatsapp-quality   (admin session or internal key)
 * Meta's view of our number for the Health tab: quality rating, messaging limit, status, support contact on the profile.
 */
import { requireAdmin } from '../../../lib/admin-auth.js';
import { readWhatsAppQuality } from '../../../lib/whatsapp-quality.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const q = await readWhatsAppQuality();
  return res.status(200).json(q);
}
