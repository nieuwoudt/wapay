/**
 * WhatsApp webhook security — signature verification and payload sanity.
 *
 * Meta signs every inbound POST with your App Secret as
 *   X-Hub-Signature-256: sha256=<hex hmac of the RAW request body>
 *
 * The current webhook verifies nothing, so anyone who learns the URL can POST
 * a forged "message" and drive a real money flow (voucher redeem, purchase)
 * against a victim's conversation. This closes that hole.
 *
 * IMPORTANT: the HMAC is over the EXACT raw bytes Meta sent. Next.js parses
 * the body by default, and JSON.parse+JSON.stringify does NOT round-trip to
 * the same bytes — so the route must read the raw body (see readRawBody) and
 * disable the built-in parser. verifySignature works on that raw string.
 */

import crypto from 'crypto';

/**
 * Constant-time verification of Meta's X-Hub-Signature-256 header.
 *
 * @param {string|Buffer} rawBody - the exact bytes received (not re-serialised)
 * @param {string} signatureHeader - value of the X-Hub-Signature-256 header
 * @param {string} appSecret - Meta App Secret (process.env.META_APP_SECRET)
 * @returns {boolean}
 */
export function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return false;
  if (typeof signatureHeader !== 'string') return false;

  // Header format is "sha256=<hex>". Reject anything else.
  const [scheme, provided] = signatureHeader.split('=');
  if (scheme !== 'sha256' || !provided) return false;

  const expected = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  // Both sides must be equal-length buffers for timingSafeEqual.
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || a.length === 0) return false;

  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Read the raw request body as a string from a Next.js API request.
 * Requires `export const config = { api: { bodyParser: false } }` on the route.
 */
export function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Decide whether to trust an inbound webhook.
 *
 * Signature enforcement can be turned off with WHATSAPP_VERIFY_SIGNATURE=false
 * for local testing ONLY — it must be on in production. When the secret is
 * present we always enforce, regardless of the flag, so a misconfiguration
 * fails closed rather than open.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkInboundWebhook({ rawBody, signatureHeader, appSecret, env = process.env }) {
  const explicitlyDisabled = env.WHATSAPP_VERIFY_SIGNATURE === 'false';
  const isProd = env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production';

  if (!appSecret) {
    // No secret configured. Fail closed in production, allow in dev with a warning.
    if (isProd) return { ok: false, reason: 'NO_APP_SECRET_IN_PROD' };
    return { ok: true, reason: 'NO_SECRET_DEV_BYPASS' };
  }

  if (explicitlyDisabled && !isProd) {
    return { ok: true, reason: 'SIGNATURE_CHECK_DISABLED_DEV' };
  }

  if (verifySignature(rawBody, signatureHeader, appSecret)) {
    return { ok: true };
  }
  return { ok: false, reason: 'BAD_SIGNATURE' };
}

/**
 * Pull the message id out of a parsed webhook body, for de-duplication.
 * Returns null when the payload carries no message (e.g. status callbacks).
 */
export function extractMessageId(parsedBody) {
  try {
    const change = parsedBody?.entry?.[0]?.changes?.[0];
    const msg = change?.value?.messages?.[0];
    return msg?.id ?? null;
  } catch {
    return null;
  }
}
