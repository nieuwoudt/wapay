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

