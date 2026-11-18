/**
 * Book a card chargeback: the cardholder's bank took a card payment back and PayFast or Adumo reversed it from the
 * merchant account (lib/card-refund.js, 2026-11-17).
 *
 *   GET  /api/internal/card-chargeback?providerRef=…   (or ?idemKey=<the LOAD entry's idemKey>)
 *        dry run: the entry found, the postings, what the wallet still gives back (never below zero), what WaPay
 *        writes off on EXPENSE:CHARGEBACK:<rail>, the link it closes, or why a POST would refuse. Writes nothing.
 *   POST /api/internal/card-chargeback { providerRef | idemKey, reason, by?, onlyCharge? }
 *        posts the chargeback (clearing gives back the gross, the fee revenue is reversed, the wallet gives what it
 *        holds, the rest is the loss), closes the paid link as REFUNDED, flags the intent (metadata.refund, kind
 *        CHARGEBACK), writes the CARD_CHARGEBACK audit row and raises one masked ops alert. Sends the customer
 *        nothing.
 *
 * Internal key. It calls no processor API: the processor already took the money; this only records it.
 * It never freezes, unfreezes or approves anything. Answers carry masked numbers only.
 * Refusals as /api/internal/card-refund, except that SHORT never refuses a chargeback: 409 ALREADY_REVERSED
 * (`reversedAs` says whether a refund or a chargeback exists), 409 BALANCE_MOVED (the balance changed during the
 * call; call again), 503 NEEDS_MIGRATION (20261109_payment_request_refunded).
 */
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import prisma from '../../../lib/prisma.js';
import { planCardChargeback, postCardChargeback, refusalStatus, maskDigits } from '../../../lib/card-refund.js';

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
      const plan = await planCardChargeback({ prisma, providerRef, idemKey });
      const inputProblem = !plan.ok && [400, 404].includes(refusalStatus(plan.refused));
      return res.status(inputProblem ? refusalStatus(plan.refused) : 200).json({ dryRun: true, wouldReverse: plan.ok, ...plan });
    }
    const onlyCharge = src.onlyCharge === true || String(src.onlyCharge) === 'true';
    const out = await postCardChargeback({ prisma, providerRef, idemKey, reason: src.reason, by: src.by || 'ops', onlyCharge });
    if (!out.ok) console.log(JSON.stringify({ type: 'card_chargeback_refused', refused: out.refused, original: out.original?.idemKey || null, by: maskDigits(src.by || 'ops').slice(0, 40) }));
    return res.status(out.ok ? 200 : refusalStatus(out.refused)).json(out);
  } catch (error) {
    console.error(JSON.stringify({ type: 'card_chargeback_error', method: req.method, error: error?.message }));
    return res.status(500).json({ ok: false, error: 'CARD_CHARGEBACK_FAILED' });
  }
}
