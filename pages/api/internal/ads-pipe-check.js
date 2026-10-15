/**
 * Read-only check of the Meta ads pipe, for operators (2026-10-12). Runs
 * server-side with the production environment so the token never leaves
 * Vercel: env presence and whitespace, the account id as parsed, whose
 * token it is and what it may do, the ad account, the exact insights
 * request the Refresh button makes, the WhatsApp account the Conversions
 * API would name, whether a dataset is already linked, and the two gates on
 * sending. Internal-key gated (x-internal-api-key), GET only. Nothing here
 * creates, posts or sends anything: every Graph call is a GET.
 *
 *   curl -H "x-internal-api-key: $KEY" https://wapay-api.vercel.app/api/internal/ads-pipe-check
 */
import crypto from 'node:crypto';
import { adsConfig, insightsUrl, adsCatalogUrl, redactToken, isoDay, GRAPH } from '../../../lib/meta-ads.js';
import { capiConfig } from '../../../lib/meta-capi.js';

export const config = { maxDuration: 25 };

function keyOk(req) {
  const internalKey = process.env.WAPAY_INTERNAL_API_KEY || '';
  const presented = req.headers['x-internal-api-key'];
  if (!internalKey || typeof presented !== 'string' || !presented) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(internalKey).digest();
  return crypto.timingSafeEqual(a, b);
}

/** One GET against Graph; errors come back as data (code, subcode, message, fbtrace_id), never thrown. */
async function graph(pathOrUrl, token, params = {}) {
  const url = /^https?:/.test(pathOrUrl) ? new URL(pathOrUrl) : new URL(`${GRAPH}/${pathOrUrl}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (token && !url.searchParams.get('access_token')) url.searchParams.set('access_token', token);
  let res;
  try {
    res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(8000) });
  } catch (e) {
    return { http: null, error: { message: redactToken(String(e?.message || 'fetch failed')).slice(0, 200) } };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) {
    const er = body?.error || {};
    return {
      http: res.status,
      error: {
        code: er.code ?? null,
        subcode: er.error_subcode ?? null,
        type: er.type ?? null,
        message: redactToken(String(er.message || '')).slice(0, 300),
        fbtrace_id: er.fbtrace_id ?? null,
      },
    };
  }
  return { http: res.status, data: body };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!keyOk(req)) return res.status(401).json({ error: 'unauthorized' });

  const ads = adsConfig();
  const capi = capiConfig();
  const token = ads.token;
  const now = new Date();
  const since = isoDay(new Date(now.getTime() - 2 * 86400000));
  const until = isoDay(now);
  const expectedWaba = String(req.query.waba || '').replace(/\D/g, '') || null;

  const out = {
    checkedAt: now.toISOString(),
    vercelEnv: process.env.VERCEL_ENV || null,
    env: {
      META_ADS_ACCESS_TOKEN: { present: ads.tokenPresent, length: ads.tokenLength, hadWhitespace: ads.tokenHadWhitespace },
      META_AD_ACCOUNT_ID: { raw: ads.accountRaw ? redactToken(ads.accountRaw) : null, parsed: ads.accountId || null, hadActPrefix: ads.accountHadPrefix },
      META_CAPI_DATASET_ID: { present: capi.datasetPresent },
      META_CAPI_ACCESS_TOKEN: { present: Boolean(process.env.META_CAPI_ACCESS_TOKEN) },
      META_CAPI_TEST_EVENT_CODE: { present: Boolean(process.env.META_CAPI_TEST_EVENT_CODE) },
      META_WHATSAPP_BUSINESS_ACCOUNT_ID: { value: process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || null },
      WHATSAPP_BUSINESS_ACCOUNT_ID: { value: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || null },
    },
    adsConfigured: ads.configured,
    capi: { configured: capi.configured, reason: capi.reason, tokenSource: capi.tokenSource, wabaFromEnv: capi.wabaId || null },
    requests: {
      insights: redactToken(insightsUrl({ since, until })),
      catalog: redactToken(adsCatalogUrl()),
    },
  };

  if (!ads.tokenPresent) {
    out.note = 'META_ADS_ACCESS_TOKEN is not set in this environment; Graph checks skipped.';
    return res.status(200).json(out);
  }

  const wabaIds = [...new Set([capi.wabaId, expectedWaba].filter(Boolean))];
  const [me, perms, debug, account, insights, catalog, ...wabas] = await Promise.all([
    graph('me', token, { fields: 'id,name' }),
    graph('me/permissions', token),
    graph('debug_token', token, { input_token: token }),
    ads.accountId ? graph(`act_${ads.accountId}`, token, { fields: 'id,name,currency,timezone_name,account_status,disable_reason' }) : Promise.resolve({ skipped: 'no account id' }),
    ads.configured ? graph(insightsUrl({ since, until }), null) : Promise.resolve({ skipped: 'not configured' }),
    ads.configured ? graph(adsCatalogUrl(), null) : Promise.resolve({ skipped: 'not configured' }),
    ...wabaIds.flatMap((id) => [graph(id, token, { fields: 'id,name' }), graph(`${id}/dataset`, token)]),
  ]);

  out.identity = {
    me: me.data ? { id: me.data.id, name: me.data.name } : me,
    permissions: perms.data ? (perms.data.data || []).map((p) => `${p.permission}:${p.status}`) : perms,
    debugToken: debug.data?.data
      ? {
          app_id: debug.data.data.app_id ?? null,
          type: debug.data.data.type ?? null,
          is_valid: debug.data.data.is_valid ?? null,
          expires_at: debug.data.data.expires_at ?? null,
          data_access_expires_at: debug.data.data.data_access_expires_at ?? null,
          scopes: debug.data.data.scopes ?? null,
          user_id: debug.data.data.user_id ?? null,
        }
      : debug,
  };
  out.adAccount = account.data
    ? { id: account.data.id, name: account.data.name, currency: account.data.currency, timezone_name: account.data.timezone_name, account_status: account.data.account_status, disable_reason: account.data.disable_reason ?? null }
    : account;
  out.insights = insights.data
    ? { http: insights.http, rows: Array.isArray(insights.data.data) ? insights.data.data.length : null, hasPagingNext: Boolean(insights.data.paging?.next), range: { since, until } }
    : insights;
  out.catalog = catalog.data
    ? { http: catalog.http, ads: Array.isArray(catalog.data.data) ? catalog.data.data.length : null }
    : catalog;
  out.whatsapp = wabaIds.map((id, i) => {
    const info = wabas[i * 2], ds = wabas[i * 2 + 1];
    return {
      id,
      source: id !== capi.wabaId ? 'query waba='
        : process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID ? 'env META_WHATSAPP_BUSINESS_ACCOUNT_ID'
        : 'env WHATSAPP_BUSINESS_ACCOUNT_ID (fallback)',
      account: info.data ? { id: info.data.id, name: info.data.name } : info,
      dataset: ds.data ? (ds.data.id ? { id: ds.data.id } : ds.data) : ds,
    };
  });

  // Belt and braces: nothing that leaves carries a token.
  return res.status(200).send(redactToken(JSON.stringify(out)));
}
