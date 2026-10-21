/**
 * WaPay personal portal: top up (2026-10-21), the chat's card deposit (lib/deposits.js + PayFast).
 *
 * GET                               → the limits, and whether a voucher top-up is live (VAS_LIVE_*)
 * GET ?paid=<paymentId>             → { status: WAITING | PAID | FAILED } for this customer's own intent
 * POST {action:'quote', amountCents} → amount + payment fee = what the card is charged
 * POST {action:'card', amountCents}  → { url } the hosted PayFast checkout, returning to /app/top-up
 *
 * The ITN credits the wallet exactly as for a chat deposit (one idemKey per intent).
 */
import { appDeps } from '../../../lib/app-deps.js';
import { gate, reply, intOf, appOrigin } from '../../../lib/app-http.js';
import { topupQuote } from '../../../lib/app-portal.js';
import { topupCard, topupStatus } from '../../../lib/app-money.js';
import { isCapabilityLiveFor } from '../../../lib/capabilities.js';
import { MIN_DEPOSIT_CENTS, MAX_DEPOSIT_CENTS } from '../../../lib/deposits.js';

export const config = { maxDuration: 20 };

export function createTopupHandler(depsOverride = null) {
  return async function handler(req, res) {
    const deps = depsOverride || (await appDeps());
    const g = await gate(req, res, deps);
    if (!g) return undefined;
    const account = g.session.account;
    if (req.method === 'GET') {
      if (req.query?.paid) return reply(res, await topupStatus(deps, { account, paymentId: String(req.query.paid) }));
      const ctx = { waId: account.waId, account };
      return res.status(200).json({ ok: true, minCents: MIN_DEPOSIT_CENTS, maxCents: MAX_DEPOSIT_CENTS, voucher: { blu: isCapabilityLiveFor('DEPOSIT_VOUCHER', ctx), ott: isCapabilityLiveFor('VOUCHER_LOAD', ctx) } });
    }
    const b = req.body || {};
    try {
      if (b.action === 'quote') {
        const q = topupQuote(intOf(b.amountCents));
        return reply(res, q.ok ? q : { ...q, status: 400 });
      }
      if (b.action === 'card') {
        const origin = appOrigin(req);
        if (!origin) return res.status(503).json({ ok: false, error: 'NOT_CONFIGURED' });
        const out = await topupCard(deps, { account, amountCents: intOf(b.amountCents), origin });
        if (out.ok) console.log(JSON.stringify({ type: 'app_topup_link', accountId: account.id, paymentId: out.paymentId, amountCents: out.amountCents }));
        return reply(res, out);
      }
      return res.status(400).json({ ok: false, error: 'ACTION' });
    } catch (error) {
      console.error(JSON.stringify({ type: 'app_topup_error', accountId: account.id, error: error?.message }));
      return res.status(500).json({ ok: false, error: 'TRY_AGAIN', line: 'The payment link could not be made just now. Please try again.' });
    }
  };
}

export default createTopupHandler();
