/**
 * GET /api/health — liveness probe, public.
 *
 * ?config=1 additionally reports deployment CONFIG PRESENCE — booleans and
 * non-secret public URLs only, never values — so "are the OTT vars live in
 * Vercel?" is answerable without dashboard screenshots.
 *
 * FAIL CLOSED: the block exists only when WAPAY_INTERNAL_API_KEY is set AND
 * the x-internal-api-key header matches. (internal-auth's fail-open exists
 * so money routes keep working before the secret lands; nothing depends on
 * this block, so it gets the strict default — QA 2026-08-22.)
 */

import crypto from 'crypto';

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export default function handler(req, res) {
  const body = {
    ok: true,
    message: 'WaPay Health Check - Working!',
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.url,
  };

  if (req.query?.config === '1') {
    const secret = process.env.WAPAY_INTERNAL_API_KEY || '';
    const presented = req.headers['x-internal-api-key'];
    const authorized =
      Boolean(secret) && typeof presented === 'string' && timingSafeEqualStr(presented, secret);

    if (authorized) {
      const has = (name) => Boolean(process.env[name]);
      body.config = {
        // OTT voucher issuing (all four required; vendor code defaults to 11).
        ott: has('OTT_BASE_URL') && has('OTT_API_USERNAME') && has('OTT_API_KEY') && has('OTT_API_PASSWORD'),
        ottVendorCode: has('OTT_VENDOR_CODE'),
        // PayFast deposits + payment-request card leg.
        payfast: has('PAYFAST_MERCHANT_ID') && has('PAYFAST_MERCHANT_KEY') && has('PAYFAST_PASSPHRASE'),
        // Orchestrator.
        openai: has('OPENAI_API_KEY'),
        // WhatsApp webhook signature + sends.
        metaAppSecret: has('META_APP_SECRET'),
        whatsappToken: has('META_WHATSAPP_TOKEN') || has('WHATSAPP_ACCESS_TOKEN'),
        // Link bases are public-facing URLs, not secrets.
        appBaseUrl: process.env.APP_BASE_URL || null,
        paylinkBaseUrl: process.env.PAYLINK_BASE_URL || null,
        payerReceiptTemplate: has('WAPAY_TEMPLATE_PAYMENT_RECEIPT'),
      };
    }
  }

  res.status(200).json(body);
}
