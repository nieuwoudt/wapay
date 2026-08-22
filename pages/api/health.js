/**
 * GET /api/health — liveness probe, public.
 *
 * ?config=1 additionally reports deployment CONFIG PRESENCE — booleans and
 * non-secret public URLs only, never values — so "are the OTT vars live in
 * Vercel?" is answerable without dashboard screenshots.
 *
 * Access mirrors lib/internal-auth.js's explicit fail-open design: while
 * WAPAY_INTERNAL_API_KEY is unset the block is open (and says so); once the
 * secret is set, the x-internal-api-key header is required.
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
    const authorized = secret
      ? typeof presented === 'string' && timingSafeEqualStr(presented, secret)
      : true; // fail-open until the secret exists — same contract as internal-auth

    if (authorized) {
      const has = (name) => Boolean(process.env[name]);
      body.config = {
        guarded: Boolean(secret),
        // OTT voucher issuing (all four required; vendor code defaults to 11).
        ott: has('OTT_BASE_URL') && has('OTT_API_USERNAME') && has('OTT_API_KEY') && has('OTT_API_PASSWORD'),
        ottVendorCode: process.env.OTT_VENDOR_CODE || '(default 11)',
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
        payerReceiptTemplate: process.env.WAPAY_TEMPLATE_PAYMENT_RECEIPT || null,
      };
    }
  }

  res.status(200).json(body);
}
