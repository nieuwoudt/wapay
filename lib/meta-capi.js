/**
 * Meta Conversions API for Business Messaging (2026-10-10).
 *
 * Sends what happened AFTER a click-to-WhatsApp ad back to Meta, so ad
 * delivery can optimise for funded accounts instead of started chats. Meta's
 * own doc (Conversions API for Business Messaging, read 2026-09-15): purchase
 * optimisation covers ads that click to WhatsApp and Messenger only, the
 * event list has no CompleteRegistration or Lead, and the identifiers for
 * WhatsApp are the WABA id plus the `ctwa_clid` from the webhook's referral.
 *
 * Events WaPay sends, once each per account:
 *   LeadSubmitted  - onboarding complete (OTP, PIN, consent)
 *   QualifiedLead  - first payment link created
 *   Purchase       - first money in (value = that first credit, ZAR)
 *
 * OFF until META_CAPI_DATASET_ID is set (the token falls back to the
 * WhatsApp token, which needs whatsapp_business_manage_events). Every call
 * is bounded by a timeout and never throws: a Meta outage must never slow
 * a customer's turn.
 */

const GRAPH = 'https://graph.facebook.com/v21.0';
export const CAPI_EVENTS = Object.freeze({ LEAD: 'LeadSubmitted', QUALIFIED: 'QualifiedLead', PURCHASE: 'Purchase' });

export function capiConfig(env = process.env) {
  const datasetId = String(env.META_CAPI_DATASET_ID || '').trim();
  const token = String(env.META_CAPI_ACCESS_TOKEN || env.META_WHATSAPP_TOKEN || '').trim();
  const wabaId = String(env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || '').trim();
  const testEventCode = String(env.META_CAPI_TEST_EVENT_CODE || '').trim() || null;
  return { datasetId, token, wabaId, testEventCode, configured: Boolean(datasetId && token && wabaId) };
}
export function capiConfigured(env = process.env) {
  return capiConfig(env).configured;
}

/**
 * One business-messaging event in Meta's shape. Pure.
 * @param {object} a
 * @param {string} a.eventName one of CAPI_EVENTS
 * @param {Date|number} a.eventTime when it happened (sent as unix seconds; Meta accepts up to 7 days back)
 * @param {string} a.ctwaClid the click id from the webhook referral
 * @param {string} a.wabaId WhatsApp Business Account id
 * @param {string} a.eventId dedupe key, e.g. `${accountId}:${eventName}`
 * @param {number} [a.valueCents] Purchase value in cents
 */
export function buildBusinessMessagingEvent({ eventName, eventTime, ctwaClid, wabaId, eventId, valueCents }) {
  if (!eventName || !ctwaClid || !wabaId) throw new Error('CAPI event needs eventName, ctwaClid and wabaId');
  const ts = eventTime instanceof Date ? Math.floor(eventTime.getTime() / 1000) : Math.floor(Number(eventTime) / (eventTime > 1e12 ? 1000 : 1));
  const event = {
    event_name: eventName,
    event_time: ts,
    event_id: eventId,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: { whatsapp_business_account_id: String(wabaId), ctwa_clid: String(ctwaClid) },
  };
  if (valueCents !== undefined && valueCents !== null) {
    event.custom_data = { currency: 'ZAR', value: Math.round(valueCents) / 100 };
  }
  return event;
}

/**
 * POST events to the dataset. Never throws; returns { ok, status, body, skipped }.
 * `fetchImpl` is a test seam.
 */
export async function sendCapiEvents(events, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 2500 } = {}) {
  const cfg = capiConfig(env);
  if (!cfg.configured) return { ok: false, skipped: 'NOT_CONFIGURED' };
  if (!Array.isArray(events) || events.length === 0) return { ok: true, sent: 0 };
  const body = { data: events };
  if (cfg.testEventCode) body.test_event_code = cfg.testEventCode;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(`${GRAPH}/${encodeURIComponent(cfg.datasetId)}/events?access_token=${encodeURIComponent(cfg.token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    const ok = res.ok && !(json && json.error);
    if (!ok) console.error(JSON.stringify({ type: 'capi_send_failed', status: res.status, error: json?.error?.message || null }));
    return { ok, status: res.status, body: json, sent: ok ? events.length : 0 };
  } catch (error) {
    console.error(JSON.stringify({ type: 'capi_send_error', error: error?.name === 'AbortError' ? 'timeout' : error?.message }));
    return { ok: false, error: error?.name === 'AbortError' ? 'timeout' : error?.message || 'send failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
