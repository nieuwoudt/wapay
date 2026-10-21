/**
 * POST /api/internal/ops-payout — pay a customer's own balance to a
 * destination they saved, from the operator's side (lib/ops-payout.js).
 * Internal-key gated. Dry run unless `dryRun: false`; a live run needs `by`
 * and `reason`, writes an OPS_PAYOUT audit row and raises the pay-out alert.
 *
 *   curl -X POST -H "x-internal-api-key: $KEY" -H "content-type: application/json" \
 *     -d '{"accountId":"…","amountCents":"max","dryRun":true}' https://wapay-api.vercel.app/api/internal/ops-payout
 */
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import prisma from '../../../lib/prisma.js';
import { opsPayout } from '../../../lib/ops-payout.js';
import { sendWhatsAppText } from '../../../lib/say.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!requireInternalAuth(req, res)) return;
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const dryRun = b.dryRun !== false;
  const { opsPayoutDone } = await import('../../../lib/ops-alerts.js');
  const out = await opsPayout({
    prisma,
    accountId: String(b.accountId || ''),
    destinationId: b.destinationId ? String(b.destinationId) : null,
    amountCents: b.amountCents === 'max' ? 'max' : Number(b.amountCents),
    by: b.by ? String(b.by) : 'ops',
    reason: b.reason ? String(b.reason) : '',
    dryRun,
    deps: {
      alert: ({ amountCents, method, reference }) => opsPayoutDone({ amountCents, method, reference, prisma }),
      send: async ({ accountId, to, text }) => {
        const sent = await sendWhatsAppText({ to, text });
        await prisma.conversationTurn.create({ data: { accountId, role: 'assistant', kind: 'ops', text } }).catch(() => {});
        return sent;
      },
    },
  });
  return res.status(out.ok || dryRun ? 200 : 409).json(out);
}
