/**
 * One synthetic Conversions API event through the real sender (2026-10-15,
 * Meta Ads agent's step 3): proves the dataset, the token's permissions and
 * the payload shape before any ad spend, instead of waiting for a real click.
 * A made-up click id may be refused by Meta; the exact error is returned
 * because that tells us something too.
 *
 * Gates, all required: x-internal-api-key, POST only, Vercel production only,
 * a test event code, and the Conversions API configured (dataset id present).
 * The code comes from the POST body ({ "testEventCode": "TEST…" }, option B
 * agreed with the Meta Ads agent 2026-10-15) or, failing that, from
 * META_CAPI_TEST_EVENT_CODE; it is used for this one send, never logged and
 * never stored, and the sender attaches it so the event lands in Events
 * Manager's Test Events and never in reporting. Touches no customer: the
 * event is LeadSubmitted with a synthetic click id and is never marked on a
 * profile. Meta's full response comes back, redacted.
 *
 *   curl -X POST -H "x-internal-api-key: $KEY" -H "Content-Type: application/json" \
 *     -d '{"testEventCode":"TEST12345"}' https://wapay-api.vercel.app/api/internal/capi-test-send
 */
import crypto from 'node:crypto';
import { capiConfig, buildBusinessMessagingEvent, sendCapiEvents, CAPI_EVENTS } from '../../../lib/meta-capi.js';
import { redactToken } from '../../../lib/meta-ads.js';

export const config = { maxDuration: 25 };

function keyOk(req) {
  const internalKey = process.env.WAPAY_INTERNAL_API_KEY || '';
  const presented = req.headers['x-internal-api-key'];
  if (!internalKey || typeof presented !== 'string' || !presented) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(internalKey).digest();
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!keyOk(req)) return res.status(401).json({ error: 'unauthorized' });
  if (process.env.VERCEL_ENV !== 'production') return res.status(403).json({ error: 'NOT_PRODUCTION', vercelEnv: process.env.VERCEL_ENV || null });

  const cfg = capiConfig();
  const bodyCode = typeof req.body === 'object' && req.body ? String(req.body.testEventCode || '').trim() : '';
  const code = bodyCode || cfg.testEventCode || '';
  if (!code) return res.status(412).json({ error: 'TEST_CODE_MISSING', note: 'send { "testEventCode": "TEST…" } from Events Manager → Test events in the POST body (or set META_CAPI_TEST_EVENT_CODE); this route never sends without one' });
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(code)) return res.status(400).json({ error: 'TEST_CODE_SHAPE', note: 'a test event code is letters and digits, 4 to 40 characters' });
  if (!cfg.configured) return res.status(412).json({ error: cfg.reason, note: 'the Conversions API is not configured; nothing was sent' });

  const stamp = Date.now().toString(36);
  const event = buildBusinessMessagingEvent({
    eventName: CAPI_EVENTS.LEAD,
    eventTime: new Date(),
    ctwaClid: `wapay-test-${stamp}`,
    wabaId: cfg.wabaId,
    eventId: `test:${stamp}`,
  });
  const sent = await sendCapiEvents([event], { timeoutMs: 10000, testEventCode: code });
  const out = {
    sentAt: new Date().toISOString(),
    datasetPresent: cfg.datasetPresent,
    tokenSource: cfg.tokenSource,
    wabaId: cfg.wabaId,
    testEventCode: bodyCode ? 'body' : 'env',
    event,
    ok: Boolean(sent.ok),
    http: sent.status ?? null,
    meta: sent.body ?? null,
    error: sent.error ?? sent.skipped ?? null,
  };
  return res.status(sent.ok ? 200 : 502).send(redactToken(JSON.stringify(out)));
}
