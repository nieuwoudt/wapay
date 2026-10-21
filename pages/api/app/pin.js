/**
 * WaPay personal portal: the PIN step before money moves (2026-10-21).
 *
 * POST {purpose:'payout'|'send'|'link', intentId, amountCents, pin}
 *   → { proof } from @wapay/auth verifyPIN on a correct PIN, bound to this
 *     account, this intent and this amount, two minutes (golden thread 2.1, 2.2).
 *
 * The only place the portal asks for a PIN at a money step. Session and CSRF
 * first; the PIN's shape, the failure counts (5 per account and per IP in 15
 * minutes) and the web ceiling on the shared counter before an attempt is
 * spent. The PIN is never logged and never echoed.
 */
import { appDeps } from '../../../lib/app-deps.js';
import { gate, reply, intOf } from '../../../lib/app-http.js';
import { pinStepUp } from '../../../lib/app-money.js';

export const config = { maxDuration: 15 };

const STATUS = { BAD_INTENT: 400, BAD_AMOUNT: 400, BAD_PIN: 400, NOT_FOUND: 404, EXPIRED: 410, LOCKED: 429, WRONG_PIN: 401, PIN_LOCKED: 423, PIN_RESET_NEEDED: 423, PIN_NOT_SET: 423, NO_PROOF_SECRET: 503, PIN_CHECK_FAILED: 503 };

export function createPinHandler(depsOverride = null) {
  return async function handler(req, res) {
    const deps = depsOverride || (await appDeps());
    const g = await gate(req, res, deps, { methods: ['POST'] });
    if (!g) return undefined;
    const b = req.body || {};
    const out = await pinStepUp(deps, {
      account: g.session.account,
      factor: g.session.factor,
      purpose: String(b.purpose || ''),
      intentId: String(b.intentId || ''),
      amountCents: intOf(b.amountCents),
      pin: typeof b.pin === 'string' ? b.pin : '',
      ip: g.ip,
    });
    return reply(res, out.ok ? out : { ...out, status: STATUS[out.error] || 400 });
  };
}

export default createPinHandler();
