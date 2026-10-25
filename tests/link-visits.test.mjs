// Where payment links travel (founder 2026-10-25): the pay page, checkout, link creation and the web app record
// the area from the internet connection (never GPS, never the IP), once per device per link per day; Mission
// Control draws it; the triage reads where payers paid from; visits are deleted after 90 days.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { geoOf, classifyVisitor, visitorKeyOf, recordLinkVisit, recordAccountSeen, pruneLinkVisits, sourceTag, provinceName, sastDay } = await import('../lib/link-visits.js');
const { linkMapView, linkTimeline, linkVisitsCsv } = await import('../lib/link-map.js');
const { paymentRequestUrl } = await import('../lib/payment-requests.js');
const { payoutTriage } = await import('../lib/payout-triage.js');

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const UA = {
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  whatsappPreviewAndroid: 'WhatsApp/2.24.21.80 A',
  whatsappPreviewIos: 'WhatsApp/2.24.21.80 i',
  imessage: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0',
  metaCrawler: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  facebookInApp: 'Mozilla/5.0 (Linux; Android 12; TECNO) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0]',
  edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0',
  curl: 'curl/8.7.1',
};
const req = (ua, geo = {}, ip = '41.13.200.7') => ({
  headers: {
    'user-agent': ua,
    'x-forwarded-for': `${ip}, 76.76.21.21`,
    ...(geo.country ? { 'x-vercel-ip-country': geo.country } : {}),
    ...(geo.region ? { 'x-vercel-ip-country-region': geo.region } : {}),
    ...(geo.city ? { 'x-vercel-ip-city': geo.city } : {}),
    ...(geo.lat != null ? { 'x-vercel-ip-latitude': String(geo.lat) } : {}),
    ...(geo.lng != null ? { 'x-vercel-ip-longitude': String(geo.lng) } : {}),
  },
});
const DBN = { country: 'ZA', region: 'KZN', city: 'Durban', lat: -29.8587, lng: 31.0218 };

test('the area comes from Vercel\'s edge headers, cleaned and rounded to a city-level point', () => {
  assert.deepEqual(geoOf(req(UA.chromeAndroid, { country: 'za', region: 'gp', city: 'Johannesburg%20South', lat: -26.2041, lng: 28.0473 })), { country: 'ZA', region: 'GP', city: 'Johannesburg South', latitude: -26.2, longitude: 28.05 });
  assert.deepEqual(geoOf({ headers: {} }), { country: null, region: null, city: null, latitude: null, longitude: null }, 'local runs and hidden IPs: nothing');
  assert.equal(geoOf(req(UA.chromeAndroid, { country: 'ZAF' })).country, null, 'not a two-letter code');
  assert.equal(provinceName('ZA', 'KZN'), 'KwaZulu-Natal'); assert.equal(provinceName('ZA', 'WC'), 'Western Cape'); assert.equal(provinceName('NG', 'LA'), 'LA');
});

test('visitors: a person\'s browser is an open, a phone drawing a WhatsApp preview is a share, a crawler is not recorded', () => {
  assert.deepEqual(classifyVisitor(UA.chromeAndroid), { kind: 'OPEN', device: 'mobile', os: 'Android', browser: 'Chrome', app: null });
  assert.deepEqual(classifyVisitor(UA.safariIphone), { kind: 'OPEN', device: 'mobile', os: 'iOS', browser: 'Safari', app: null });
  assert.deepEqual(classifyVisitor(UA.whatsappPreviewAndroid), { kind: 'PREVIEW', device: 'mobile', os: 'Android', browser: null, app: 'WhatsApp' });
  assert.equal(classifyVisitor(UA.whatsappPreviewIos).os, 'iOS');
  assert.equal(classifyVisitor(UA.imessage).kind, 'PREVIEW', 'iMessage draws its preview on the device');
  assert.equal(classifyVisitor(UA.metaCrawler).kind, 'BOT', "Meta's crawler sits in a data centre");
  assert.equal(classifyVisitor(UA.curl).kind, 'BOT'); assert.equal(classifyVisitor('').kind, 'BOT');
  assert.equal(classifyVisitor(UA.facebookInApp).app, 'Facebook');
  assert.deepEqual(classifyVisitor(UA.edgeWindows), { kind: 'OPEN', device: 'desktop', os: 'Windows', browser: 'Edge', app: null });
});

test('one device on one day: the key changes every day and never holds the IP', () => {
  const t = Date.parse('2026-10-25T08:00:00Z');
  const a = visitorKeyOf(req(UA.chromeAndroid), t, {});
  assert.equal(a, visitorKeyOf(req(UA.chromeAndroid), t + 3600e3, {}), 'same device, same day');
  assert.notEqual(a, visitorKeyOf(req(UA.chromeAndroid), t + 24 * 3600e3, {}), 'the next day is a new key');
  assert.notEqual(a, visitorKeyOf(req(UA.safariIphone), t, {}), 'another browser');
  assert.ok(!a.includes('41.13') && /^[0-9a-f]{32}$/.test(a));
  assert.equal(sastDay(Date.parse('2026-10-24T22:30:00Z')), '2026-10-25', 'the day is South African');
});

function visitsDb({ failWith = null, slowMs = 0 } = {}) {
  const rows = []; const keys = new Set();
  return {
    rows,
    linkVisit: {
      async create({ data }) {
        if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
        if (failWith) throw failWith;
        const k = `${data.kind}|${data.code}|${data.visitorKey}`;
        if (keys.has(k)) throw Object.assign(new Error('unique'), { code: 'P2002' });
        keys.add(k); rows.push(data); return { id: `v${rows.length}` };
      },
      async deleteMany({ where }) { const before = rows.length; const cut = where.createdAt.lt; for (let i = rows.length - 1; i >= 0; i -= 1) if ((rows[i].createdAt || new Date(0)) < cut) rows.splice(i, 1); return { count: before - rows.length }; },
    },
  };
}

test('recording: opens, previews and checkouts with their area and door; once per device per day; never a crawler; never throws', async () => {
  const db = visitsDb();
  assert.deepEqual(await recordLinkVisit({ prisma: db, req: req(UA.chromeAndroid, DBN), kind: 'OPEN', code: 'prabcdef', accountId: 'acc1', source: 'r' }), { recorded: 'OPEN' });
  assert.deepEqual(db.rows[0], { kind: 'OPEN', code: 'PRABCDEF', accountId: 'acc1', source: 'r', country: 'ZA', region: 'KZN', city: 'Durban', latitude: -29.86, longitude: 31.02, device: 'mobile', os: 'Android', browser: 'Chrome', app: null, visitorKey: db.rows[0].visitorKey });
  assert.ok(!JSON.stringify(db.rows[0]).includes('41.13.200.7'), 'the IP is never stored');
  assert.deepEqual(await recordLinkVisit({ prisma: db, req: req(UA.chromeAndroid, DBN), kind: 'OPEN', code: 'PRABCDEF', accountId: 'acc1' }), { skipped: 'DUPLICATE' });
  assert.deepEqual(await recordLinkVisit({ prisma: db, req: req(UA.whatsappPreviewAndroid, DBN, '41.13.9.9'), kind: 'OPEN', code: 'PRABCDEF' }), { recorded: 'PREVIEW' });
  assert.deepEqual(await recordLinkVisit({ prisma: db, req: req(UA.metaCrawler, { country: 'IE' }), kind: 'OPEN', code: 'PRABCDEF' }), { skipped: 'BOT' });
  assert.deepEqual(await recordLinkVisit({ prisma: db, req: req(UA.chromeAndroid, DBN), kind: 'CHECKOUT', code: 'PRABCDEF' }), { recorded: 'CHECKOUT' });
  assert.deepEqual(await recordLinkVisit({ prisma: {}, req: req(UA.chromeAndroid), kind: 'OPEN', code: 'PRABCDEF' }), { skipped: 'NO_TABLE' }, 'before the migration: nothing, no error');
  assert.equal((await recordLinkVisit({ prisma: visitsDb({ failWith: new Error('db down') }), req: req(UA.chromeAndroid), kind: 'OPEN', code: 'PRABCDEF' })).error, 'db down');
  const started = Date.now();
  assert.deepEqual(await recordLinkVisit({ prisma: visitsDb({ slowMs: 2000 }), req: req(UA.chromeAndroid), kind: 'OPEN', code: 'PRABCDEF', capMs: 50 }), { skipped: 'TIMEOUT' });
  assert.ok(Date.now() - started < 1000, 'a slow database never holds the page');
  const seen = visitsDb();
  await recordAccountSeen({ prisma: seen, req: req(UA.chromeAndroid, DBN), accountId: 'acc1' });
  assert.deepEqual(await recordAccountSeen({ prisma: seen, req: req(UA.safariIphone, DBN, '10.0.0.1'), accountId: 'acc1' }), { skipped: 'DUPLICATE' }, 'once a day per account, whatever the device');
  assert.equal(seen.rows[0].kind, 'SEEN'); assert.equal(seen.rows[0].code, '');
});

test('the door tags: ?s=r a reminder, t tap-to-send, w a web share, b the business portal; anything else is ignored', () => {
  assert.equal(paymentRequestUrl('PRABCDEF'), 'https://pleasepayme.co.za/PRABCDEF');
  assert.equal(paymentRequestUrl('PRABCDEF', 'r'), 'https://pleasepayme.co.za/PRABCDEF?s=r');
  assert.equal(paymentRequestUrl('PRABCDEF', 'evil"'), 'https://pleasepayme.co.za/PRABCDEF');
  assert.equal(sourceTag('R '), 'r'); assert.equal(sourceTag('x'), null); assert.equal(sourceTag('<script>'), null);
});

test('retention: visits older than 90 days are deleted', async () => {
  const db = visitsDb(); const now = Date.parse('2026-10-25T00:00:00Z');
  db.rows.push({ kind: 'OPEN', createdAt: new Date(now - 91 * 86400e3) }, { kind: 'OPEN', createdAt: new Date(now - 89 * 86400e3) });
  assert.deepEqual(await pruneLinkVisits({ prisma: db, now }), { deleted: 1 });
  assert.equal(db.rows.length, 1);
});

const NOW = Date.parse('2026-10-25T10:00:00Z');
const at = (h) => new Date(NOW - h * 3600e3);
const VISITS = [
  { kind: 'CHECKOUT', code: 'PRAAAAAA', accountId: 'a1', source: null, country: 'ZA', region: 'KZN', city: 'Durban', latitude: -29.86, longitude: 31.02, device: 'mobile', os: 'Android', browser: 'Chrome', app: null, createdAt: at(1) },
  { kind: 'OPEN', code: 'PRAAAAAA', accountId: 'a1', source: 'r', country: 'ZA', region: 'KZN', city: 'Durban', latitude: -29.86, longitude: 31.02, device: 'mobile', os: 'Android', browser: 'Chrome', app: null, createdAt: at(2) },
  { kind: 'OPEN', code: 'PRAAAAAA', accountId: 'a1', source: null, country: 'ZA', region: 'GP', city: 'Soweto', latitude: -26.27, longitude: 27.86, device: 'mobile', os: 'iOS', browser: 'Safari', app: null, createdAt: at(3) },
  { kind: 'PREVIEW', code: 'PRAAAAAA', accountId: 'a1', source: null, country: 'ZA', region: 'GP', city: 'Johannesburg', latitude: -26.2, longitude: 28.05, device: 'mobile', os: 'Android', browser: null, app: 'WhatsApp', createdAt: at(4) },
  { kind: 'SEEN', code: '', accountId: 'a1', source: null, country: 'ZA', region: 'GP', city: 'Johannesburg', latitude: -26.2, longitude: 28.05, device: 'mobile', os: 'Android', browser: 'Chrome', app: null, createdAt: at(5) },
  { kind: 'OPEN', code: 'PRBBBBBB', accountId: 'a2', source: null, country: 'US', region: 'CA', city: 'San Jose', latitude: 37.34, longitude: -121.89, device: 'desktop', os: 'Windows', browser: 'Edge', app: null, createdAt: at(6) },
  { kind: 'CREATED', code: 'PRBBBBBB', accountId: 'a2', source: 'web', country: 'ZA', region: 'WC', city: 'Cape Town', latitude: -33.92, longitude: 18.42, device: 'desktop', os: 'Windows', browser: 'Edge', app: null, createdAt: at(7) },
  { kind: 'OPEN', code: 'PRBBBBBB', accountId: 'a2', source: 'w', country: null, region: null, city: null, latitude: null, longitude: null, device: 'mobile', os: 'Android', browser: 'Chrome', app: null, createdAt: at(8) },
];
const LINKS = [
  { id: 'PRAAAAAA', accountId: 'a1', amountCents: 15000, status: 'PAID', createdAt: at(6), paidAt: at(1), businessId: null },
  { id: 'PRBBBBBB', accountId: 'a2', amountCents: 50000, status: 'PENDING', createdAt: at(7), paidAt: null, businessId: null },
];
const mapDb = { linkVisit: { async findMany({ where }) { return where?.code ? VISITS.filter((v) => v.code === where.code).reverse() : VISITS; } }, paymentRequest: { async findMany() { return LINKS; }, async findUnique({ where }) { return LINKS.find((l) => l.id === where.id) ? { ...LINKS.find((l) => l.id === where.id), note: 'braids' } : null; } } };

test('the map: where links were made, shared, opened and paid from; provinces, towns, doors, devices; abroad flagged', async () => {
  const v = await linkMapView({ prisma: mapDb, days: 30, now: NOW });
  assert.deepEqual(v.totals, { made: 2, madeOnWeb: 1, madeForBusiness: 0, opened: 2, opens: 4, shared: 1, checkouts: 1, paid: 1, unknownArea: 1 });
  assert.deepEqual(v.points.find((p) => p.group === 'opened' && p.city === 'Durban'), { group: 'opened', lat: -29.86, lng: 31.02, city: 'Durban', province: 'KwaZulu-Natal', country: 'ZA', count: 1 });
  assert.ok(v.points.some((p) => p.group === 'paid' && p.city === 'Durban'));
  assert.ok(v.points.some((p) => p.group === 'shared' && p.city === 'Johannesburg'));
  assert.ok(v.points.some((p) => p.group === 'requester' && p.city === 'Cape Town'));
  assert.deepEqual(v.provinces.find((p) => p.province === 'Gauteng'), { province: 'Gauteng', opened: 1, paid: 0, shared: 1, requesters: 1 });
  assert.deepEqual(v.abroad, [{ country: 'US', count: 1 }]);
  assert.deepEqual(v.doors.map((d) => d.door).sort(), ['first message', 'reminder', 'web app share']);
  const a = v.recent.find((l) => l.code === 'PRAAAAAA');
  assert.deepEqual({ madeIn: a.madeIn, basis: a.madeInBasis, sharedFrom: a.sharedFrom, paidFrom: a.paidFrom, channel: a.channel }, { madeIn: 'Johannesburg, Gauteng', basis: "requester's web app area", sharedFrom: 'Johannesburg, Gauteng', paidFrom: 'Durban, KwaZulu-Natal', channel: 'WhatsApp' });
  assert.deepEqual(a.openedIn.sort(), ['Durban, KwaZulu-Natal', 'Soweto, Gauteng']);
  const b = v.recent.find((l) => l.code === 'PRBBBBBB');
  assert.equal(b.channel, 'web app'); assert.equal(b.madeIn, 'Cape Town, Western Cape'); assert.equal(b.madeInBasis, 'made here');
  const t = await linkTimeline({ prisma: mapDb, code: 'praaaaaa' });
  assert.equal(t.ok, true); assert.equal(t.link.note, 'braids');
  assert.deepEqual(t.events.map((e) => e.kind), ['SEEN', 'PREVIEW', 'OPEN', 'OPEN', 'CHECKOUT'].filter((k) => k !== 'SEEN'));
  assert.equal(t.events.find((e) => e.kind === 'OPEN' && e.door === 'reminder').area, 'Durban, KwaZulu-Natal');
  assert.deepEqual(await linkTimeline({ prisma: mapDb, code: 'nope' }), { ok: false, error: 'BAD_CODE' });
  const csv = await linkVisitsCsv({ prisma: { linkVisit: { async findMany() { return [{ ...VISITS[1], city: 'Durban, "North"' }]; } } }, days: 30, now: NOW });
  assert.equal(csv.split('\n')[0], 'time_utc,event,link,door,country,province,city,device,os,browser,app');
  assert.match(csv.split('\n')[1], /,OPEN,PRAAAAAA,reminder,ZA,KwaZulu-Natal,"Durban, ""North""",mobile,Android,Chrome,$/);
  assert.ok(!csv.includes('a1'), 'no account ids in the export');
});

test('triage: a card payer who pressed pay from outside South Africa adds to the fraud score', async () => {
  const account = { id: 'acc-abroad-00000000001', waId: '27731234567', createdAt: new Date(NOW - 60 * 86400e3), profile: {} };
  const prisma = {
    account: { async findUnique() { return account; }, async findMany() { return []; } },
    paymentRequest: { async findMany() { return []; } },
    providerRequest: { async findMany() { return []; } },
    journalEntry: { async findMany() { return []; } },
    wallet: { async findMany() { return [{ availableCents: 100000 }]; } },
    linkVisit: { async findMany({ where }) { assert.equal(where.kind, 'CHECKOUT'); assert.deepEqual(where.country, { not: null, notIn: ['ZA'] }); return [{ country: 'US' }, { country: 'NG' }, { country: 'US' }]; } },
  };
  const t = await payoutTriage({ prisma, account, amountCents: 20000, method: 'PAYSHAP', now: NOW });
  const r = t.reasons.find((x) => x.code === 'FOREIGN_PAYER');
  assert.equal(r.points, 2); assert.equal(r.text, 'a payer pressed pay from outside South Africa (US, NG)');
});

test('source locks: every door records, the payer is told, the cron deletes, Mission Control shows it, nothing loads from a CDN', () => {
  const page = read('../pages/pay/[code].js');
  assert.match(page, /await recordLinkVisit\(\{ req, kind: 'OPEN', code, accountId: request\.accountId, source: sourceTag\(query\?\.s\) \}\);/);
  assert.match(page, /WaPay notes the rough area this page is opened from \(from your internet connection, never your exact location\) and keeps it for 90 days\./);
  const checkout = read('../pages/api/pay/checkout.js');
  assert.ok(checkout.indexOf("await recordLinkVisit({ req, kind: 'CHECKOUT'") > checkout.indexOf('businessRequestPayable({ request })'), 'recorded only once the link is payable');
  assert.match(read('../pages/api/app/links.js'), /kind: 'CREATED', code: out\.link\.code, accountId: account\.id, source: 'web'/);
  assert.match(read('../pages/api/business/links.js'), /kind: 'CREATED', code: out\.link\.code, accountId: business\.accountId \|\| null, source: 'business'/);
  assert.match(read('../pages/api/app/home.js'), /await recordAccountSeen\(\{ prisma: deps\.prisma, req, accountId: g\.session\.account\?\.id \}\);/);
  assert.match(read('../pages/api/cron/daily-vas-sync.js'), /pruneLinkVisits\(\{ prisma \}\)/);
  const admin = read('../pages/admin/index.js');
  assert.match(admin, /\['links', 'Link map'\]/); assert.match(admin, /tab === 'links' \? <LinkMapTab \/>/);
  const tab = read('../components/admin/LinkMapTab.js');
  assert.match(tab, /await import\('leaflet'\)/); assert.match(tab, /import 'leaflet\/dist\/leaflet\.css';/);
  assert.ok(!/<script|cdnjs|unpkg|jsdelivr/.test(tab), 'the map library is bundled, never fetched from a CDN into the admin console');
  assert.match(read('../package.json'), /"leaflet": "1\.9\.4"/, 'pinned');
  assert.match(read('../packages/domain/prisma/migrations/20261025_link_visits/migration.sql'), /CREATE TABLE IF NOT EXISTS "link_visits"/);
});
