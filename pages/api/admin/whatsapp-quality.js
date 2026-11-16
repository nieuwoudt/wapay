/**
 * GET /api/admin/whatsapp-quality   (admin session or internal key)
 * Meta's view of our number for the Health tab: quality rating, messaging limit, status, support contact on the profile.
 */
import { requireAdmin } from '../../../lib/admin-auth.js';
import { readWhatsAppQuality } from '../../../lib/whatsapp-quality.js';
import { deliveryHealth } from '../../../lib/delivery-health.js';
import { runComplianceCheck } from '../../../lib/meta-compliance.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  // The daily compliance verdict, computed live for the Health tab (no alerts from here).
  const [q, delivery, compliance] = await Promise.all([readWhatsAppQuality(), deliveryHealth(), runComplianceCheck({ alert: false })]);
  return res.status(200).json({ ...q, delivery, compliance: compliance ? { verdict: compliance.verdict, reasons: compliance.reasons || [], behaviour: compliance.behaviour || null, at: compliance.at } : null });
}
