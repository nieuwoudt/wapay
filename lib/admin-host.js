/**
 * Where the admin console is allowed to live (founder 2026-08-28: the console
 * must be on a wapay.co.za domain, not the pleasepayme.co.za pay domain).
 *
 * Set WAPAY_ADMIN_HOST (e.g. "admin.wapay.co.za") in Vercel once that domain
 * is attached to the project. Then the /admin PAGE serves ONLY on that host
 * (404 everywhere else), and the bare root of that host redirects to /admin
 * for convenience. Leaving WAPAY_ADMIN_HOST unset keeps /admin reachable on
 * every host, so nothing is ever locked out before the DNS is ready.
 *
 * APIs (/api/*) are intentionally NOT host-restricted here — they are all
 * auth-gated (401 without a session/internal-key) and the Didit webhook must
 * stay reachable. This only governs the human-facing page.
 */

/**
 * @param {object} a
 * @param {string} a.host        request host (may include :port)
 * @param {string} a.pathname
 * @param {string} [a.adminHost] WAPAY_ADMIN_HOST, or empty/undefined
 * @returns {'rewrite'|'block'|'pass'}
 */
export function adminHostDecision({ host, pathname, adminHost }) {
  const configured = String(adminHost || '').trim().toLowerCase();
  if (!configured) return 'pass'; // no restriction until the founder sets it
  const h = String(host || '').toLowerCase().split(':')[0];
  const onAdminHost = h === configured;
  const isAdminPage = pathname === '/admin' || pathname.startsWith('/admin/');

  if (onAdminHost && pathname === '/') return 'rewrite'; // admin.wapay.co.za/ → /admin
  if (isAdminPage && !onAdminHost) return 'block'; // /admin only on the admin host
  return 'pass';
}
