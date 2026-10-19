/**
 * POST /api/internal/ops-reply { accountId, text }   (x-internal-api-key)
 *
 * A person from the WaPay team answers a customer in their WhatsApp chat
 * (founder 2026-10-19: "help the bot respond to him in chat"). The send goes
 * through lib/say.js, so the turn is recorded as the assistant's and the chat
 * remembers it. Inside the customer's 24-hour window only (?force=1 overrides).
 *
 *   curl -X POST -H "x-internal-api-key: $KEY" -H "content-type: application/json" \
 *     -d '{"accountId":"<id>","text":"..."}' https://wapay-api.vercel.app/api/internal/ops-reply
 */
import prisma from '../../../lib/prisma.js';
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import { sendWhatsAppText } from '../../../lib/say.js';
import { opsReply } from '../../../lib/ops-reply.js';

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }
  if (!requireInternalAuth(req, res)) return;
  const out = await opsReply({ prisma, send: sendWhatsAppText, accountId: req.body?.accountId, text: req.body?.text, force: String(req.query?.force) === '1' });
  return res.status(out.status).json(out.body);
}
