/**
 * Book a card refund the founder already made in the PayFast or Adumo merchant dashboard
 * (lib/card-refund.js, BUGLOG #146, 2026-11-09).
 *
 *   GET  /api/internal/card-refund?providerRef=…   (or ?idemKey=<the LOAD entry's idemKey>)
 *        dry run: the entry found, what the reversal posts, the wallet before and after, the link it closes,
 *        or why a POST would refuse. Writes nothing.
 *   POST /api/internal/card-refund { providerRef | idemKey, reason, by?, onlyCharge? }
 *        posts the mirror of the card load (wallet, fee revenue and clearing), marks the paid link REFUNDED,
 *        writes the audit row and raises one masked ops alert. Sends the customer nothing. `onlyCharge: true` is
 *        needed only when the dry run says referenceCheck UNVERIFIED (a payment older than 2026-11-09 with no
 *        link naming its charge): the operator's word that the dashboard shows one payment for that intent.
 *
 * Internal key. It never calls a processor's refund API: refund in the dashboard first, then call this.
 * It never freezes, unfreezes or approves anything. Answers carry masked numbers only.
 * Refusals: 400 bad input · 404 not found · 422 not a card load · 409 already reversed, short balance,
 * a second charge that never reached a balance, an ambiguous reference, onlyCharge missing · 503 the database
 * still refuses REFUNDED on a link (apply migration 20261109_payment_request_refunded first).
 */
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import prisma from '../../../lib/prisma.js';
import { planCardRefund, postCardRefund, refusalStatus, maskDigits } from '../../../lib/card-refund.js';

export default async function handler(req, res) {
  if (!requireInternalAuth(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ ok: false, error: 'METHOD' });
  }
  const src = (req.method === 'GET' ? req.query : req.body) || {};
  const providerRef = src.providerRef ?? null;
  const idemKey = src.idemKey ?? null;
  try {
    if (req.method === 'GET') {
      const plan = await planCardRefund({ prisma, providerRef, idemKey });
      const inputProblem = !plan.ok && [400, 404].includes(refusalStatus(plan.refused));
      return res.status(inputProblem ? refusalStatus(plan.refused) : 200).json({ dryRun: true, wouldReverse: plan.ok, ...plan });
    }
    const onlyCharge = src.onlyCharge === true || String(src.onlyCharge) === 'true';
    const out = await postCardRefund({ prisma, providerRef, idemKey, reason: src.reason, by: src.by || 'ops', onlyCharge });
    if (!out.ok) console.log(JSON.stringify({ type: 'card_refund_refused', refused: out.refused, original: out.original?.idemKey || null, by: maskDigits(src.by || 'ops').slice(0, 40) }));
    return res.status(out.ok ? 200 : refusalStatus(out.refused)).json(out);
  } catch (error) {
    console.error(JSON.stringify({ type: 'card_refund_error', method: req.method, error: error?.message }));
    return res.status(500).json({ ok: false, error: 'CARD_REFUND_FAILED' });
  }
}
