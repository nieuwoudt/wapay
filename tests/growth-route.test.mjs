/**
 * Growth tab wiring (2026-10-10): the route is admin-gated before any query,
 * the webhook hands the ad referral to the processor, the processor hands it
 * to getOrCreateUser and fires the two growth hooks, Mission Control has the
 * tab, the daily cron snapshots ads and sweeps the Conversions API, and no
 * new surface carries a betting word or a cash-out promise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const route = read('../pages/api/admin/growth.js');
const webhook = read('../pages/api/webhooks/whatsapp.js');
const processor = read('../pages/api/webhooks/message-processor-v2.js');
const userManager = read('../pages/api/webhooks/user-manager.js');
const page = read('../pages/admin/index.js');
const cron = read('../pages/api/cron/daily-vas-sync.js');
const metrics = read('../pages/api/admin/metrics.js');

test('growth route: 401 before the first query, GET only, aggregates only', async () => {
  delete process.env.WAPAY_ADMIN_MSISDNS;
  delete process.env.WAPAY_ADMIN_SESSION_SECRET;
  const { default: handler } = await import('../pages/api/admin/growth.js');
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ method: 'GET', query: {}, headers: {}, cookies: {} }, res);
  assert.equal(res.statusCode, 401);
  const r2 = { ...res, statusCode: 0 };
  await handler({ method: 'POST', query: {}, headers: {}, cookies: {} }, r2);
  assert.equal(r2.statusCode, 405);
  const handlerStart = route.indexOf('export default async function handler');
  assert.ok(route.indexOf('requireAdmin(req)', handlerStart) < route.indexOf('prisma.', handlerStart), 'auth before any query');
  // The SQL may COUNT distinct payer numbers; nothing identifying may be
  // selected into a row or placed in the response.
  const response = route.slice(route.indexOf('return res.status(200).json('));
  assert.doesNotMatch(response, /msisdn|waId|displayName|voucherPin|ctwaClid/i, 'no customer identifier in the response');
  assert.doesNotMatch(route, /select: \{[^}]*(msisdn|waId|displayName|voucherPin)/i, 'no customer identifier is selected');
});

test('the referral travels webhook → processor → getOrCreateUser, and the growth hooks are wired', () => {
  assert.match(webhook, /referral: message\.referral \|\| null/);
  assert.match(processor, /export async function processMessage\(\{ from, text, messageId, profile, sharedContact, referral = null \}\)/);
  assert.match(processor, /getOrCreateUser\(from, profile, \{ referral \}\)/);
  assert.match(processor, /await growthOnTurn\(\{ account, referral \}\)\.catch/);
  assert.match(processor, /await growthOnOnboarded\(\{ account \}\)\.catch/);
  assert.match(userManager, /getOrCreateUser\(waId, profile = \{\}, \{ referral = null \} = \{\}\)/);
  assert.match(userManager, /profile: growthProfile/);
  // The onboarded hook sits inside the S5 block, after askAccountType.
  const s5 = processor.indexOf("=== 'S5_COMPLETED') {\n        await askAccountType");
  assert.ok(s5 > 0 && processor.indexOf('growthOnOnboarded({ account })', s5) - s5 < 600);
});

test('Mission Control: the Growth tab exists and the cron carries the growth steps', () => {
  assert.match(page, /setTab\('growth'\)/);
  assert.match(page, /function Growth\(\)/);
  assert.match(page, /\/api\/admin\/growth\?range=/);
  assert.match(cron, /snapshotAdInsights\(\{ prisma, days: 3 \}\)/);
  assert.match(cron, /capiSweep\(\{ prisma, limit: 50/);
  // Accounts = onboarding complete, in the metrics route too (BUGLOG #99).
  assert.match(metrics, /onboardingState: 'S5_COMPLETED'/);
  assert.match(metrics, /contactsStarted/);
});

test('no betting words and no cash-out promises in the new surfaces', () => {
  const banned = /\b(bet|betting|gambl|casino|wager|lotto)\b/i;
  const growthSection = page.slice(page.indexOf('/* ---------------- Growth'), page.indexOf('function Customer()'));
  assert.ok(growthSection.length > 1000, 'the Growth section was found');
  for (const [name, text] of [['route', route], ['page growth section', growthSection], ['cron', cron]]) {
    assert.doesNotMatch(text, banned, `${name} carries a betting word`);
  }
  for (const [name, text] of [['route', route], ['page growth section', growthSection]]) {
    assert.doesNotMatch(text, /cash out|cash-out|withdraw/i, `${name} promises cash-out`);
  }
});

test('ads pipe check: internal-key gated before any Graph call, GET only, every Graph call a GET, nothing created, no token in the output', async () => {
  const src = read('../pages/api/internal/ads-pipe-check.js');
  delete process.env.WAPAY_INTERNAL_API_KEY;
  const { default: handler } = await import('../pages/api/internal/ads-pipe-check.js');
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
  await handler({ method: 'GET', query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 401, 'fails closed without the key');
  const r2 = { ...res, statusCode: 0 };
  await handler({ method: 'POST', query: {}, headers: {} }, r2);
  assert.equal(r2.statusCode, 405);
  assert.ok(src.indexOf('keyOk(req)') < src.indexOf('await Promise.all'), 'auth before any Graph call');
  assert.match(src, /fetch\(url, \{ method: 'GET'/, 'the only fetch is a GET');
  assert.equal((src.match(/fetch\(/g) || []).length, 1, 'one fetch site');
  assert.doesNotMatch(src, /method: 'POST'|\/events|\/dataset`, token, \{ [^}]*create/, 'nothing posts to Graph');
  assert.match(src, /res\.status\(200\)\.send\(redactToken\(JSON\.stringify\(out\)\)\)/, 'the whole response passes through redaction');
  assert.doesNotMatch(src, /\btoken\b\s*:\s*token|token: ads\.token/, 'the token is never a field of the output');
});

test('the Growth route never lists the last-fetch marker as an ad', () => {
  assert.match(route, /adCatalog\.findMany\(\{ where: \{ NOT: \{ adId: LAST_FETCH_KEY \} \}/);
  assert.match(route, /adsLastFetchedAt: adsLastAt \|\| null/);
});

test('capi dataset and test-send routes: POST only, internal key, production only, nothing sent without the test code, redacted output', async () => {
  const dataset = read('../pages/api/internal/capi-dataset.js');
  const testSend = read('../pages/api/internal/capi-test-send.js');
  delete process.env.WAPAY_INTERNAL_API_KEY;
  const mk = () => ({ statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } });
  for (const mod of ['../pages/api/internal/capi-dataset.js', '../pages/api/internal/capi-test-send.js']) {
    const { default: handler } = await import(mod);
    const r1 = mk(); await handler({ method: 'GET', headers: {}, query: {} }, r1); assert.equal(r1.statusCode, 405, `${mod} GET`);
    const r2 = mk(); await handler({ method: 'POST', headers: {}, query: {} }, r2); assert.equal(r2.statusCode, 401, `${mod} no key`);
    process.env.WAPAY_INTERNAL_API_KEY = 'k-test'; process.env.VERCEL_ENV = 'preview';
    const r3 = mk(); await handler({ method: 'POST', headers: { 'x-internal-api-key': 'k-test' }, query: {} }, r3); assert.equal(r3.statusCode, 403, `${mod} preview`);
    delete process.env.WAPAY_INTERNAL_API_KEY; delete process.env.VERCEL_ENV;
  }
  // test-send: in production with the key but without a test code, nothing is sent (412 before any fetch)
  process.env.WAPAY_INTERNAL_API_KEY = 'k-test'; process.env.VERCEL_ENV = 'production'; delete process.env.META_CAPI_TEST_EVENT_CODE;
  const { default: sendHandler } = await import('../pages/api/internal/capi-test-send.js');
  const r4 = mk(); await sendHandler({ method: 'POST', headers: { 'x-internal-api-key': 'k-test' }, query: {} }, r4);
  assert.equal(r4.statusCode, 412); assert.equal(r4.body.error, 'TEST_CODE_MISSING');
  delete process.env.WAPAY_INTERNAL_API_KEY; delete process.env.VERCEL_ENV;
  // static locks
  assert.ok(dataset.indexOf("graph('GET'") < dataset.indexOf("graph('POST'"), 'reads before it creates');
  assert.equal((dataset.match(/graph\('POST'/g) || []).length, 1, 'exactly one create call');
  assert.match(dataset, /process\.env\.VERCEL_ENV !== 'production'/);
  assert.match(dataset, /send\(redactToken\(JSON\.stringify\(out\)\)\)/);
  assert.match(testSend, /process\.env\.VERCEL_ENV !== 'production'/);
  assert.ok(testSend.indexOf('TEST_CODE_MISSING') < testSend.indexOf('sendCapiEvents('), 'the test code is checked before the sender runs');
  assert.match(testSend, /req\.body\.testEventCode/, 'the code may arrive in the POST body');
  assert.match(testSend, /testEventCode: code \}/, 'and is handed to the sender for this one call');
  assert.doesNotMatch(testSend, /console\.(log|error)\([^)]*code/, 'the code is never logged');
  assert.doesNotMatch(testSend, /testEventCode: code,/, 'the code itself is never in the response');
  // A malformed body code is refused before the sender runs; a good one in a preview build is still 403.
  process.env.WAPAY_INTERNAL_API_KEY = 'k-test'; process.env.VERCEL_ENV = 'production'; delete process.env.META_CAPI_TEST_EVENT_CODE;
  const { default: sendHandler2 } = await import('../pages/api/internal/capi-test-send.js');
  const r5 = mk(); await sendHandler2({ method: 'POST', headers: { 'x-internal-api-key': 'k-test' }, query: {}, body: { testEventCode: 'bad code!' } }, r5);
  assert.equal(r5.statusCode, 400); assert.equal(r5.body.error, 'TEST_CODE_SHAPE');
  delete process.env.WAPAY_INTERNAL_API_KEY; delete process.env.VERCEL_ENV;
  assert.match(testSend, /eventName: CAPI_EVENTS\.LEAD/);
  assert.doesNotMatch(testSend, /updateProfile|patchAttribution|mergeProfile|prisma/, 'never touches a customer record');
  assert.match(testSend, /send\(redactToken\(JSON\.stringify\(out\)\)\)/);
  const probe = read('../pages/api/internal/ads-pipe-check.js');
  assert.match(probe, /env WHATSAPP_BUSINESS_ACCOUNT_ID \(fallback\)/, 'the probe names the fallback env honestly');
});

test('the pipe check reports the newest ad account without identifiers', () => {
  const probe = read('../pages/api/internal/ads-pipe-check.js');
  assert.match(probe, /latestAdAccount/);
  const block = probe.slice(probe.indexOf('SELECT a."createdAt" AS created_at'), probe.indexOf('ORDER BY a."createdAt" DESC LIMIT 1'));
  assert.doesNotMatch(block, /msisdn|waId|displayName|->>'ctwaClid' AS|->>'adId' AS|->>'headline' AS/, 'only booleans for the identifying fields');
});
