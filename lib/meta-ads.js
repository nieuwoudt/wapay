/**
 * Meta Marketing API — the ad account's daily numbers, read into WaPay
 * (2026-10-10). Spend, impressions, clicks and "messaging conversations
 * started" per ad per day, snapshotted into `ad_insights_daily`, plus the
 * ad catalogue (names, campaign, headline) into `ad_catalog` so an ad id on
 * an account can be shown as the hook that brought the person in.
 *
 * OFF until META_ADS_ACCESS_TOKEN (a System User token with ads_read on the
 * account) and META_AD_ACCOUNT_ID (digits, with or without the act_ prefix)
 * are set. Read-only against Meta; never throws out of the snapshot (the
 * daily cron and the Growth tab call it best-effort). The token is read here
 * and nowhere else; `redactToken` scrubs it from anything that is reported.
 */

export const GRAPH = 'https://graph.facebook.com/v21.0';
const INSIGHT_FIELDS = [
  'ad_id', 'ad_name', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name',
  'spend', 'impressions', 'reach', 'clicks', 'inline_link_clicks', 'actions', 'cost_per_action_type',
];
// Meta's action types for messaging ads. The 7d variant is Meta's definition
// of a started conversation (a person who had not messaged in a week).
export const CONVERSATION_ACTION = 'onsite_conversion.messaging_conversation_started_7d';
export const CONNECTION_ACTION = 'onsite_conversion.total_messaging_connection';

export function adsConfig(env = process.env) {
  const rawToken = env.META_ADS_ACCESS_TOKEN == null ? '' : String(env.META_ADS_ACCESS_TOKEN);
  const token = rawToken.trim();
  const rawAccount = env.META_AD_ACCOUNT_ID == null ? '' : String(env.META_AD_ACCOUNT_ID);
  const accountId = rawAccount.trim().replace(/^act_/, '');
  return {
    token,
    accountId,
    configured: Boolean(token && /^\d+$/.test(accountId)),
    // Reported by the pipe check, never the values themselves.
    tokenPresent: Boolean(token),
    tokenLength: token.length,
    tokenHadWhitespace: rawToken !== token,
    accountRaw: rawAccount,
    accountHadPrefix: /^act_/.test(rawAccount.trim()),
  };
}
export function adsConfigured(env = process.env) {
  return adsConfig(env).configured;
}

/** Scrub the token and any access_token query value from text that leaves the process. */
export function redactToken(text, env = process.env) {
  let s = String(text == null ? '' : text);
  const { token } = adsConfig(env);
  if (token) s = s.split(token).join('[redacted]');
  const other = env.META_CAPI_ACCESS_TOKEN ? String(env.META_CAPI_ACCESS_TOKEN).trim() : '';
  if (other) s = s.split(other).join('[redacted]');
  const wa = env.META_WHATSAPP_TOKEN ? String(env.META_WHATSAPP_TOKEN).trim() : '';
  if (wa) s = s.split(wa).join('[redacted]');
  return s.replace(/access_token=[^&\s"']+/g, 'access_token=[redacted]');
}

/** The exact insights request the snapshot (and the Refresh button) makes. */
export function insightsUrl({ since, until, env = process.env } = {}) {
  const cfg = adsConfig(env);
  const params = new URLSearchParams({
    level: 'ad',
    time_increment: '1',
    time_range: JSON.stringify({ since, until }),
    fields: INSIGHT_FIELDS.join(','),
    limit: '500',
    access_token: cfg.token,
  });
  return `${GRAPH}/act_${cfg.accountId}/insights?${params}`;
}
/** The exact ads-catalogue request the snapshot makes. */
export function adsCatalogUrl({ env = process.env } = {}) {
  const cfg = adsConfig(env);
  const params = new URLSearchParams({
    fields: 'id,name,status,effective_status,adset{id,name},campaign{id,name,objective},creative{title,body,object_story_spec}',
    limit: '200',
    access_token: cfg.token,
  });
  return `${GRAPH}/act_${cfg.accountId}/ads?${params}`;
}

function actionValue(actions, type) {
  if (!Array.isArray(actions)) return 0;
  const hit = actions.find((a) => a && a.action_type === type);
  return hit ? Number(hit.value || 0) : 0;
}
function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** One insights row (level=ad, time_increment=1) → our daily shape. Pure. */
export function parseInsightRow(row) {
  if (!row || !row.ad_id) return null;
  return {
    adId: String(row.ad_id),
    date: String(row.date_start || row.date_stop || '').slice(0, 10),
    adName: row.ad_name || null,
    adsetId: row.adset_id ? String(row.adset_id) : null,
    adsetName: row.adset_name || null,
    campaignId: row.campaign_id ? String(row.campaign_id) : null,
    campaignName: row.campaign_name || null,
    spendCents: Math.round(Number(row.spend || 0) * 100),
    impressions: toInt(row.impressions),
    reach: toInt(row.reach),
    clicks: toInt(row.clicks),
    linkClicks: toInt(row.inline_link_clicks),
    conversations: toInt(actionValue(row.actions, CONVERSATION_ACTION)),
    connections: toInt(actionValue(row.actions, CONNECTION_ACTION)),
    raw: { actions: row.actions || null, cost_per_action_type: row.cost_per_action_type || null },
  };
}

/** The ads edge → catalogue rows. Pure. */
export function parseAdRow(ad) {
  if (!ad || !ad.id) return null;
  const spec = ad.creative?.object_story_spec || {};
  const link = spec.link_data || spec.video_data || {};
  return {
    adId: String(ad.id),
    name: ad.name || null,
    status: ad.effective_status || ad.status || null,
    adsetId: ad.adset?.id ? String(ad.adset.id) : null,
    adsetName: ad.adset?.name || null,
    campaignId: ad.campaign?.id ? String(ad.campaign.id) : null,
    campaignName: ad.campaign?.name || null,
    objective: ad.campaign?.objective || null,
    headline: ad.creative?.title || link.name || null,
    body: ad.creative?.body || link.message || null,
  };
}

async function graphGet(url, { fetchImpl, timeoutMs, env = process.env }) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, { signal: controller ? controller.signal : undefined });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.error) {
      const err = new Error(redactToken(json?.error?.message || `Graph ${res.status}`, env));
      err.code = json?.error?.code || res.status;
      err.subcode = json?.error?.error_subcode;
      err.fbtrace = json?.error?.fbtrace_id;
      throw err;
    }
    return json;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Follow Meta's paging.next until done (bounded). */
async function pageAll(firstUrl, { fetchImpl, timeoutMs, maxPages = 20, env }) {
  const out = [];
  let url = firstUrl;
  for (let n = 0; url && n < maxPages; n++) {
    const json = await graphGet(url, { fetchImpl, timeoutMs, env });
    if (Array.isArray(json.data)) out.push(...json.data);
    url = json.paging?.next || null;
  }
  return out;
}

export function isoDay(d) {
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Daily per-ad insights for [since, until] (YYYY-MM-DD, inclusive).
 * @returns {Promise<object[]>} parsed rows
 */
export async function fetchAdInsights({ since, until, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (!adsConfig(env).configured) return [];
  const rows = await pageAll(insightsUrl({ since, until, env }), { fetchImpl, timeoutMs, env });
  return rows.map(parseInsightRow).filter(Boolean);
}

/** The account's ads with campaign and creative text. */
export async function fetchAdCatalog({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (!adsConfig(env).configured) return [];
  const rows = await pageAll(adsCatalogUrl({ env }), { fetchImpl, timeoutMs, env });
  return rows.map(parseAdRow).filter(Boolean);
}

/**
 * Pull the last `days` days (default 3, so late-arriving conversions update)
 * and upsert into ad_insights_daily + ad_catalog. Never throws.
 */
export async function snapshotAdInsights({ prisma, days = 3, now = new Date(), env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const cfg = adsConfig(env);
  if (!cfg.configured) return { skipped: 'NOT_CONFIGURED', insights: 0, ads: 0 };
  const out = { insights: 0, ads: 0, errors: [] };
  try {
    const until = isoDay(now);
    const since = isoDay(new Date(now.getTime() - (days - 1) * 86400000));
    const rows = await fetchAdInsights({ since, until, env, fetchImpl });
    for (const r of rows) {
      if (!r.date) continue;
      const date = new Date(`${r.date}T00:00:00.000Z`);
      await prisma.adInsightDaily.upsert({
        where: { adId_date: { adId: r.adId, date } },
        create: { ...r, date, fetchedAt: now },
        update: { ...r, date, fetchedAt: now },
      });
      out.insights += 1;
    }
  } catch (error) {
    out.errors.push(`insights: ${redactToken(error?.message || error, env)}`);
    console.error(JSON.stringify({ type: 'ads_snapshot_insights_failed', error: redactToken(error?.message, env) }));
  }
  try {
    const ads = await fetchAdCatalog({ env, fetchImpl });
    for (const a of ads) {
      await prisma.adCatalog.upsert({ where: { adId: a.adId }, create: a, update: a });
      out.ads += 1;
    }
  } catch (error) {
    out.errors.push(`catalog: ${redactToken(error?.message || error, env)}`);
    console.error(JSON.stringify({ type: 'ads_snapshot_catalog_failed', error: redactToken(error?.message, env) }));
  }
  return out;
}
