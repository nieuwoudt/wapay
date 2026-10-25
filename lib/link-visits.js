/**
 * Where payment links travel (founder 2026-10-25): "where all these links are being created, which parts
 * of the country, and also where they're sending it to, and if that person opens the links, where that
 * person is".
 *
 * What can be known, honestly:
 *   - OPEN      someone opened the pay page: where they are, from the request's IP as Vercel's edge reads
 *               it (country, province, city, a city-level point), their device, browser and in-app app.
 *   - PREVIEW   a phone fetched the page to draw WhatsApp's link preview: that is the phone the link was
 *               pasted into a chat on, so it shows where the link was SENT FROM. Forwarding a message that
 *               already has a preview fetches nothing, so not every share leaves a preview.
 *   - CHECKOUT  the payer pressed pay: where the payment came from.
 *   - CREATED   a link made on the web app or the business portal: where it was made. Links made in
 *               WhatsApp carry no location (WhatsApp shares none with WaPay); their requester's area comes
 *               from SEEN and from the previews of their links.
 *   - SEEN      a signed-in web app request: the requester's own area, once a day.
 * WaPay cannot see a forward inside WhatsApp (it is end-to-end encrypted): "where it was sent to" is where
 * it was opened. The area is IP-based: town or city on Wi-Fi and fibre, but South African mobile data often
 * surfaces at the network's hub city (Johannesburg, Cape Town, Durban), and a VPN shows the VPN. Never GPS.
 *
 * Privacy (POPIA: location is personal information): the IP itself is never stored. visitorKey is a keyed
 * hash of the IP, the browser and the day, so it counts a device once per link per day and cannot follow
 * it from one day to the next. Rows are deleted after 90 days (pruneLinkVisits, daily cron). The pay page
 * tells payers. Nothing here is ever sent to a model.
 *
 * Every write is best effort and capped: a slow or missing table never slows or breaks a page.
 */
import crypto from 'node:crypto';
import prismaDefault from './prisma.js';

export const KINDS = Object.freeze(['OPEN', 'PREVIEW', 'CHECKOUT', 'CREATED', 'SEEN']);
export const RETENTION_DAYS = 90;
export const SA_PROVINCES = Object.freeze({
  EC: 'Eastern Cape', FS: 'Free State', GP: 'Gauteng', KZN: 'KwaZulu-Natal', NL: 'KwaZulu-Natal', LP: 'Limpopo',
  MP: 'Mpumalanga', NC: 'Northern Cape', NW: 'North West', WC: 'Western Cape',
});
export const SOURCE_TAGS = Object.freeze({ r: 'reminder', t: 'tap-to-send', w: 'web app share', b: 'business portal' });

const header = (req, k) => {
  const v = req?.headers?.[k];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() ? s.trim() : null;
};

/** The area Vercel's edge reads from the request's IP. Every field may be null (local runs, hidden IPs). */
export function geoOf(req) {
  const decode = (v) => { if (!v) return null; try { return decodeURIComponent(v); } catch { return v; } };
  const coord = (v) => { const n = Number(v); return v != null && Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
  const country = header(req, 'x-vercel-ip-country');
  const region = header(req, 'x-vercel-ip-country-region');
  const city = decode(header(req, 'x-vercel-ip-city'));
  return {
    country: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null,
    region: region && /^[A-Za-z0-9]{1,4}$/.test(region) ? region.toUpperCase() : null,
    city: city ? city.replace(/[^\p{L}\p{N} .,'()-]/gu, '').trim().slice(0, 80) || null : null,
    latitude: coord(header(req, 'x-vercel-ip-latitude')),
    longitude: coord(header(req, 'x-vercel-ip-longitude')),
  };
}

/** "Gauteng", "KwaZulu-Natal": a South African province code in words; other countries keep the code. */
export function provinceName(country, region) {
  if (!region) return null;
  return country === 'ZA' ? SA_PROVINCES[region] || region : region;
}

/** The client's IP as Vercel passes it (first hop of x-forwarded-for). Used only inside visitorKey. */
export function clientIp(req) {
  const fwd = header(req, 'x-forwarded-for');
  return (fwd ? fwd.split(',')[0].trim() : null) || header(req, 'x-real-ip') || req?.socket?.remoteAddress || '';
}

// Link-preview fetchers that run on the SENDER's own phone (their area is where the link was pasted).
const DEVICE_PREVIEW = /^WhatsApp\/|Facebot Twitterbot\/1\.0/i;
// Crawlers and server-side fetchers: their area is a data centre, never a person. Not recorded.
const BOT = /facebookexternalhit|meta-externalagent|Facebot(?! Twitterbot)|TelegramBot|Twitterbot|Slackbot|Discordbot|LinkedInBot|SkypeUriPreview|Googlebot|Google-InspectionTool|bingbot|DuckDuckBot|YandexBot|Baiduspider|AhrefsBot|SemrushBot|MJ12bot|PetalBot|Bytespider|GPTBot|ClaudeBot|Applebot|HeadlessChrome|Lighthouse|vercel-screenshot|Vercelbot|UptimeRobot|Pingdom|curl\/|Wget\/|python-requests|node-fetch|axios\/|Go-http-client|okhttp/i;

/**
 * What kind of visitor a user agent is, and its device, OS, browser and in-app app.
 * kind: OPEN (a person's browser), PREVIEW (a phone drawing a link preview), BOT (not recorded).
 */
export function classifyVisitor(ua) {
  const s = String(ua || '');
  let kind = 'OPEN';
  if (!s.trim()) kind = 'BOT';
  else if (DEVICE_PREVIEW.test(s)) kind = 'PREVIEW';
  else if (BOT.test(s) || !/Mozilla\/5\.0/.test(s)) kind = 'BOT';
  const os = /Android/i.test(s) || /^WhatsApp\/[\d.]+ A\b/.test(s) ? 'Android'
    : /iPhone|iPad|iPod|iOS/i.test(s) || /^WhatsApp\/[\d.]+ i\b/.test(s) ? 'iOS'
      : /Windows/i.test(s) ? 'Windows' : /Mac OS X|Macintosh/i.test(s) ? 'macOS' : /CrOS/i.test(s) ? 'ChromeOS' : /Linux/i.test(s) ? 'Linux' : null;
  const device = /iPad|Tablet/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s) && kind === 'OPEN') ? 'tablet'
    : /Mobi|iPhone|iPod|Android/i.test(s) || /^WhatsApp\//.test(s) ? 'mobile'
      : os ? 'desktop' : null;
  const app = /WhatsApp/i.test(s) ? 'WhatsApp' : /FBAN|FBAV|FB_IAB|FBIOS/i.test(s) ? 'Facebook' : /Instagram/i.test(s) ? 'Instagram'
    : /musical_ly|BytedanceWebview|TikTok/i.test(s) ? 'TikTok' : /Snapchat/i.test(s) ? 'Snapchat' : /Line\//.test(s) ? 'LINE'
      : /Telegram/i.test(s) ? 'Telegram' : null;
  const browser = kind !== 'OPEN' ? null
    : /SamsungBrowser/i.test(s) ? 'Samsung Internet' : /OPR\/|Opera/i.test(s) ? 'Opera' : /Edg\//i.test(s) ? 'Edge'
      : /CriOS|Chrome\//i.test(s) ? 'Chrome' : /FxiOS|Firefox\//i.test(s) ? 'Firefox' : /Safari\//i.test(s) ? 'Safari' : null;
  return { kind, device, os, browser, app };
}

/** YYYY-MM-DD in South African time. */
export function sastDay(now = Date.now()) {
  return new Date(now + 2 * 3600 * 1000).toISOString().slice(0, 10);
}

function keyed(text, env = process.env) {
  const secret = String(env.WAPAY_LINK_VISIT_SECRET || env.WAPAY_PIN_PROOF_SECRET || 'wapay-link-visits');
  return crypto.createHmac('sha256', secret).update(String(text)).digest('hex').slice(0, 32);
}

/** One device on one day: a keyed hash of the IP, the browser and the day. */
export function visitorKeyOf(req, now = Date.now(), env = process.env) {
  return keyed(`${clientIp(req)}|${header(req, 'user-agent') || ''}|${sastDay(now)}`, env);
}

/** A ?s= tag from a link, when it is one of ours. */
export function sourceTag(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return /^[a-z]{1,3}$/.test(s) && SOURCE_TAGS[s] ? s : null;
}

const withCap = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve({ skipped: 'TIMEOUT' }), ms))]);

/**
 * Record one visit. kind OPEN is turned into PREVIEW for a phone drawing a link preview, and skipped for
 * a crawler. A device's second visit to the same link on the same day is a no-op (the unique key).
 * Never throws; capped at `capMs`.
 */
export async function recordLinkVisit({ prisma = prismaDefault, req, kind, code = '', accountId = null, source = null, now = Date.now(), env = process.env, capMs = 700, visitorKey = null }) {
  try {
    if (!KINDS.includes(kind)) return { skipped: 'BAD_KIND' };
    if (typeof prisma?.linkVisit?.create !== 'function') return { skipped: 'NO_TABLE' };
    const who = classifyVisitor(header(req, 'user-agent'));
    let finalKind = kind;
    if (kind === 'OPEN' || kind === 'CHECKOUT') {
      if (who.kind === 'BOT') return { skipped: 'BOT' };
      if (kind === 'OPEN' && who.kind === 'PREVIEW') finalKind = 'PREVIEW';
    }
    const geo = geoOf(req);
    const data = {
      kind: finalKind,
      code: String(code || '').toUpperCase().slice(0, 16),
      accountId: accountId || null,
      source: source ? String(source).slice(0, 16) : null,
      ...geo,
      device: who.device,
      os: who.os,
      browser: who.browser,
      app: who.app,
      visitorKey: visitorKey || visitorKeyOf(req, now, env),
    };
    return await withCap(
      prisma.linkVisit.create({ data, select: { id: true } }).then(() => ({ recorded: finalKind })).catch((e) => (e?.code === 'P2002' ? { skipped: 'DUPLICATE' } : { error: e?.code || e?.message || 'WRITE_FAILED' })),
      capMs,
    );
  } catch (error) {
    return { error: error?.message || 'FAILED' };
  }
}

/** The signed-in requester's own area, once a day per account (SEEN). */
export async function recordAccountSeen({ prisma = prismaDefault, req, accountId, now = Date.now(), env = process.env }) {
  if (!accountId) return { skipped: 'NO_ACCOUNT' };
  return recordLinkVisit({ prisma, req, kind: 'SEEN', code: '', accountId, now, env, visitorKey: keyed(`seen|${accountId}|${sastDay(now)}`, env) });
}

/** Deletes visits older than RETENTION_DAYS. Returns how many went. */
export async function pruneLinkVisits({ prisma = prismaDefault, now = Date.now(), days = RETENTION_DAYS } = {}) {
  if (typeof prisma?.linkVisit?.deleteMany !== 'function') return { skipped: 'NO_TABLE' };
  const out = await prisma.linkVisit.deleteMany({ where: { createdAt: { lt: new Date(now - days * 24 * 3600 * 1000) } } });
  return { deleted: out?.count ?? 0 };
}
