/**
 * Read-only Meta / WhatsApp Cloud API status for operators (written
 * 2026-09-06, the day inbound went silent): which app our token belongs to,
 * where Meta delivers that app's webhooks and whether they are active, whether
 * the app is still subscribed to OUR WABA, the phone number's state, and which
 * templates exist. Internal-key gated (x-internal-api-key), GET only. Nothing
 * here can send a message or change a setting, and no token ever leaves the
 * process (ids are masked, secrets are reported as present/absent).
 *
 *   curl -H "x-internal-api-key: $KEY" https://business.wapay.co.za/api/internal/meta-status
 */
import crypto from 'node:crypto';
import { getBaseUrl } from '../../../lib/api-url.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
export const config = { maxDuration: 25 };

function keyOk(req) {
  const internalKey = process.env.WAPAY_INTERNAL_API_KEY || '';
  const presented = req.headers['x-internal-api-key'];
  if (!internalKey || typeof presented !== 'string' || !presented) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(internalKey).digest();
  return crypto.timingSafeEqual(a, b);
}

/** One GET against Graph; errors come back as data, never thrown. */
async function graph(path, token, params = {}) {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token);
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (e) {
    return { error: { message: String(e?.message || 'fetch failed').slice(0, 200) } };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const er = body?.error || {};
    return { error: { status: res.status, code: er.code, subcode: er.error_subcode, type: er.type, message: String(er.message || '').slice(0, 240) } };
  }
  return body;
}

const mask = (s) => (s ? `${String(s).slice(0, 4)}…${String(s).slice(-3)}` : null);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!keyOk(req)) return res.status(401).json({ error: 'unauthorized' });

  const token = process.env.META_WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || '';
  const phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || '';
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '';
  const appSecret = process.env.META_APP_SECRET || '';

  const out = {
    checkedAt: new Date().toISOString(),
    build: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null,
    env: {
      token: !!token,
      phoneNumberId: mask(phoneNumberId),
      wabaId: mask(wabaId),
      appSecret: !!appSecret,
      verifyToken: !!(process.env.WHATSAPP_VERIFY_TOKEN || process.env.META_WEBHOOK_VERIFY_TOKEN),
      appBaseUrl: getBaseUrl(req),
      paylinkBaseUrl: process.env.PAYLINK_BASE_URL || null,
      businessHost: process.env.WAPAY_BUSINESS_HOST || null,
      adminHost: process.env.WAPAY_ADMIN_HOST || null,
    },
  };
  if (!token) return res.status(200).json({ ...out, error: 'no WhatsApp token in this deployment' });

  // 1. Which app does the token belong to? (/app is the token's own app node;
  //    debug_token is the fallback for token types that cannot read /app.)
  let appId = null;
  const app = await graph('app', token, { fields: 'id,name' });
  if (!app.error && app.id) { appId = app.id; out.app = { id: mask(app.id), name: app.name }; }
  else {
    const dbg = await graph('debug_token', token, { input_token: token });
    appId = dbg?.data?.app_id || null;
    out.app = dbg.error ? { error: app.error, debugError: dbg.error } : { id: mask(appId), name: dbg.data?.application, tokenType: dbg.data?.type, tokenExpiresAt: dbg.data?.expires_at ? new Date(dbg.data.expires_at * 1000).toISOString() : 'never', scopes: dbg.data?.scopes };
  }

  // 2. The app's webhook subscriptions: callback URL, active flag, fields.
  //    Needs the APP token (id|secret), which is why META_APP_SECRET matters here.
  if (appId && appSecret) {
    const subs = await graph(`${appId}/subscriptions`, `${appId}|${appSecret}`);
    out.webhookSubscriptions = subs.error
      ? { error: subs.error }
      : (subs.data || []).map((s) => ({ object: s.object, callbackUrl: s.callback_url, active: s.active, fields: (s.fields || []).map((f) => (typeof f === 'string' ? f : f.name)) }));
  } else {
    out.webhookSubscriptions = { skipped: appId ? 'no META_APP_SECRET in this deployment' : 'app id unknown' };
  }

  // 3. Is the app subscribed to THIS WABA? (A per-WABA subscription is separate
  //    from the app-level one; losing it silences inbound without any error.)
  if (wabaId) {
    const sa = await graph(`${wabaId}/subscribed_apps`, token);
    out.wabaSubscribedApps = sa.error
      ? { error: sa.error }
      : (sa.data || []).map((a) => ({ appId: mask(a.whatsapp_business_api_data?.id), name: a.whatsapp_business_api_data?.name, overrideCallbackUri: a.override_callback_uri || null }));
    const waba = await graph(wabaId, token, { fields: 'id,name,account_review_status,business_verification_status' });
    out.waba = waba.error ? { error: waba.error } : { name: waba.name, accountReviewStatus: waba.account_review_status, businessVerificationStatus: waba.business_verification_status };
    const tpl = await graph(`${wabaId}/message_templates`, token, { fields: 'name,status,category,language', limit: '100' });
    out.templates = tpl.error ? { error: tpl.error } : (tpl.data || []).map((t) => ({ name: t.name, status: t.status, category: t.category, language: t.language }));
  } else {
    out.wabaSubscribedApps = { skipped: 'no WHATSAPP_BUSINESS_ACCOUNT_ID in this deployment' };
  }

  // 4. The phone number's state, then its own webhook override (separate call
  //    so an unsupported field can never blank the rest).
  if (phoneNumberId) {
    const pn = await graph(phoneNumberId, token, { fields: 'display_phone_number,verified_name,quality_rating,status,name_status,messaging_limit_tier,platform_type,throughput' });
    out.phone = pn.error
      ? { error: pn.error }
      : { displayPhoneNumber: pn.display_phone_number, verifiedName: pn.verified_name, qualityRating: pn.quality_rating, status: pn.status, nameStatus: pn.name_status, messagingLimitTier: pn.messaging_limit_tier, platformType: pn.platform_type, throughput: pn.throughput?.level || pn.throughput || null };
    const wh = await graph(phoneNumberId, token, { fields: 'webhook_configuration' });
    out.phoneWebhookOverride = wh.error ? { error: wh.error } : (wh.webhook_configuration || null);
  } else {
    out.phone = { skipped: 'no phone number id in this deployment' };
  }

  return res.status(200).json(out);
}
