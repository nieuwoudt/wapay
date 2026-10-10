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
