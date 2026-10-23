/**
 * GET /api/internal/compliance-check[?alert=1] — the daily WhatsApp compliance check
 * (lib/meta-compliance.js): Meta's view of the number and templates, and our own sending
 * behaviour over the last 24 hours, with a RED / AMBER / GREEN verdict and plain reasons.
 * alert=1 (the daily cron) also e-mails the summary once a day and alerts ops on WhatsApp
 * when the verdict is not GREEN and a reason is new. Internal key; reads only otherwise.
 */
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import prisma from '../../../lib/prisma.js';
import { runComplianceCheck } from '../../../lib/meta-compliance.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!requireInternalAuth(req, res)) return;
  const alert = String(req.query?.alert || '') === '1';
  const out = await runComplianceCheck({ prisma, alert });
  return res.status(200).json(out);
}
