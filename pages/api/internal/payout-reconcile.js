/**
 * Reconcile pay-outs parked as PENDING (internal key). The OTT webhook is the
 * normal finaliser; when it never arrives (the sandbox sends none, a transport
 * failure, a status code we do not know) this is how a hold gets settled or
 * released: by asking OTT GetPaymentStatus and applying its answer, never by
 * guessing and never by a second PerformPayout (docs/OTT_PAYOUT_API.md §5).
 *
 *   GET  ?reference=WP…                 check one pay-out
 *   GET  [?olderThanMinutes=2&limit=20] sweep every PENDING pay-out
 *   POST                                the same, for a scheduler
 *
 * Idempotent: a settled or released row is a no-op next time. A finalised
 * customer is told, with the same words the webhook uses.
 */
import crypto from 'node:crypto';
import { sendWhatsAppText } from '../../../lib/say.js';
import prisma from '../../../lib/prisma.js';
import { reconcilePayout, reconcilePendingPayouts, payoutOutcomeMessage, payoutConfigured } from '../../../lib/payouts.js';

export const config = { maxDuration: 25 };

function keyOk(req) {
  const internalKey = process.env.WAPAY_INTERNAL_API_KEY || '';
  const presented = req.headers['x-internal-api-key'];
  if (!internalKey || typeof presented !== 'string' || !presented) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(internalKey).digest();
  return crypto.timingSafeEqual(a, b);
}

/** What an operator sees per pay-out: outcome facts only, never the recipient. */
function publicRow(out) {
  return {
    reference: out.reference || null,
    status: out.status || null,
    noop: !!out.noop,
    checked: out.checked ?? null,
    providerStatus: out.providerStatus ?? null,
    outcome: out.outcome || null,
    message: out.message || null,
    error: out.error || null,
    method: out.method || null,
    amountCents: out.amountCents ?? null,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!keyOk(req)) return res.status(401).json({ error: 'unauthorized' });
  const out = { checkedAt: new Date().toISOString(), build: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null };
  if (!payoutConfigured()) return res.status(200).json({ ...out, error: 'OTT_PAYOUT_* incomplete in this deployment' });

  const reference = String(req.query.reference || '').trim();
  const olderThanMs = Math.max(0, Number(req.query.olderThanMinutes ?? 2)) * 60 * 1000;
  const limit = Number(req.query.limit) || 20;
  const results = reference ? [await reconcilePayout({ reference })] : await reconcilePendingPayouts({ olderThanMs, limit });

  const notified = [];
  for (const r of results) {
    if (r.accountId && (r.status === 'SETTLED' || r.status === 'FAILED') && !r.noop) {
      const account = await prisma.account.findUnique({ where: { id: r.accountId }, select: { waId: true } }).catch(() => null);
      if (account?.waId) {
        await sendWhatsAppText({ to: account.waId, text: payoutOutcomeMessage(r) }).catch(() => null);
        notified.push(r.reference);
      }
    }
  }
  return res.status(200).json({ ...out, count: results.length, results: results.map(publicRow), notified });
}
