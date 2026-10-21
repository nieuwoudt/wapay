/**
 * WaPay personal portal: forgot PIN, with the ID number on file (2026-10-21, lib/app-login.js).
 *
 * POST {action:'check', msisdn, idNumber}       → { resetToken } on a match; one answer for every miss
 * POST {action:'reset', resetToken, pin, pinAgain} → the PIN reset, the cool-off, and a session
 *
 * No WhatsApp message is needed or sent. Pre-session CSRF; per-number and
 * per-IP limits; three wrong ID numbers in 24 hours pause resets.
 */
import { appDeps } from '../../../lib/app-deps.js';
import { appCookie, csrfCookie, csrfForSession } from '../../../lib/app-auth.js';
import { gate } from '../../../lib/app-http.js';
import { forgotCheck, forgotReset } from '../../../lib/app-login.js';

export const config = { maxDuration: 15 };

export function createForgotHandler(depsOverride = null) {
  return async function handler(req, res) {
    const deps = depsOverride || (await appDeps());
    const g = await gate(req, res, deps, { auth: false, methods: ['POST'] });
    if (!g) return undefined;
    const body = req.body || {};
    if (body.action === 'check') {
      const out = await forgotCheck(deps, { msisdn: body.msisdn, idNumber: body.idNumber, ip: g.ip });
      const { status, ...rest } = out;
      return res.status(status || 200).json(rest);
    }
    if (body.action === 'reset') {
      const out = await forgotReset(deps, { resetToken: body.resetToken, pin: body.pin, pinAgain: body.pinAgain });
      const { status, token, sid, ...rest } = out;
      if (out.ok && token && sid) {
        const csrf = csrfForSession(sid);
        res.setHeader('Set-Cookie', [appCookie(token), csrfCookie(csrf)]);
        return res.status(200).json({ ...rest, csrf });
      }
      return res.status(status || 200).json(rest);
    }
    return res.status(400).json({ ok: false, error: 'ACTION' });
  };
}

export default createForgotHandler();
