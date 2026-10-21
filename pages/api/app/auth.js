/**
 * WaPay personal portal: sign-in (2026-10-21, lib/app-auth.js, lib/app-login.js).
 *
 * GET                                  → { configured, authed, csrf, me? } and the CSRF cookie
 * POST {action:'login', msisdn, pin}   → Set-Cookie wapay_app (and a CSRF token bound to it)
 * POST {action:'logout'}               → both cookies cleared
 *
 * Fails closed without a session secret. A wrong number and a wrong PIN answer
 * the same. Nothing here logs a PIN or a token.
 */
import { appDeps, devFixtureOn } from '../../../lib/app-deps.js';
import {
  appAuthConfigured, requireAppSession, csrfForSession, mintPreCsrf, preCsrfValid, readCookie, appCookie, clearAppCookie, csrfCookie, clearCsrfCookie,
  APP_CSRF_COOKIE, APP_COOKIE,
} from '../../../lib/app-auth.js';
import { gate, noStore } from '../../../lib/app-http.js';
import { appLogin } from '../../../lib/app-login.js';
import { bannerFor, displayNameOf, initialsOf, PIN_SAFETY_LINE, supportEmail } from '../../../lib/app-portal.js';

export const config = { maxDuration: 15 };

export function createAuthHandler(depsOverride = null) {
  return async function handler(req, res) {
    const deps = depsOverride || (await appDeps());
    if (req.method === 'GET') {
      noStore(res);
      const base = { banner: bannerFor(), pinSafety: PIN_SAFETY_LINE, supportEmail: supportEmail(), ...(devFixtureOn() ? { fixture: deps.fixture || null } : {}) };
      if (!appAuthConfigured()) return res.status(200).json({ configured: false, authed: false, ...base });
      const session = await requireAppSession(req, deps, deps.now()).catch(() => ({ ok: false }));
      if (session.ok) {
        const csrf = csrfForSession(session.sid);
        res.setHeader('Set-Cookie', csrfCookie(csrf));
        const name = displayNameOf(session.account);
        return res.status(200).json({ configured: true, authed: true, csrf, me: { firstName: name ? name.split(/\s+/)[0] : null, initials: initialsOf(name) }, ...base });
      }
      const existing = readCookie(req, APP_CSRF_COOKIE);
      const csrf = preCsrfValid(existing) ? existing : mintPreCsrf();
      // A session cookie that no longer opens anything (expired, or the PIN changed) is cleared here.
      res.setHeader('Set-Cookie', readCookie(req, APP_COOKIE) ? [csrfCookie(csrf), clearAppCookie()] : csrfCookie(csrf));
      return res.status(200).json({ configured: true, authed: false, csrf, ...base });
    }

    const action = req.body?.action;
    if (action === 'logout') {
      noStore(res);
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'METHOD' });
      // Logging out needs no valid session (an expired one must still clear), but it is still a same-site POST.
      const session = await requireAppSession(req, deps, deps.now()).catch(() => ({ ok: false }));
      const g = await gate(req, res, deps, { auth: session.ok, methods: ['POST'] });
      if (!g) return undefined;
      res.setHeader('Set-Cookie', [clearAppCookie(), clearCsrfCookie()]);
      return res.status(200).json({ ok: true });
    }

    const g = await gate(req, res, deps, { auth: false, methods: ['POST'] });
    if (!g) return undefined;
    if (action !== 'login') return res.status(400).json({ ok: false, error: 'ACTION' });
    const out = await appLogin(deps, { msisdn: req.body?.msisdn, pin: req.body?.pin, ip: g.ip });
    if (!out.ok) {
      const { status, account, token, sid, ...body } = out;
      return res.status(status || 401).json(body);
    }
    const csrf = csrfForSession(out.sid);
    res.setHeader('Set-Cookie', [appCookie(out.token), csrfCookie(csrf)]);
    console.log(JSON.stringify({ type: 'app_login', accountId: out.account.id }));
    return res.status(200).json({ ok: true, csrf });
  };
}

export default createAuthHandler();
