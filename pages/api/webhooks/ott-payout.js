/**
 * OTT Payout status webhook (docs/OTT_PAYOUT_API.md §7). Verified by hash
 * before anything else; drives PENDING payouts to SETTLED or FAILED through
 * lib/payouts.js finalisePayout (idempotent: a repeat is a no-op). Processing
 * completes BEFORE the 200, as with every webhook on Vercel.
 */
import { sendWhatsAppText } from '@wapay/whatsapp';
import prisma from '../../../lib/prisma.js';
import { verifyPayoutWebhook } from '../../../lib/ott-payout.js';
import { finalisePayout, PAYOUT_METHODS } from '../../../lib/payouts.js';

export const config = { maxDuration: 25 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const apiKey = process.env.OTT_PAYOUT_API_KEY || '';
  if (!apiKey) return res.status(503).json({ ok: false, error: 'NOT_CONFIGURED' });
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  if (!verifyPayoutWebhook(payload, apiKey)) {
    console.error(JSON.stringify({ type: 'ott_payout_webhook_rejected', reference: String(payload.merchantUniqueReference || '').slice(0, 24) }));
    return res.status(401).json({ ok: false, error: 'BAD_HASH' });
  }
  try {
    const out = await finalisePayout({ reference: String(payload.merchantUniqueReference || ''), status: payload.status, message: payload.message });
    console.log(JSON.stringify({ type: 'ott_payout_webhook', reference: String(payload.merchantUniqueReference || '').slice(0, 24), status: String(payload.status), result: out.status || out.error }));
    // The customer asked minutes ago (the 24h window is open): tell them the outcome.
    if (out.accountId && (out.status === 'SETTLED' || out.status === 'FAILED') && !out.noop) {
      const account = await prisma.account.findUnique({ where: { id: out.accountId }, select: { waId: true } }).catch(() => null);
      if (account?.waId) {
        const rands = (c) => `R${(Number(c || 0) / 100).toFixed(2).replace(/\.00$/, '')}`;
        const label = PAYOUT_METHODS[out.method]?.label || 'your pay-out';
        const text = out.status === 'SETTLED'
          ? `✅ Your withdrawal of ${rands(out.amountCents)} by ${label} has been paid (reference ${out.reference}).`
          : `❌ Your withdrawal of ${rands(out.amountCents)} by ${label} could not be completed by the bank rail (reference ${out.reference}). The full amount and the fee are back in your WaPay balance.`;
        await sendWhatsAppText({ to: account.waId, text }).catch(() => null);
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ type: 'ott_payout_webhook_error', error: error?.message }));
  }
  return res.status(200).json({ ok: true });
}
