/**
 * Mission Control's Links tab (founder 2026-10-25): where payment links are made, shared, opened and paid
 * from, read from link_visits (lib/link-visits.js) and payment_requests. Areas only (country, province,
 * city, a city-level point); no IP, no phone number, no name. See lib/link-visits.js for what each kind
 * means and for the limits of IP-based areas.
 *
 * The map's pins (founder 2026-10-26): a link shows at every place it touched (where it was made, or its
 * requester's area; shared from; opened; paid from), coloured by the LINK's status: green paid, blue
 * requested (open, not paid yet), grey closed (cancelled or expired). Links at one place with one status
 * share a pin. A pin carries link codes, amounts and areas only.
 */
import { SOURCE_TAGS, provinceName } from './link-visits.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PIN_LINKS = 5; // links described on a pin's hover card; its count stays exact
const LOOKUP_CAP = 5000; // older links still being opened, looked up for their status
const LINK_SELECT = { id: true, accountId: true, amountCents: true, status: true, createdAt: true, paidAt: true, expiresAt: true, businessId: true };
// What a link did at a place, in the order of its journey.
const DID = { CREATED: 'made', PREVIEW: 'shared from', OPEN: 'opened', CHECKOUT: 'pressed pay' };
const DID_ORDER = ['made', "requester's area", 'shared from', 'opened', 'pressed pay', 'paid from'];

const areaOf = (v) => (v && (v.city || v.region || v.country) ? { city: v.city || null, province: provinceName(v.country, v.region), country: v.country || null } : null);
const areaText = (a) => (a ? [a.city, a.country === 'ZA' ? a.province : a.province || a.country].filter(Boolean).join(', ') || a.country || null : null);
const inc = (m, k, n = 1) => { m.set(k, (m.get(k) || 0) + n); return m; };
const top = (m, n = 15) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

/** The pin colours, one per link status, in legend order. The tab draws its pins and legend from this. */
export const PIN_STATUSES = Object.freeze([
  Object.freeze({ status: 'paid', label: 'Paid', colour: '#359853', meaning: 'paid' }),
  Object.freeze({ status: 'requested', label: 'Requested', colour: '#2a78d6', meaning: 'open, not paid yet' }),
  Object.freeze({ status: 'closed', label: 'Closed', colour: '#8a948d', meaning: 'cancelled or expired' }),
]);

/**
 * A link's pin: 'paid', 'requested' or 'closed'; null for no link. A pending link past its expiry counts as
 * expired, as getPaymentRequest reads it (the row is only marked EXPIRED when someone opens it).
 */
export function pinStatusOf(link, now = Date.now()) {
  switch (String(link?.status || '').toUpperCase()) {
    case 'PAID': return 'paid';
    case 'CANCELLED': case 'EXPIRED': return 'closed';
    case 'PENDING': return link.expiresAt && new Date(link.expiresAt).getTime() <= now ? 'closed' : 'requested';
    default: return null;
  }
}

/** 'US' → the US flag emoji, built from regional-indicator letters; '' for anything that is not a two-letter code. */
export function flagOf(country) {
  const c = String(country || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : '';
}

let regionNames = null;
/** 'KE' → 'Kenya'. The code itself when the runtime has no name for it; null for anything else. */
export function countryName(country) {
  const c = String(country || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return null;
  try {
    regionNames = regionNames || new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(c) || c;
  } catch {
    return c;
  }
}

// "Durban, KwaZulu-Natal" at home, "San Jose, United States" abroad.
function placeText(p) {
  if (p.country && p.country !== 'ZA') return [p.city, countryName(p.country)].filter(Boolean).join(', ');
  return [p.city, p.province].filter(Boolean).join(', ') || (p.country ? 'South Africa' : 'Unknown place');
}

/**
 * Map pins from placements (one link at one place doing one thing: { code, amountCents, status, did, at,
 * lat, lng, city, province, country }). One pin per place and status; a link counts once however often it
 * touched that place; the newest `cap` links carry their details, `codes` lists them all.
 */
export function groupPins(placements, { cap = PIN_LINKS } = {}) {
  const pins = new Map();
  for (const p of placements) {
    if (!p?.code || !p.status || p.lat == null || p.lng == null) continue;
    const key = `${p.status}|${p.lat}|${p.lng}`;
    const pin = pins.get(key) || { status: p.status, lat: p.lat, lng: p.lng, city: p.city || null, province: p.province || null, country: p.country || null, byCode: new Map() };
    const link = pin.byCode.get(p.code) || { code: p.code, amountCents: p.amountCents ?? null, did: new Map(), at: 0 };
    inc(link.did, p.did);
    link.at = Math.max(link.at, new Date(p.at).getTime() || 0);
    pin.byCode.set(p.code, link);
    pins.set(key, pin);
  }
  return [...pins.values()].map(({ byCode, ...pin }) => {
    const all = [...byCode.values()].sort((a, b) => b.at - a.at || (a.code < b.code ? -1 : 1));
    return {
      ...pin,
      place: placeText(pin),
      flag: pin.country && pin.country !== 'ZA' ? flagOf(pin.country) : '',
      count: all.length,
      codes: all.map((l) => l.code),
      links: all.slice(0, cap).map((l) => ({
        code: l.code,
        amountCents: l.amountCents,
        at: l.at ? new Date(l.at).toISOString() : null,
        did: DID_ORDER.filter((d) => l.did.has(d)).map((d) => (l.did.get(d) > 1 ? `${d} ×${l.did.get(d)}` : d)),
      })),
    };
  }).sort((a, b) => b.count - a.count || a.place.localeCompare(b.place));
}

/** Everything the tab draws, for the last `days` days. */
export async function linkMapView({ prisma, days = 30, now = Date.now() }) {
  const span = Math.min(90, Math.max(1, Number(days) || 30));
  const since = new Date(now - span * DAY_MS);
  const [visits, links] = await Promise.all([
    prisma.linkVisit.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 20000,
      select: { kind: true, code: true, accountId: true, source: true, country: true, region: true, city: true, latitude: true, longitude: true, device: true, os: true, browser: true, app: true, createdAt: true },
    }),
    prisma.paymentRequest.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 5000,
      select: LINK_SELECT,
    }),
  ]);

  // Every link the visits name, with its status: the window's own links, and older links still being opened.
  const linkByCode = new Map(links.map((l) => [l.id, l]));
  const older = [...new Set(visits.map((v) => v.code).filter((c) => c && !linkByCode.has(c)))].slice(0, LOOKUP_CAP);
  if (older.length) for (const l of await prisma.paymentRequest.findMany({ where: { id: { in: older } }, select: LINK_SELECT })) linkByCode.set(l.id, l);
  const statusOf = (code) => pinStatusOf(linkByCode.get(code), now);

  // The map: each link at every place it touched, coloured by the link's status.
  const hasPoint = (v) => v.latitude != null && v.longitude != null;
  const pointOf = (v) => ({ lat: v.latitude, lng: v.longitude, city: v.city || null, province: provinceName(v.country, v.region), country: v.country || null });
  const placements = [];
  const madeHere = new Set();
  for (const v of visits) {
    const status = DID[v.kind] && v.code && hasPoint(v) ? statusOf(v.code) : null;
    if (!status) continue;
    if (v.kind === 'CREATED') madeHere.add(v.code);
    placements.push({ code: v.code, amountCents: linkByCode.get(v.code).amountCents, status, did: v.kind === 'CHECKOUT' && status === 'paid' ? 'paid from' : DID[v.kind], at: v.createdAt, ...pointOf(v) });
  }
  // A link made in WhatsApp carries no area of its own: it shows at its requester's newest web app area (SEEN).
  const seenAt = new Map();
  for (const v of visits) if (v.kind === 'SEEN' && v.accountId && hasPoint(v) && !seenAt.has(v.accountId)) seenAt.set(v.accountId, v);
  for (const l of linkByCode.values()) {
    const seen = !madeHere.has(l.id) && seenAt.get(l.accountId);
    const status = seen ? pinStatusOf(l, now) : null;
    if (status) placements.push({ code: l.id, amountCents: l.amountCents, status, did: "requester's area", at: l.createdAt, ...pointOf(seen) });
  }
  const onMap = new Map(PIN_STATUSES.map((s) => [s.status, new Set()]));
  for (const p of placements) onMap.get(p.status).add(p.code);

  // Provinces (South Africa) and top cities.
  const provinces = new Map();
  const cities = new Map();
  const abroad = new Map();
  const abroadLinks = new Map(); // country → status → the links opened or paid from there
  let unknown = 0;
  const requestersByProvince = new Map();
  for (const v of visits) {
    if (!v.country) { if (v.kind === 'OPEN') unknown += 1; continue; }
    if (v.country !== 'ZA') {
      if (v.kind === 'OPEN' || v.kind === 'CHECKOUT') {
        inc(abroad, v.country);
        const status = v.code ? statusOf(v.code) : null;
        if (status) {
          const byStatus = abroadLinks.get(v.country) || new Map(PIN_STATUSES.map((s) => [s.status, new Set()]));
          byStatus.get(status).add(v.code);
          abroadLinks.set(v.country, byStatus);
        }
      }
      continue;
    }
    const prov = provinceName('ZA', v.region) || 'Unknown province';
    const row = provinces.get(prov) || { province: prov, opened: 0, paid: 0, shared: 0, requesters: 0 };
    if (v.kind === 'OPEN') row.opened += 1;
    if (v.kind === 'CHECKOUT') row.paid += 1;
    if (v.kind === 'PREVIEW') row.shared += 1;
    if ((v.kind === 'SEEN' || v.kind === 'CREATED') && v.accountId) {
      const set = requestersByProvince.get(prov) || new Set();
      set.add(v.accountId); requestersByProvince.set(prov, set);
    }
    provinces.set(prov, row);
    if (v.kind === 'OPEN' && v.city) inc(cities, `${v.city}|${prov}`);
  }
  for (const [prov, set] of requestersByProvince) provinces.get(prov).requesters = set.size;

  // How people arrived (the ?s= door), and on what.
  const doors = new Map(); const devices = new Map(); const apps = new Map();
  for (const v of visits) {
    if (v.kind !== 'OPEN') continue;
    inc(doors, v.source ? SOURCE_TAGS[v.source] || v.source : 'first message');
    inc(devices, v.device || 'unknown');
    if (v.app) inc(apps, v.app);
  }
  for (const v of visits) if (v.kind === 'PREVIEW') inc(apps, `${v.app || 'link'} preview`);

  // Per link: made in, shared from, opened in, paid from.
  const byCode = new Map();
  for (const v of visits) {
    if (!v.code) continue;
    const r = byCode.get(v.code) || { opens: 0, openAreas: new Map(), paidFrom: null, sharedFrom: null, madeIn: null };
    if (v.kind === 'OPEN') { r.opens += 1; const a = areaText(areaOf(v)); if (a) inc(r.openAreas, a); }
    if (v.kind === 'CHECKOUT' && !r.paidFrom) r.paidFrom = areaText(areaOf(v));
    if (v.kind === 'PREVIEW') r.sharedFrom = areaText(areaOf(v)) || r.sharedFrom;
    if (v.kind === 'CREATED') r.madeIn = areaText(areaOf(v));
    byCode.set(v.code, r);
  }
  const seenArea = new Map();
  for (const v of visits) if (v.kind === 'SEEN' && v.accountId && !seenArea.has(v.accountId)) seenArea.set(v.accountId, areaText(areaOf(v)));
  const recent = links.slice(0, 60).map((l) => {
    const r = byCode.get(l.id) || { opens: 0, openAreas: new Map(), paidFrom: null, sharedFrom: null, madeIn: null };
    const channel = l.businessId ? 'business' : visits.some((v) => v.kind === 'CREATED' && v.code === l.id && v.source === 'web') ? 'web app' : 'WhatsApp';
    return {
      code: l.id,
      amountCents: l.amountCents,
      // A pending link past its expiry reads as expired, the same way its pin turns grey.
      status: l.status === 'PENDING' && l.expiresAt && new Date(l.expiresAt).getTime() <= now ? 'EXPIRED' : l.status,
      createdAt: l.createdAt,
      channel,
      madeIn: r.madeIn || seenArea.get(l.accountId) || null,
      madeInBasis: r.madeIn ? 'made here' : seenArea.get(l.accountId) ? "requester's web app area" : null,
      sharedFrom: r.sharedFrom,
      opens: r.opens,
      openedIn: top(r.openAreas, 3).map(([a, n]) => (n > 1 ? `${a} ×${n}` : a)),
      paidFrom: r.paidFrom,
    };
  });

  const openCodes = new Set(visits.filter((v) => v.kind === 'OPEN').map((v) => v.code));
  return {
    days: span,
    since: since.toISOString(),
    totals: {
      made: links.length,
      madeOnWeb: visits.filter((v) => v.kind === 'CREATED' && v.source === 'web').length,
      madeForBusiness: links.filter((l) => l.businessId).length,
      opened: [...openCodes].filter(Boolean).length,
      opens: visits.filter((v) => v.kind === 'OPEN').length,
      shared: visits.filter((v) => v.kind === 'PREVIEW').length,
      checkouts: visits.filter((v) => v.kind === 'CHECKOUT').length,
      paid: links.filter((l) => l.status === 'PAID').length,
      unknownArea: unknown,
    },
    statuses: PIN_STATUSES.map((s) => ({ ...s, links: onMap.get(s.status).size })),
    pins: groupPins(placements),
    provinces: [...provinces.values()].sort((a, b) => b.opened - a.opened || b.paid - a.paid),
    cities: top(cities, 15).map(([k, n]) => { const [city, province] = k.split('|'); return { city, province, opens: n }; }),
    abroad: top(abroad, 20).map(([country, n]) => {
      const byStatus = abroadLinks.get(country);
      return { country, flag: flagOf(country), name: countryName(country), count: n, links: Object.fromEntries(PIN_STATUSES.map((s) => [s.status, byStatus ? byStatus.get(s.status).size : 0])) };
    }),
    doors: top(doors).map(([door, n]) => ({ door, opens: n })),
    devices: top(devices).map(([device, n]) => ({ device, opens: n })),
    apps: top(apps).map(([app, n]) => ({ app, count: n })),
    recent,
  };
}

/** One link's story: when and where it was made, shared, opened and paid from. */
export async function linkTimeline({ prisma, code }) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^PR[A-Z]{6}$/.test(c)) return { ok: false, error: 'BAD_CODE' };
  const link = await prisma.paymentRequest.findUnique({ where: { id: c }, select: { id: true, amountCents: true, status: true, createdAt: true, paidAt: true, businessId: true, note: true } });
  if (!link) return { ok: false, error: 'NOT_FOUND' };
  const visits = await prisma.linkVisit.findMany({ where: { code: c }, orderBy: { createdAt: 'asc' }, select: { kind: true, source: true, country: true, region: true, city: true, device: true, os: true, browser: true, app: true, createdAt: true } });
  return {
    ok: true,
    link: { code: link.id, amountCents: link.amountCents, status: link.status, createdAt: link.createdAt, paidAt: link.paidAt, business: !!link.businessId, note: link.note || null },
    events: visits.map((v) => ({ at: v.createdAt, kind: v.kind, door: v.source ? SOURCE_TAGS[v.source] || v.source : null, area: areaText(areaOf(v)), device: v.device, os: v.os, browser: v.browser, app: v.app })),
  };
}

/** The visits as CSV for the founder's own analysis: areas and devices only. */
export async function linkVisitsCsv({ prisma, days = 30, now = Date.now() }) {
  const since = new Date(now - Math.min(90, Math.max(1, Number(days) || 30)) * DAY_MS);
  const rows = await prisma.linkVisit.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'asc' }, take: 50000, select: { createdAt: true, kind: true, code: true, source: true, country: true, region: true, city: true, device: true, os: true, browser: true, app: true } });
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['time_utc', 'event', 'link', 'door', 'country', 'province', 'city', 'device', 'os', 'browser', 'app'];
  const lines = rows.map((r) => [new Date(r.createdAt).toISOString(), r.kind, r.code, r.source ? SOURCE_TAGS[r.source] || r.source : '', r.country, provinceName(r.country, r.region), r.city, r.device, r.os, r.browser, r.app].map(esc).join(','));
  return [head.join(','), ...lines].join('\n');
}
