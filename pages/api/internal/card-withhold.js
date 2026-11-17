/**
 * Withhold disputed card money from a balance, or release it back (lib/card-refund.js, 2026-11-17).
 *
 *   GET  /api/internal/card-withhold?providerRef=…[&release=true]   (or ?idemKey=<the LOAD entry's idemKey>)
 *        dry run: the card load found, what the wallet would give (its available balance, never more than that load
 *        credited, never money under a hold), the postings, the balance after, or why a POST would refuse.
 *   POST /api/internal/card-withhold { providerRef | idemKey, reason, by?, release?, onlyCharge? }
 *        withhold: the money moves from the credited wallet to LIABILITY:CARD_DISPUTE:<rail>, where WaPay holds it.
 *        release: the exact mirror, back to the same wallet. Either way: one audit row, one masked ops alert, the
 *        intent's metadata.withhold, nothing to the customer. The link stays paid; nothing is refunded.
 *
 * Internal key. It calls no processor, freezes nothing, approves nothing. The request cannot choose an amount or a
 * wallet. Answers carry masked numbers only. Refusals: 409 ALREADY_WITHHELD / ALREADY_RELEASED / ALREADY_REVERSED /
 * NOTHING_TO_WITHHOLD / NOT_WITHHELD / BALANCE_MOVED (call again) / CONFIRM_ONLY_CHARGE, 400 / 404 bad input.
 */
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import prisma from '../../../lib/prisma.js';
import { planCardWithhold, postCardWithhold, refusalStatus, maskDigits } from '../../../lib/card-refund.js';

const yes = (v) => v === true || String(v) === 'true';

export default async function handler(req, res) {
  if (!requireInternalAuth(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ ok: false, error: 'METHOD' });
  }
  const src = (req.method === 'GET' ? req.query : req.body) || {};
  const providerRef = src.providerRef ?? null;
  const idemKey = src.idemKey ?? null;
  const release = yes(src.release);
  try {
    if (req.method === 'GET') {
      const plan = await planCardWithhold({ prisma, providerRef, idemKey, release });
      const inputProblem = !plan.ok && [400, 404].includes(refusalStatus(plan.refused));
      return res.status(inputProblem ? refusalStatus(plan.refused) : 200).json({ dryRun: true, wouldPost: plan.ok, ...plan });
    }
    const out = await postCardWithhold({ prisma, providerRef, idemKey, release, reason: src.reason, by: src.by || 'ops', onlyCharge: yes(src.onlyCharge) });
    if (!out.ok) console.log(JSON.stringify({ type: 'card_withhold_refused', release, refused: out.refused, original: out.original?.idemKey || null, by: maskDigits(src.by || 'ops').slice(0, 40) }));
    return res.status(out.ok ? 200 : refusalStatus(out.refused)).json(out);
  } catch (error) {
    console.error(JSON.stringify({ type: 'card_withhold_error', method: req.method, error: error?.message }));
    return res.status(500).json({ ok: false, error: 'CARD_WITHHOLD_FAILED' });
  }
}
