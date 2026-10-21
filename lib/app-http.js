/**
 * The personal portal's route plumbing (2026-10-21): one gate every
 * /api/app route goes through, in this order, before its own work:
 *   no-store headers → configured (fails closed) → the session (signed-in
 *   routes) → for a POST: same origin, the CSRF token, then the POST budget
 *   per IP and per account.
 * Nothing here reads a customer's money; it only decides whether a request
 * may go on.
 */
import { appAuthConfigured, requireAppSession, checkCsrf, postBudgetOk, clientIp } from './app-auth.js';

export function noStore(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
}

/** Send a library answer: its `status` becomes the HTTP status and stays out of the body. */
export function reply(res, out) {
  const { status, ...body } = out || {};
  return res.status(status || (body.ok ? 200 : 400)).json(body);
}

/**
 * @returns {Promise<null | { session: object|null, ip: string }>} null when the
 * gate has already answered (the route returns at once).
 */
export async function gate(req, res, deps, { auth = true, methods = ['GET', 'POST'] } = {}) {
  noStore(res);
  if (!methods.includes(req.method)) {
    res.setHeader('Allow', methods);
    res.status(405).json({ ok: false, error: 'METHOD' });
    return null;
  }
  if (!appAuthConfigured()) {
    res.status(503).json({ ok: false, error: 'NOT_CONFIGURED' });
    return null;
  }
  let session = null;
  if (auth) {
    session = await requireAppSession(req, deps, deps.now());
    if (!session.ok) {
      res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      return null;
    }
  }
  const ip = clientIp(req);
  if (req.method === 'POST') {
    const c = checkCsrf(req, session);
    if (!c.ok) {
      res.status(403).json({ ok: false, error: c.reason || 'CSRF' });
      return null;
    }
    if (!(await postBudgetOk(deps.limiter, { ip, accountId: session?.account?.id || null, now: deps.now() }))) {
      res.status(429).json({ ok: false, error: 'RATE_LIMITED' });
      return null;
    }
  }
  return { session, ip };
}

const hostOf = (u) => { try { return new URL(String(u)).host.toLowerCase(); } catch { return ''; } };

/**
 * The origin the customer is on, for return links (PayFast, Didit): only a
 * host that is ours (wapay.co.za and its subdomains, the Vercel app, the
 * configured base and app hosts, localhost in development); anything else
 * falls back to APP_BASE_URL.
 */
export function appOrigin(req, env = process.env) {
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim().toLowerCase();
  const bare = host.split(':')[0];
  const local = /^(localhost|127\.0\.0\.1)$/.test(bare);
  const ours = !!host && (
    /(^|\.)wapay\.co\.za$/.test(bare)
    || /\.vercel\.app$/.test(bare)
    || (local && env.NODE_ENV !== 'production')
    || host === hostOf(env.APP_BASE_URL)
    || host === String(env.WAPAY_APP_HOST || '').trim().toLowerCase()
  );
  if (ours) return `${local ? 'http' : 'https'}://${host}`;
  return String(env.APP_BASE_URL || '').replace(/\/+$/, '') || null;
}

/** A number from a JSON body: integers only (cents are integers everywhere). */
export function intOf(v) {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) ? n : NaN;
}
