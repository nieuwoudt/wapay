// Where payment links travel (founder 2026-10-25): the pay page, checkout, link creation and the web app record
// the area from the internet connection (never GPS, never the IP), once per device per link per day; Mission
// Control draws it; the triage reads where payers paid from; visits are deleted after 90 days.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { geoOf, classifyVisitor, visitorKeyOf, recordLinkVisit, recordAccountSeen, pruneLinkVisits, sourceTag, provinceName, sastDay } = await import('../lib/link-visits.js');
const { linkMapView, linkTimeline, linkVisitsCsv, PIN_STATUSES, pinStatusOf, groupPins, flagOf, countryName } = await import('../lib/link-map.js');
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
  // The pins (2026-10-26): each link at every place it touched, coloured by the link (PRAAAAAA paid, PRBBBBBB requested).
  const pin = (status, city) => v.pins.find((p) => p.status === status && p.city === city);
  assert.deepEqual(pin('paid', 'Durban'), { status: 'paid', lat: -29.86, lng: 31.02, city: 'Durban', province: 'KwaZulu-Natal', country: 'ZA', place: 'Durban, KwaZulu-Natal', flag: '', count: 1, codes: ['PRAAAAAA'], links: [{ code: 'PRAAAAAA', amountCents: 15000, at: at(1).toISOString(), did: ['opened', 'paid from'] }] });
  assert.deepEqual(pin('paid', 'Johannesburg').links[0].did, ["requester's area", 'shared from'], "made in WhatsApp: shown at its requester's web app area, and where it was shared from");
  assert.deepEqual(pin('paid', 'Soweto').links[0].did, ['opened']);
  assert.deepEqual(pin('requested', 'Cape Town').links[0].did, ['made'], 'made on the web app: shown where it was made');
  assert.deepEqual([pin('requested', 'San Jose').place, pin('requested', 'San Jose').flag], ['San Jose, United States', '🇺🇸']);
  assert.equal(v.pins.length, 5, 'an open without an area has no pin');
  assert.deepEqual(v.statuses.map((s) => [s.status, s.colour, s.links]), [['paid', '#359853', 1], ['requested', '#2a78d6', 1], ['closed', '#8a948d', 0]]);
  assert.ok(!/accountId|"a1"|"a2"/.test(JSON.stringify(v.pins)), 'link codes, amounts and areas only: no account on the map');
  assert.deepEqual(v.provinces.find((p) => p.province === 'Gauteng'), { province: 'Gauteng', opened: 1, paid: 0, shared: 1, requesters: 1 });
  assert.deepEqual(v.abroad, [{ country: 'US', flag: '🇺🇸', name: 'United States', count: 1, links: { paid: 0, requested: 1, closed: 0 } }]);
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

test('pin colours: green when the link is paid, blue while requested, grey once cancelled or expired', () => {
  const now = Date.parse('2026-10-26T08:00:00Z');
  assert.deepEqual(PIN_STATUSES.map((s) => [s.status, s.label, s.colour]), [['paid', 'Paid', '#359853'], ['requested', 'Requested', '#2a78d6'], ['closed', 'Closed', '#8a948d']]);
  assert.equal(new Set(PIN_STATUSES.map((s) => s.colour)).size, 3);
  assert.equal(pinStatusOf({ status: 'PAID' }, now), 'paid');
  assert.equal(pinStatusOf({ status: 'PENDING', expiresAt: new Date(now + 3600e3) }, now), 'requested');
  assert.equal(pinStatusOf({ status: 'PENDING' }, now), 'requested');
  assert.equal(pinStatusOf({ status: 'PENDING', expiresAt: new Date(now - 1) }, now), 'closed', 'pending past its expiry is expired, as getPaymentRequest reads it');
  assert.equal(pinStatusOf({ status: 'CANCELLED' }, now), 'closed');
  assert.equal(pinStatusOf({ status: 'EXPIRED' }, now), 'closed');
  assert.equal(pinStatusOf(undefined, now), null, 'no link, no pin');
  assert.equal(pinStatusOf({ status: 'SOMETHING_NEW' }, now), null);
});

test('grouping: one pin per place and status, each link counted once, the newest five described', () => {
  const JHB = { lat: -26.2, lng: 28.05, city: 'Johannesburg', province: 'Gauteng', country: 'ZA' };
  const DBN_AT = { lat: -29.86, lng: 31.02, city: 'Durban', province: 'KwaZulu-Natal', country: 'ZA' };
  const placed = (code, status, did, h, where = JHB, amountCents = 500) => ({ code, amountCents, status, did, at: at(h), ...where });
  const placements = [
    placed('PRAAAAAA', 'requested', 'opened', 5, JHB, 1000), placed('PRAAAAAA', 'requested', 'opened', 4, JHB, 1000), placed('PRAAAAAA', 'requested', 'shared from', 6, JHB, 1000),
    placed('PRBBBBBB', 'paid', 'paid from', 3), placed('PRBBBBBB', 'paid', 'opened', 3, DBN_AT),
    ...['PRCCCCCC', 'PRDDDDDD', 'PREEEEEE', 'PRFFFFFF', 'PRGGGGGG', 'PRHHHHHH'].map((code, i) => placed(code, 'requested', 'opened', 10 + i)),
    placed('PRIIIIII', 'requested', 'opened', 1, { lat: null, lng: null, city: null, province: null, country: null }),
  ];
  const pins = groupPins(placements);
  assert.deepEqual(pins.map((p) => [p.status, p.city, p.count]), [['requested', 'Johannesburg', 7], ['paid', 'Durban', 1], ['paid', 'Johannesburg', 1]], 'busiest first; a placement without a point has no pin');
  const busy = pins[0];
  assert.equal(busy.codes.length, 7, 'PRAAAAAA counts once however often it touched Johannesburg');
  assert.deepEqual(busy.links[0], { code: 'PRAAAAAA', amountCents: 1000, at: at(4).toISOString(), did: ['shared from', 'opened ×2'] });
  assert.deepEqual(busy.links.map((l) => l.code), ['PRAAAAAA', 'PRCCCCCC', 'PRDDDDDD', 'PREEEEEE', 'PRFFFFFF'], 'the hover card describes the newest five; the count stays exact');
  assert.equal(busy.place, 'Johannesburg, Gauteng');
  assert.deepEqual(pins.slice(1).map((p) => p.links[0].did), [['opened'], ['paid from']], 'one link, two places, two pins');
  assert.equal(groupPins(placements, { cap: 2 })[0].links.length, 2);
});

test('flags: a country code becomes its flag from regional-indicator letters, and its name', () => {
  assert.equal(flagOf('US'), '🇺🇸'); assert.equal(flagOf('ke'), '🇰🇪'); assert.equal(flagOf(' pk '), '🇵🇰');
  assert.equal(flagOf('ZA'), '\u{1F1FF}\u{1F1E6}');
  for (const bad of ['ZAF', '1A', '<b', '', null, undefined]) assert.equal(flagOf(bad), '', String(bad));
  assert.equal(countryName('KE'), 'Kenya'); assert.equal(countryName('us'), 'United States'); assert.equal(countryName('nope'), null);
});

test("older links still being opened are looked up for their status; the window's totals stay the window's", async () => {
  const asked = [];
  const old = { id: 'PROLDAAA', accountId: 'a9', amountCents: 65000, status: 'PENDING', createdAt: new Date(NOW - 40 * 86400e3), paidAt: null, expiresAt: new Date(NOW - 86400e3), businessId: null };
  const db = {
    linkVisit: { async findMany() { return [{ kind: 'OPEN', code: 'PROLDAAA', accountId: 'a9', source: null, country: 'KE', region: '30', city: 'Nairobi', latitude: -1.29, longitude: 36.82, device: 'mobile', os: 'Android', browser: 'Chrome', app: null, createdAt: at(2) }]; } },
    paymentRequest: { async findMany({ where }) { asked.push(where); return where.id ? [old].filter((l) => where.id.in.includes(l.id)) : []; } },
  };
  const v = await linkMapView({ prisma: db, days: 30, now: NOW });
  assert.deepEqual(asked[1], { id: { in: ['PROLDAAA'] } });
  assert.equal(v.totals.made, 0, 'made 40 days ago: not one of the 30-day window');
  assert.deepEqual(v.pins.map((p) => [p.status, p.place, p.flag, p.count]), [['closed', 'Nairobi, Kenya', '🇰🇪', 1]], 'pending past its expiry shows grey');
  assert.deepEqual(v.abroad, [{ country: 'KE', flag: '🇰🇪', name: 'Kenya', count: 1, links: { paid: 0, requested: 0, closed: 1 } }]);
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
  // The admin page styles every svg width:100%, which squashed Leaflet's vector pane to 0px and hid the first
  // map's circle markers (founder 2026-10-26): the pins are HTML markers, and any svg on the map is reset.
  assert.match(tab, /L\.divIcon\(/); assert.ok(!/circleMarker|L\.circle\(|L\.polyline|L\.polygon/.test(tab), 'no SVG vector markers');
  assert.match(tab, /\.lm-map \.leaflet-pane svg\{width:auto;height:auto\}/);
  assert.ok(existsSync(fileURLToPath(new URL('../public/brand/wapay-mark-64-white.png', import.meta.url))), 'the white W-mark the pins carry');
  const card = tab.slice(tab.indexOf('function tipHtml('), tab.indexOf('function LinkMap('));
  for (const [, expr] of card.slice(card.indexOf('return `')).matchAll(/\$\{([^}]*)/g)) assert.match(expr, /^(esc|colourOf)\(/, `hover card text is escaped: ${expr}`);
  assert.match(read('../package.json'), /"leaflet": "1\.9\.4"/, 'pinned');
  assert.match(read('../packages/domain/prisma/migrations/20261025_link_visits/migration.sql'), /CREATE TABLE IF NOT EXISTS "link_visits"/);
});
