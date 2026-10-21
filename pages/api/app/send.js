/**
 * WaPay personal portal: send money (2026-10-21), through the chat's ledger send (lib/send-money.js).
 *
 * GET                                          → the limits and the rule line
 * POST {action:'preview', msisdn, amountCents} → { previewId, amountCents, feeCents, totalCents, recipient, lines }
 * POST {action:'execute', previewId, proof}    → { amountCents, newBalanceCents, lines }
 *
 * A member is paid at once, anyone else's money is held until they join and
 * comes back after 30 days; the sender reads the same words either way and the
 * answer never says which it was. Execute checks the PIN proof for this
 * preview and amount before the claim, and sendMoney checks it again.
 */
import { appDeps } from '../../../lib/app-deps.js';
import { gate, reply, intOf } from '../../../lib/app-http.js';
import { balancesOf, sendRuleLine } from '../../../lib/app-portal.js';
import { sendPreview, sendExecute } from '../../../lib/app-money.js';
import { SEND_MIN_CENTS, SEND_MAX_CENTS } from '../../../lib/send-money.js';

export const config = { maxDuration: 20 };

export function createSendHandler(depsOverride = null) {
  return async function handler(req, res) {
    const deps = depsOverride || (await appDeps());
    const g = await gate(req, res, deps);
    if (!g) return undefined;
    const account = g.session.account;
    if (req.method === 'GET') {
      const balance = await balancesOf(deps, account.id);
      return res.status(200).json({ ok: true, minCents: SEND_MIN_CENTS, maxCents: SEND_MAX_CENTS, ruleLine: sendRuleLine(), balance });
    }
    const b = req.body || {};
    try {
      if (b.action === 'preview') return reply(res, await sendPreview(deps, { account, msisdn: b.msisdn, amountCents: intOf(b.amountCents) }));
      if (b.action === 'execute') return reply(res, await sendExecute(deps, { account, previewId: b.previewId, proof: b.proof }));
      return res.status(400).json({ ok: false, error: 'ACTION' });
    } catch (error) {
      console.error(JSON.stringify({ type: 'app_send_error', accountId: account.id, action: b.action, error: error?.message }));
      return res.status(500).json({ ok: false, error: 'TRY_AGAIN', line: 'Something went wrong; nothing was sent. Please try again.' });
    }
  };
}

export default createSendHandler();
