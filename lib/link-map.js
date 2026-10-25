/**
 * Mission Control's Links tab (founder 2026-10-25): where payment links are made, shared, opened and paid
 * from, read from link_visits (lib/link-visits.js) and payment_requests. Areas only (country, province,
 * city, a city-level point); no IP, no phone number, no name. See lib/link-visits.js for what each kind
 * means and for the limits of IP-based areas.
 */
import { SOURCE_TAGS, provinceName } from './link-visits.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const GROUP = { OPEN: 'opened', CHECKOUT: 'paid', PREVIEW: 'shared', CREATED: 'requester', SEEN: 'requester' };

const areaOf = (v) => (v && (v.city || v.region || v.country) ? { city: v.city || null, province: provinceName(v.country, v.region), country: v.country || null } : null);
const areaText = (a) => (a ? [a.city, a.country === 'ZA' ? a.province : a.province || a.country].filter(Boolean).join(', ') || a.country || null : null);
const inc = (m, k, n = 1) => { m.set(k, (m.get(k) || 0) + n); return m; };
const top = (m, n = 15) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

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
      select: { id: true, accountId: true, amountCents: true, status: true, createdAt: true, paidAt: true, businessId: true },
    }),
  ]);

  // The map: one point per place and kind of event, sized by how many.
  const points = new Map();
  for (const v of visits) {
    if (v.latitude == null || v.longitude == null) continue;
    const group = GROUP[v.kind];
    const key = `${group}|${v.latitude}|${v.longitude}`;
    const p = points.get(key) || { group, lat: v.latitude, lng: v.longitude, city: v.city || null, province: provinceName(v.country, v.region), country: v.country || null, count: 0 };
    p.count += 1;
    points.set(key, p);
  }

  // Provinces (South Africa) and top cities.
  const provinces = new Map();
  const cities = new Map();
  const abroad = new Map();
  let unknown = 0;
  const requestersByProvince = new Map();
  for (const v of visits) {
    if (!v.country) { if (v.kind === 'OPEN') unknown += 1; continue; }
    if (v.country !== 'ZA') { if (v.kind === 'OPEN' || v.kind === 'CHECKOUT') inc(abroad, v.country); continue; }
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
      status: l.status,
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
    points: [...points.values()],
    provinces: [...provinces.values()].sort((a, b) => b.opened - a.opened || b.paid - a.paid),
    cities: top(cities, 15).map(([k, n]) => { const [city, province] = k.split('|'); return { city, province, opens: n }; }),
    abroad: top(abroad, 20).map(([country, n]) => ({ country, count: n })),
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
