/**
 * Where the personal portal opens by itself (2026-10-21). The portal lives at
 * /app on every host. Once the founder attaches a domain to the project for
 * it (for example app.wapay.co.za) and sets WAPAY_APP_HOST to that domain, the
 * bare root of that host goes to /app, so a customer who types the domain
 * lands on the log-in screen rather than the marketing page. Unset = nothing
 * changes anywhere. Nothing is ever blocked here: /app stays reachable on
 * every host, and APIs are never touched by the middleware.
 *
 * @param {object} a
 * @param {string} a.host       request host (may include :port)
 * @param {string} a.pathname
 * @param {string} [a.appHost]  WAPAY_APP_HOST, or empty/undefined
 * @returns {'redirect'|'pass'}
 */
export function appHostDecision({ host, pathname, appHost }) {
  const configured = String(appHost || '').trim().toLowerCase();
  if (!configured) return 'pass';
  const h = String(host || '').toLowerCase().split(':')[0];
  return h === configured && pathname === '/' ? 'redirect' : 'pass';
}

/**
 * The portal's own domain. app.wapay.co.za is the code default since
 * 2026-10-21 (DNS and the Vercel domain were set up that afternoon), so the
 * bare domain opens /app without an env change; WAPAY_APP_HOST overrides it
 * (any value), and WAPAY_APP_HOST=off disables the root redirect entirely.
 */
export const DEFAULT_APP_HOST = 'app.wapay.co.za';
export function configuredAppHost(env = process.env) {
  const raw = String(env.WAPAY_APP_HOST ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'none') return '';
  return raw || DEFAULT_APP_HOST;
}
