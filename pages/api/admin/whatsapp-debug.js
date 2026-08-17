/**
 * GET  /api/admin/whatsapp-debug
 * POST /api/admin/whatsapp-debug
 *
 * Secure runtime debug endpoint for WhatsApp Cloud API config + send test.
 *
 * Auth:
 * - header: x-admin-key: ${ADMIN_API_KEY}
 * - or query: ?key=${ADMIN_API_KEY}
 *
 * GET returns masked environment info (no secrets).
 * POST can trigger a test text send:
 *   body: { "to": "27...", "text": "hello" }
 */
import { sendWhatsAppText } from '@wapay/whatsapp';

function isAuthed(req) {
  const adminKey = process.env.ADMIN_API_KEY;
  const keyFromHeader = req.headers['x-admin-key'];
  const keyFromQuery = req.query?.key;
  return Boolean(adminKey && (keyFromHeader === adminKey || keyFromQuery === adminKey));
}

function mask(value) {
  if (!value) return null;
  const str = String(value);
  if (str.length <= 4) return '****';
  return `…${str.slice(-4)}`;
}

export default async function handler(req, res) {
  if (!isAuthed(req)) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }

  const accessToken = process.env.META_WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || null;
  const phoneNumberId =
    process.env.META_WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || null;

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      env: process.env.VERCEL_ENV || process.env.NODE_ENV || null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
      whatsapp: {
        accessTokenPresent: Boolean(accessToken),
        accessTokenMasked: mask(accessToken),
        phoneNumberIdPresent: Boolean(phoneNumberId),
        phoneNumberId: phoneNumberId || null,
        verifyTokenPresent: Boolean(process.env.WHATSAPP_VERIFY_TOKEN || process.env.META_WEBHOOK_VERIFY_TOKEN),
      },
      webhook: {
        callbackPath: '/api/webhooks/whatsapp',
        verifyTestPath:
          '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=YOUR_VERIFY_TOKEN&hub.challenge=test123',
      },
      timestamp: new Date().toISOString(),
    });
  }

  if (req.method === 'POST') {
    const to = req.body?.to;
    const text = req.body?.text;

    if (!to || !text) {
      return res.status(400).json({ ok: false, error: 'MISSING_TO_OR_TEXT' });
    }

    console.log(
      '🧪 WA_DEBUG_SEND_REQUEST',
      JSON.stringify({
        to: String(to),
        textPreview: String(text).slice(0, 80),
        phoneNumberId,
        tokenMasked: mask(accessToken),
      })
    );

    const result = await sendWhatsAppText({ to: String(to), text: String(text) });
    return res.status(200).json({ ok: true, result });
  }

  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
}

