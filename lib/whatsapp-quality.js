/**
 * Meta's view of our number (2026-10-20, after the "sending spam" notice):
 * the quality rating, the messaging limit tier, the status, and whether the
 * business profile carries the support contact the Messaging Policy asks for.
 * One read a minute at most; the cron alerts ops when the rating is not GREEN.
 */
const GRAPH = 'https://graph.facebook.com/v21.0';
const CACHE_MS = 60 * 1000;
let cache = { at: 0, value: null };

export function qualityEnv(env = process.env) {
  return {
    token: env.META_WHATSAPP_TOKEN || env.WHATSAPP_ACCESS_TOKEN || '',
    phoneNumberId: env.META_WHATSAPP_PHONE_NUMBER_ID || env.WHATSAPP_PHONE_NUMBER_ID || '',
  };
}

export async function readWhatsAppQuality({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = 6000 } = {}) {
  if (cache.value && now - cache.at < CACHE_MS) return cache.value;
  const { token, phoneNumberId } = qualityEnv(env);
  if (!token || !phoneNumberId) return { configured: false, error: 'NOT_CONFIGURED', at: new Date(now).toISOString() };
  const get = async (path) => {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`${GRAPH}/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
      const body = await r.json().catch(() => ({}));
      return r.ok ? body : { error: body?.error?.message || `HTTP ${r.status}` };
    } finally { clearTimeout(t); }
  };
  let value;
  try {
    const [pn, prof] = await Promise.all([
      get(`${phoneNumberId}?fields=display_phone_number,quality_rating,messaging_limit_tier,status,name_status`),
      get(`${phoneNumberId}/whatsapp_business_profile?fields=about,email,websites,description`),
    ]);
    const profile = prof?.data?.[0] || {};
    value = {
      configured: true,
      qualityRating: pn?.quality_rating || null,
      messagingLimitTier: pn?.messaging_limit_tier || null,
      status: pn?.status || null,
      nameStatus: pn?.name_status || null,
      profile: { email: profile.email || null, websites: Array.isArray(profile.websites) ? profile.websites : [], about: profile.about || null, hasSupportContact: !!(profile.email || (Array.isArray(profile.websites) && profile.websites.length)) },
      error: pn?.error || prof?.error || null,
      at: new Date(now).toISOString(),
    };
  } catch (error) {
    value = { configured: true, qualityRating: null, error: String(error?.name === 'AbortError' ? 'TIMEOUT' : error?.message || 'ERROR').slice(0, 80), at: new Date(now).toISOString() };
  }
  cache = { at: now, value };
  return value;
}

export function qualityAlertText(q) {
  const rating = q?.qualityRating || 'unknown';
  return [
    `📵 WhatsApp quality rating ${rating}${q?.messagingLimitTier ? ` · messaging limit ${q.messagingLimitTier}` : ''}${q?.status ? ` · number ${q.status}` : ''}.`,
    rating === 'RED' ? 'Meta is reading blocks and reports on our number. No business-initiated messages until it is GREEN: reminders stay off, replies only, one message per turn.' : 'Keep business-initiated messages off until it is GREEN again.',
    q?.profile && !q.profile.hasSupportContact ? 'The business profile has no support e-mail or website: add them in WhatsApp Manager (the Messaging Policy asks for customer support contact information).' : '',
    'Check WhatsApp Manager, Account quality, for the reason and request a review there.',
  ].filter(Boolean).join('\n');
}

/** The daily check: read, alert ops once a day while the rating is not GREEN, return the reading. Never throws. */
export async function qualityCheck({ deps = {}, env = process.env, now = new Date() } = {}) {
  try {
    const q = await (deps.read || readWhatsAppQuality)({ env });
    const bad = q?.configured && q.qualityRating && q.qualityRating !== 'GREEN';
    let alerted = false;
    if (bad) {
      const text = qualityAlertText(q);
      const day = now.toISOString().slice(0, 10);
      const { opsPersonAlert } = deps.opsPersonAlert ? { opsPersonAlert: deps.opsPersonAlert } : await import('./ops-alerts.js');
      const { sendOpsAlert } = deps.sendOpsAlert ? { sendOpsAlert: deps.sendOpsAlert } : await import('./email.js');
      const [wa, mail] = await Promise.all([
        opsPersonAlert({ text, key: `wa-quality:${day}` }).catch(() => ({ sent: 0 })),
        sendOpsAlert({ subject: `WhatsApp quality rating ${q.qualityRating}`, detailsHtml: `<pre style="font-family:inherit;white-space:pre-wrap">${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>` }).catch(() => ({ success: false })),
      ]);
      alerted = !!((wa && wa.sent) || (mail && mail.success));
    }
    console.log(JSON.stringify({ type: 'whatsapp_quality', rating: q?.qualityRating || null, tier: q?.messagingLimitTier || null, status: q?.status || null, supportContact: q?.profile?.hasSupportContact ?? null, alerted, error: q?.error || null }));
    return { ...q, alerted };
  } catch (error) {
    console.error(JSON.stringify({ type: 'whatsapp_quality_failed', error: error?.message }));
    return { error: error?.message };
  }
}
