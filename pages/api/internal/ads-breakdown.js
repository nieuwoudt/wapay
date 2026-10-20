/**
 * GET /api/internal/ads-breakdown?since=YYYY-MM-DD&until=YYYY-MM-DD&by=none|placement|age|gender|age_gender|region|device
 *
 * Meta ad insights per ad for a period, optionally broken down, for the ads
 * report the founder asked for on 2026-10-20 (placement and age band per ad).
 * Internal key. Read-only: nothing is stored, the token never leaves the server
 * and is redacted from any error. Figures are Meta's own (impressions, reach,
 * clicks, link clicks, spend, conversations started); our funnel numbers come
 * from the growth endpoint, never from here.
 */
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import { adsConfig, GRAPH, CONVERSATION_ACTION, CONNECTION_ACTION, redactToken } from '../../../lib/meta-ads.js';

export const BREAKDOWNS = { none: '', placement: 'publisher_platform,platform_position', age: 'age', gender: 'gender', age_gender: 'age,gender', region: 'region', device: 'impression_device' };
const FIELDS = 'ad_id,ad_name,adset_name,campaign_name,impressions,reach,clicks,inline_link_clicks,ctr,cpc,cpm,spend,actions';

export function isoDayOk(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

/** One Graph row to our shape. Pure. */
export function parseRow(row) {
  const act = (k) => Number((row.actions || []).find((a) => a.action_type === k)?.value || 0);
  return {
    adId: row.ad_id || null, adName: row.ad_name || null, adsetName: row.adset_name || null, campaignName: row.campaign_name || null,
    publisherPlatform: row.publisher_platform || null, platformPosition: row.platform_position || null,
    age: row.age || null, gender: row.gender || null, region: row.region || null, device: row.impression_device || null,
    impressions: Number(row.impressions || 0), reach: Number(row.reach || 0), clicks: Number(row.clicks || 0), linkClicks: Number(row.inline_link_clicks || 0),
    ctr: Number(row.ctr || 0), cpcCents: Math.round(Number(row.cpc || 0) * 100), cpmCents: Math.round(Number(row.cpm || 0) * 100),
    spendCents: Math.round(Number(row.spend || 0) * 100), conversations: act(CONVERSATION_ACTION), connections: act(CONNECTION_ACTION), leads: act('lead'), purchases: act('purchase'),
  };
}

export default async function handler(req, res) {
  if (!requireInternalAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'METHOD' });
  const cfg = adsConfig(process.env);
  if (!cfg.configured) return res.status(503).json({ ok: false, error: 'NOT_CONFIGURED' });
  const byKey = String(req.query.by || 'none');
  const by = BREAKDOWNS[byKey];
  if (by === undefined) return res.status(400).json({ ok: false, error: 'BAD_BREAKDOWN', allowed: Object.keys(BREAKDOWNS) });
  const since = String(req.query.since || '');
  const until = String(req.query.until || since);
  if (!isoDayOk(since) || !isoDayOk(until)) return res.status(400).json({ ok: false, error: 'BAD_RANGE' });
  const params = new URLSearchParams({ level: 'ad', time_range: JSON.stringify({ since, until }), fields: FIELDS, limit: '500', access_token: cfg.token });
  if (by) params.set('breakdowns', by);
  if (String(req.query.daily) === '1') params.set('time_increment', '1');
  let url = `${GRAPH}/act_${cfg.accountId}/insights?${params}`;
  const rows = [];
  try {
    for (let page = 0; url && page < 10; page += 1) {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      if (!r.ok || j.error) return res.status(502).json({ ok: false, error: redactToken(j?.error?.message || `HTTP ${r.status}`, process.env) });
      for (const row of j.data || []) rows.push(parseRow(row));
      url = j.paging?.next || null;
    }
    return res.status(200).json({ ok: true, since, until, by: byKey, rows });
  } catch (e) {
    return res.status(502).json({ ok: false, error: redactToken(e?.name === 'TimeoutError' ? 'timeout' : e?.message, process.env) });
  }
}
