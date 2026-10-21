/**
 * WaPay personal portal: profile (2026-10-21).
 *
 * GET → name, cell, member since, language, KYC, saved pay-out details (labels), invite link
 * POST {action:'invite'}                        → the member's invite link (issued on this ask)
 * POST {action:'remove', id}                    → one saved destination removed
 * POST {action:'forget'}                        → every saved destination and the ID on file erased
 * POST {action:'nickname', id, nickname}        → a saved destination named
 * POST {action:'pin', currentPin, newPin, newPinAgain} → the PIN changed (current PIN through verifyPIN)
 * POST {action:'verify'}                        → a Didit identity-check link
 */
import { appDeps } from '../../../lib/app-deps.js';
import { appCookie, csrfCookie, csrfForSession, mintAppToken, pinFactorOf, pinSetAtOf } from '../../../lib/app-auth.js';
import { gate, reply, appOrigin } from '../../../lib/app-http.js';
import { profileView } from '../../../lib/app-portal.js';
import { issueInvite, removeDestination, forgetDetails, nameDestination, changePin, startKyc } from '../../../lib/app-money.js';

export const config = { maxDuration: 20 };

export function createProfileHandler(depsOverride = null) {
  return async function handler(req, res) {
    const deps = depsOverride || (await appDeps());
    const g = await gate(req, res, deps);
    if (!g) return undefined;
    const account = g.session.account;
    if (req.method === 'GET') return res.status(200).json({ ok: true, ...(await profileView(deps, account)) });
    const b = req.body || {};
    try {
      if (b.action === 'invite') return reply(res, await issueInvite(deps, { account }));
      if (b.action === 'remove') return reply(res, await removeDestination(deps, { account, id: b.id }));
      if (b.action === 'forget') return reply(res, await forgetDetails(deps, { account }));
      if (b.action === 'nickname') return reply(res, await nameDestination(deps, { account, id: b.id, nickname: b.nickname }));
      if (b.action === 'verify') return reply(res, await startKyc(deps, { account, origin: appOrigin(req) }));
      if (b.action === 'pin') {
        const out = await changePin(deps, { account, factor: g.session.factor, currentPin: typeof b.currentPin === 'string' ? b.currentPin : '', newPin: typeof b.newPin === 'string' ? b.newPin : '', newPinAgain: typeof b.newPinAgain === 'string' ? b.newPinAgain : '', ip: g.ip });
        if (!out.ok) return reply(res, out);
        // The PIN changed, so this session (bound to the old one) is replaced by a fresh one.
        const fresh = await deps.prisma.account.findUnique({ where: { id: account.id }, include: { authFactors: { where: { type: 'PIN' } } } });
        const setAt = pinSetAtOf(pinFactorOf(fresh));
        if (setAt != null) {
          const s = mintAppToken({ accountId: account.id, pinSetAt: setAt, now: deps.now() });
          const csrf = csrfForSession(s.sid);
          res.setHeader('Set-Cookie', [appCookie(s.token), csrfCookie(csrf)]);
          return res.status(200).json({ ok: true, csrf });
        }
        return res.status(200).json({ ok: true, relogin: true });
      }
      return res.status(400).json({ ok: false, error: 'ACTION' });
    } catch (error) {
      console.error(JSON.stringify({ type: 'app_profile_error', accountId: account.id, action: b.action, error: error?.message }));
      return res.status(500).json({ ok: false, error: 'TRY_AGAIN' });
    }
  };
}

export default createProfileHandler();
