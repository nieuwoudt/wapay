/**
 * WaPay personal portal: pay out (2026-10-21), through the chat's requestPayout (lib/payouts.js).
 *
 * GET                         → methods (live list, limits, fees), balance, saved destinations
 *                               (labels only), identity on file (last digits), KYC, the rules
 *                               note, the cool-off, a pending pay-out to resume after KYC
 * POST {action:'check', method, amountCents, destinationId? | details?, identity?}
 *                             → the quote, the destination label and the intent the PIN approves;
 *                               or the rule that stops it, in the chat's words
 * POST {action:'request', intentId, method, amountCents, destinationId? | details?, identity?, save?, nickname?, proof}
 *                             → the pay-out: proof first, then requestPayout (which checks it again)
 * POST {action:'kyc', pending?} → a Didit link that comes back to this screen
 * POST {action:'dismiss'}     → forget the pending pay-out
 *
 * A saved destination and the ID on file are decrypted only inside 'request',
 * at the moment of use. Answers carry labels and last digits, never a full number.
 */
import { appDeps } from '../../../lib/app-deps.js';
import { gate, reply, intOf, appOrigin } from '../../../lib/app-http.js';
import { payoutContext, payoutCheck, payoutRequest, startKyc } from '../../../lib/app-money.js';

export const config = { maxDuration: 45 };

const shape = (b) => ({
  method: String(b.method || '').toUpperCase(),
  amountCents: intOf(b.amountCents),
  destinationId: b.destinationId ? String(b.destinationId).slice(0, 64) : null,
  details: b.details && typeof b.details === 'object' ? { accountNumber: b.details.accountNumber, bank: b.details.bank, mobile: b.details.mobile, mine: b.details.mine === true } : null,
  identity: b.identity && typeof b.identity === 'object' ? { fullName: b.identity.fullName, idNumber: b.identity.idNumber, countryOfIssue: b.identity.countryOfIssue } : null,
});

export function createPayoutHandler(depsOverride = null) {
  return async function handler(req, res) {
    const deps = depsOverride || (await appDeps());
    const g = await gate(req, res, deps);
    if (!g) return undefined;
    const account = g.session.account;
    if (req.method === 'GET') {
      try {
        return res.status(200).json({ ok: true, ...(await payoutContext(deps, { account })) });
      } catch (error) {
        console.error(JSON.stringify({ type: 'app_payout_context_error', accountId: account.id, error: error?.message }));
        return res.status(500).json({ ok: false, error: 'TRY_AGAIN' });
      }
    }
    const b = req.body || {};
    try {
      if (b.action === 'check') return reply(res, await payoutCheck(deps, { account, ...shape(b) }));
      if (b.action === 'request') {
        const out = await payoutRequest(deps, { account, intentId: String(b.intentId || ''), ...shape(b), save: b.save === true, nickname: b.nickname || null, proof: b.proof, feeCents: intOf(b.feeCents) });
        console.log(JSON.stringify({ type: 'app_payout', accountId: account.id, ok: !!out.ok, payoutStatus: out.payoutStatus || null, error: out.error || null, reference: out.reference || null }));
        return reply(res, out);
      }
      if (b.action === 'kyc') {
        const pending = b.pending && typeof b.pending === 'object' ? { amountCents: intOf(b.pending.amountCents), method: String(b.pending.method || '').toUpperCase(), destinationId: b.pending.destinationId ? String(b.pending.destinationId).slice(0, 64) : null } : null;
        return reply(res, await startKyc(deps, { account, origin: appOrigin(req), pending }));
      }
      if (b.action === 'dismiss') {
        await deps.mergeProfileSubkey({ accountId: account.id, key: 'app', patch: { pendingPayout: null } }).catch(() => {});
        await deps.clearPendingWithdraw({ prisma: deps.prisma, accountId: account.id }).catch(() => {});
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'ACTION' });
    } catch (error) {
      console.error(JSON.stringify({ type: 'app_payout_error', accountId: account.id, action: b.action, error: error?.message }));
      return res.status(500).json({ ok: false, error: 'TRY_AGAIN', line: 'Something went wrong on our side. If money left your balance, Activity shows it; otherwise nothing was sent.' });
    }
  };
}

export default createPayoutHandler();
