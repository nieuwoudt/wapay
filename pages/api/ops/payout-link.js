/**
 * GET  /api/ops/payout-link?token=…  → the dry run for the pay-out the link describes (no money moves).
 * POST /api/ops/payout-link {token}   → executes it (idempotent on the link's fixed intent).
 * The token is the credential (lib/ops-link.js); nothing else is accepted.
 */
import prisma from '../../../lib/prisma.js';
import { verifyOpsPayoutLink } from '../../../lib/ops-link.js';
import { opsPayout } from '../../../lib/ops-payout.js';
import { sendWhatsAppText } from '../../../lib/say.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  const token = req.method === 'GET' ? req.query?.token : req.body?.token;
  const v = verifyOpsPayoutLink(token);
  if (!v.ok) return res.status(401).json({ error: 'link', reason: v.reason });
  const { accountId, destinationId, amountCents, intentId, by, reason } = v.data;
  if (req.method === 'GET') {
    const out = await opsPayout({ prisma, accountId, destinationId, amountCents, dryRun: true });
    return res.status(200).json({ ...out, link: { by, reason, expiresAt: v.data.expiresAt } });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const { opsPayoutDone } = await import('../../../lib/ops-alerts.js');
  const out = await opsPayout({
    prisma, accountId, destinationId, amountCents, by, reason, dryRun: false, intentId,
    deps: {
      alert: ({ amountCents: c, method, reference }) => opsPayoutDone({ amountCents: c, method, reference, prisma }),
      send: async ({ accountId: id, to, text }) => {
        const sent = await sendWhatsAppText({ to, text });
        await prisma.conversationTurn.create({ data: { accountId: id, role: 'assistant', kind: 'ops', text } }).catch(() => {});
        return sent;
      },
    },
  });
  return res.status(out.ok ? 200 : 409).json(out);
}
