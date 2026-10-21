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
