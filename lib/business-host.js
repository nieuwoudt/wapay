/**
 * Where the WaPay for Business portal is allowed to live (2026-09-04), the
 * same shape as lib/admin-host.js for the admin console.
 *
 * Set WAPAY_BUSINESS_HOST (e.g. "business.wapay.co.za") in Vercel once that
 * domain is attached to the project. Then the /business PAGE serves ONLY on
 * that host (404 everywhere else — never advertised on the pay-link domains)
 * and the bare root of that host opens the portal. Unset = /business stays
 * reachable on every host, so nothing is locked out before the DNS exists.
 *
 * APIs (/api/*) are never host-restricted: they are session-gated and the
 * pay-link machinery must stay reachable on the app domain.
 */

/**
 * @param {object} a
 * @param {string} a.host          request host (may include :port)
 * @param {string} a.pathname
 * @param {string} [a.businessHost] WAPAY_BUSINESS_HOST, or empty/undefined
 * @returns {'rewrite'|'block'|'pass'}
 */
export function businessHostDecision({ host, pathname, businessHost }) {
  const configured = String(businessHost || '').trim().toLowerCase();
  if (!configured) return 'pass';
  const h = String(host || '').toLowerCase().split(':')[0];
  const onBusinessHost = h === configured;
  const isBusinessPage = pathname === '/business' || pathname.startsWith('/business/');

  if (onBusinessHost && pathname === '/') return 'rewrite'; // business.wapay.co.za/ → /business
  if (isBusinessPage && !onBusinessHost) return 'block';
  return 'pass';
}
