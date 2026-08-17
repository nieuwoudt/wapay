/**
 * Internal API URL helper for server-side fetches.
 * Builds an absolute base URL from env or request host to avoid ERR_INVALID_URL.
 */
export function getBaseUrl(req) {
  const stripTrailing = (u) => u?.replace(/\/$/, '');

  if (process.env.APP_BASE_URL) return stripTrailing(process.env.APP_BASE_URL);
  if (process.env.NEXT_PUBLIC_APP_URL) return stripTrailing(process.env.NEXT_PUBLIC_APP_URL);
  if (process.env.VERCEL_URL) return stripTrailing(`https://${process.env.VERCEL_URL}`);
  if (req?.headers?.host) return stripTrailing(`https://${req.headers.host}`);

  throw new Error('No base URL available for internal fetch');
}

export function apiUrl(path, req) {
  const base = getBaseUrl(req);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

/**
 * Default internal fetch headers (JSON) plus optional Vercel protection bypass
 * and the internal API key (see lib/internal-auth.js).
 *
 * WARNING: these headers carry secrets — only ever send them to our OWN
 * routes (apiUrl(...)), never to third-party providers.
 */
export function internalJsonHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.VERCEL_PROTECTION_BYPASS_SECRET) {
    headers['x-vercel-protection-bypass'] = process.env.VERCEL_PROTECTION_BYPASS_SECRET;
  }
  if (process.env.WAPAY_INTERNAL_API_KEY) {
    headers['x-internal-api-key'] = process.env.WAPAY_INTERNAL_API_KEY;
  }
  return headers;
}

