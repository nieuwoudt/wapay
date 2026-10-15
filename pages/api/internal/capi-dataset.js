/**
 * One-off, server-side: the Conversions API dataset for the WhatsApp Business
 * Account (2026-10-15, Meta Ads agent's step 2), so the Growth token never
 * leaves Vercel. Reads GET /{WABA}/dataset first; only when nothing is linked
 * does it POST /{WABA}/dataset (Meta's own idempotent create: a second call
 * returns the same id). Returns the dataset id for META_CAPI_DATASET_ID.
 *
 * Gates: x-internal-api-key, POST only, Vercel production only. The token is
 * capiConfig().token (META_CAPI_ACCESS_TOKEN, else the Growth token in
 * META_ADS_ACCESS_TOKEN); the WABA is capiConfig().wabaId. Everything that
 * leaves passes through redactToken.
 *
 *   curl -X POST -H "x-internal-api-key: $KEY" https://wapay-api.vercel.app/api/internal/capi-dataset
 */
import crypto from 'node:crypto';
import { capiConfig, GRAPH } from '../../../lib/meta-capi.js';
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

async function graph(method, path, token) {
  const url = new URL(`${GRAPH}/${path}`);
  url.searchParams.set('access_token', token);
  let res;
  try {
    res = await fetch(url, { method, signal: AbortSignal.timeout(10000) });
  } catch (e) {
    return { http: null, error: { message: redactToken(String(e?.message || 'fetch failed')).slice(0, 200) } };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) {
    const er = body?.error || {};
    return { http: res.status, error: { code: er.code ?? null, subcode: er.error_subcode ?? null, type: er.type ?? null, message: redactToken(String(er.message || '')).slice(0, 300), fbtrace_id: er.fbtrace_id ?? null } };
  }
  return { http: res.status, data: body };
}

const datasetIdOf = (body) => (body?.id ? String(body.id) : body?.data?.[0]?.id ? String(body.data[0].id) : null);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!keyOk(req)) return res.status(401).json({ error: 'unauthorized' });
  if (process.env.VERCEL_ENV !== 'production') return res.status(403).json({ error: 'NOT_PRODUCTION', vercelEnv: process.env.VERCEL_ENV || null });

  const cfg = capiConfig();
  if (!cfg.token) return res.status(412).json({ error: 'TOKEN_MISSING', note: 'set META_CAPI_ACCESS_TOKEN or META_ADS_ACCESS_TOKEN' });
  if (!cfg.wabaId) return res.status(412).json({ error: 'WABA_MISSING', note: 'set WHATSAPP_BUSINESS_ACCOUNT_ID' });

  const existing = await graph('GET', `${cfg.wabaId}/dataset`, cfg.token);
  const existingId = existing.data ? datasetIdOf(existing.data) : null;
  const out = { checkedAt: new Date().toISOString(), wabaId: cfg.wabaId, tokenSource: cfg.tokenSource, read: existing.error ? existing : { http: existing.http, datasetId: existingId } };
  if (existingId) {
    out.datasetId = existingId;
    out.created = false;
    return res.status(200).send(redactToken(JSON.stringify(out)));
  }
  const created = await graph('POST', `${cfg.wabaId}/dataset`, cfg.token);
  out.create = created.error ? created : { http: created.http };
  out.datasetId = created.data ? datasetIdOf(created.data) : null;
  out.created = Boolean(out.datasetId);
  if (!out.datasetId) out.note = 'Meta returned no dataset id; see read/create for the error';
  return res.status(out.datasetId ? 200 : 502).send(redactToken(JSON.stringify(out)));
}
