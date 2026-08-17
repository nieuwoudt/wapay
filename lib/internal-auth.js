/**
 * Internal API authentication for server-to-server routes.
 *
 * The VAS preview/execute routes are only ever called by our own webhook
 * processor (internal self-fetch via lib/api-url.js), but they are deployed
 * as public Next.js API routes — so without a guard, ANY caller who finds
 * the URL can read wallet balances and meter-holder name/address.
 *
 * The guard: internal callers send x-internal-api-key (injected by
 * internalJsonHeaders() in lib/api-url.js) and it must match
 * process.env.WAPAY_INTERNAL_API_KEY.
 *
 * DEPLOY-SAFE FAIL-OPEN BY EXPLICIT DESIGN: if WAPAY_INTERNAL_API_KEY is not
 * configured in the environment, the guard allows all requests (and logs
 * internal_auth_unenforced once per cold start). This means deploying this
 * code before the env var is set does NOT break production traffic. Once the
 * var is set in the deployment environment, enforcement switches on for both
 * the routes (they require the header) and the callers (internalJsonHeaders
 * starts sending it) atomically on the next cold start.
 */

import crypto from 'crypto';

/** Module-level flag: log the unenforced warning once per cold start. */
let warnedUnenforced = false;

/**
 * Structured logging helper (matches the repo-wide pattern).
 */
function logStructured(type, data) {
  console.log(JSON.stringify({
    type,
    ...data,
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Constant-time string comparison. Length mismatch is a plain (fast) fail —
 * length is not secret here — but equal-length comparison never short-circuits.
 *
 * @param {string} provided
 * @param {string} expected
 * @returns {boolean}
 */
function constantTimeEquals(provided, expected) {
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Require the internal API key on a Next.js API request.
 *
 * Call as the FIRST check in a handler (after the method check). If it
 * returns false it has already written the 401 response — the handler must
 * return immediately without touching the DB or providers.
 *
 * @param {import('http').IncomingMessage & { url?: string, headers: Record<string, string|string[]|undefined> }} req
 * @param {{ status: (code: number) => { json: (body: object) => void } }} res
 * @returns {boolean} true if the request may proceed
 */
export function requireInternalAuth(req, res) {
  const expected = process.env.WAPAY_INTERNAL_API_KEY;

  if (!expected) {
    // Fail-open by explicit design (see module comment): the env var is not
    // configured yet, so we cannot enforce without breaking production.
    if (!warnedUnenforced) {
      warnedUnenforced = true;
      logStructured('internal_auth_unenforced', { path: req?.url });
    }
    return true;
  }

  const provided = req?.headers?.['x-internal-api-key'];

  if (typeof provided === 'string' && constantTimeEquals(provided, expected)) {
    return true;
  }

  logStructured('internal_auth_rejected', { path: req?.url });
  res.status(401).json({ error: 'AUTH', message: 'Unauthorized' });
  return false;
}
