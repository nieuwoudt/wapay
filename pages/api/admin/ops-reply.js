/**
 * POST /api/admin/ops-reply { accountId, text }   (admin session cookie or internal key)
 *
 * The Mission Control reply box: a person answers a customer inside their
 * WhatsApp chat (founder 2026-10-19: "tell me how I can reply to him"). Same
 * rules and the same code as /api/internal/ops-reply (lib/ops-reply.js): one
 * text, inside the customer's 24-hour window, sent through lib/say.js so the
 * chat remembers it.
 */
import prisma from '../../../lib/prisma.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { sendWhatsAppText } from '../../../lib/say.js';
import { opsReply } from '../../../lib/ops-reply.js';

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', ['POST']); return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' }); }
  const auth = requireAdmin(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  const out = await opsReply({ prisma, send: sendWhatsAppText, accountId: req.body?.accountId, text: req.body?.text, force: String(req.query?.force) === '1' });
  console.log(JSON.stringify({ type: 'admin_ops_reply', via: auth.via, status: out.status }));
  return res.status(out.status).json(out.body);
}
