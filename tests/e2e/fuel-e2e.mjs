/**
 * pnpm qa:fuel — full-money E2E of the fuel wiCode pipeline (v1.3 Task 3).
 *
 * REQUIREMENTS (see docs/UNIFUEL_INTEGRATION.md):
 *  - DATABASE_URL pointing at the ISOLATED scratch schema
 *    (…?schema=wapay_qa_e2e_v13), created with `prisma db push`.
 *    The guard below refuses to run against any other schema.
 *  - The UniFuel dev server on localhost:3300 with
 *    WAPAY_PARTNER_SECRET=wapay-e2e-secret-491a1a32 (Yoyo TEST env).
 *  - --experimental-test-module-mocks (WhatsApp transport is mocked;
 *    nothing reaches a phone; Yoyo issuance is REAL on the test env).
 */
import { mock } from 'node:test';

// --- env BEFORE any repo import ---
const RAW = process.env.DATABASE_URL || '';
if (!/schema=wapay_qa_e2e_v13/.test(RAW)) {
  console.error('FATAL: DATABASE_URL must point at the scratch schema');
  process.exit(2);
}
process.env.UNIFUEL_API_BASE_URL = 'http://localhost:3300';
process.env.UNIFUEL_PARTNER_SECRET = 'wapay-e2e-secret-491a1a32';
process.env.WAPAY_INTERNAL_API_KEY = 'e2e-internal-key';
process.env.WAPAY_WICODE_LIVE = 'true';
// Leg 2 needs WaPay's preview to ACCEPT an amount UniFuel range-rejects,
// so the WaPay-side cap is lifted for this run only.
process.env.WAPAY_FUEL_MAX_CENTS = '500000';

// Capture outbound WhatsApp (same idiom as tests/e2e/chat-harness.mjs).
const outbox = [];
mock.module('@wapay/whatsapp', {
  namedExports: {
    sendWhatsAppText: async ({ to, text }) => { outbox.push({ to, text }); return { ok: true }; },
    sendWhatsAppTemplate: async () => ({ ok: true }),
    sendWhatsAppCtaUrl: async () => ({ ok: true }),
    seedWhatsappTemplates: async () => ({}),
  },
});

const { default: prisma } = await import('../../lib/prisma.js');
// setPIN's `import * as argon2` interop breaks outside Next's bundler
// (argon2id constant undefined in plain-node ESM), so the auth factor is
// seeded directly with the same argon2id + pepper recipe verifyPIN expects.
const { default: argon2 } = await import('argon2');
const { buildLoad, RAIL, BALANCE } = await import('../../lib/ledger-core.js');
const { postEntry, ensureWallet, trialBalance } = await import('../../lib/ledger-post.js');
const { default: previewHandler } = await import('../../pages/api/vas/fuel/preview.js');
const { default: executeHandler } = await import('../../pages/api/vas/fuel/execute.js');
const { default: webhookHandler } = await import('../../pages/api/webhooks/unifuel.js');

const MSISDN = '27600000902';
const PIN = '1934';
let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) { pass++; console.log(`  ✅ ${what}`); } else { fail++; console.log(`  ❌ ${what}`); } };

function call(handler, { method = 'POST', body = {}, headers = {}, query = {} } = {}) {
  return new Promise((resolve) => {
    const res = { headers: {}, statusCode: null, body: null };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; resolve(res); return res; };
    handler({ method, body, query, headers: { 'x-internal-api-key': 'e2e-internal-key', authorization: `Bearer ${process.env.UNIFUEL_PARTNER_SECRET}`, ...headers } }, res);
  });
}

const wallet = async () => prisma.wallet.findFirst({ where: { account: undefined, accountId: acct.id, balanceType: 'SPEND' } });

// --- seed ---
console.log('SEED: wipe scratch schema, account + load + PIN');
// The schema is an isolated QA namespace — start every run clean.
for (const model of ['journalLine', 'journalEntry', 'hold', 'pendingGift', 'providerRequest', 'authFactor', 'auditLog', 'wallet', 'account']) {
  await prisma[model].deleteMany({});
}
const acct = await prisma.account.create({
  data: { waId: MSISDN, msisdn: MSISDN, displayName: 'Fuel E2E', onboardingState: 'S5_COMPLETED', status: 'ACTIVE' },
});
await ensureWallet({ accountId: acct.id, balanceType: BALANCE.SPEND });
await postEntry(buildLoad({ accountId: acct.id, rail: RAIL.PAYFAST, faceCents: 150000, idemKey: `e2e-load-${acct.id}` }));
const pepper = process.env.PIN_PEPPER || 'wapay_pin_pepper_2025_change_in_production';
const secretHash = await argon2.hash(PIN + pepper, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
await prisma.authFactor.create({ data: { id: `pin_e2e_${acct.id}`, accountId: acct.id, type: 'PIN', secretHash, attempts: 0, setAt: new Date() } });
ok(true, 'PIN factor seeded');
let w = await wallet();
ok(w.availableCents === 150000, `wallet funded R1500 (got ${w.availableCents}c)`);

// --- leg 1: happy path (REAL Yoyo TEST issuance through local UniFuel) ---
console.log('LEG 1: happy path');
const p1 = await call(previewHandler, { body: { accountId: acct.id, amountCents: 5000 } });
ok(p1.statusCode === 200 && p1.body.ok, `preview ok (${p1.statusCode})`);
const e1 = await call(executeHandler, { body: { previewId: p1.body.previewId, accountId: acct.id, pin: PIN } });
ok(e1.statusCode === 200 && e1.body.ok === true, `execute ok (${e1.statusCode} ${JSON.stringify(e1.body).slice(0, 120)})`);
ok(e1.body.testMode === true, 'testMode flag surfaced');
w = await wallet();
ok(w.availableCents === 145000 && w.pendingCents === 0, `wallet debited to R1450, no pending (got ${w.availableCents}/${w.pendingCents})`);
const gift1 = await prisma.pendingGift.findUnique({ where: { idemKey: `wapay-fuel-gift-${p1.body.previewId}` } });
ok(gift1 && gift1.rail === 'YOYO' && /^\d{6,}$/.test(gift1.voucherPin), 'pendingGift holds a real wiCode on rail YOYO');
ok(!JSON.stringify(e1.body).includes(gift1.voucherPin), 'the wiCode bearer secret never rides the HTTP response');
const hold1 = await prisma.hold.findUnique({ where: { idemKey: `wapay-fuel-exec-${p1.body.previewId}` } });
ok(hold1?.status === 'SETTLED', `hold settled (${hold1?.status})`);
const yoyoLines = await prisma.journalLine.aggregate({ where: { accountCode: 'CLEARING:YOYO' }, _sum: { debitCents: true, creditCents: true } });
ok((yoyoLines._sum.creditCents || 0) === 5000, `CLEARING:YOYO credited 5000c (got ${yoyoLines._sum.creditCents})`);
const tb1 = await trialBalance();
ok(tb1.balanced, 'trial balance balanced');

// idempotent re-execute: same preview is already consumed → no double spend
const e1b = await call(executeHandler, { body: { previewId: p1.body.previewId, accountId: acct.id, pin: PIN } });
ok(e1b.statusCode === 404, `re-execute of consumed preview refused (${e1b.statusCode})`);
w = await wallet();
ok(w.availableCents === 145000, 'no double charge');

// --- leg 2: FAILED path (R600 passes WaPay bounds, UniFuel range-rejects) ---
console.log('LEG 2: definitive failure releases the hold');
const p2 = await call(previewHandler, { body: { accountId: acct.id, amountCents: 60000 } });
ok(p2.statusCode === 200, `preview R600 ok (${p2.statusCode})`);
const e2 = await call(executeHandler, { body: { previewId: p2.body.previewId, accountId: acct.id, pin: PIN } });
ok(e2.statusCode === 400 && /range/i.test(e2.body.message || ''), `range failure surfaced (${e2.statusCode}: ${e2.body.message})`);
const hold2 = await prisma.hold.findUnique({ where: { idemKey: `wapay-fuel-exec-${p2.body.previewId}` } });
ok(hold2?.status === 'RELEASED', `hold released (${hold2?.status})`);
w = await wallet();
ok(w.availableCents === 145000 && w.pendingCents === 0, 'money back after failure');

// --- leg 3: UNKNOWN path (dead service) then heal ---
console.log('LEG 3: indeterminate keeps the hold, then heals');
const p3 = await call(previewHandler, { body: { accountId: acct.id, amountCents: 6000 } });
process.env.UNIFUEL_API_BASE_URL = 'http://localhost:9';
const e3 = await call(executeHandler, { body: { previewId: p3.body.previewId, accountId: acct.id, pin: PIN } });
ok(e3.statusCode === 202 && e3.body.error === 'PENDING_CONFIRMATION', `unknown → 202 PENDING_CONFIRMATION (${e3.statusCode})`);
const hold3a = await prisma.hold.findUnique({ where: { idemKey: `wapay-fuel-exec-${p3.body.previewId}` } });
ok(hold3a?.status === 'ACTIVE', `hold KEPT on unknown (${hold3a?.status})`);
const pr3 = await prisma.providerRequest.findUnique({ where: { id: p3.body.previewId } });
ok(pr3?.status === 'RECONCILE', `preview marked RECONCILE (${pr3?.status})`);
process.env.UNIFUEL_API_BASE_URL = 'http://localhost:3300';
const e3b = await call(executeHandler, { body: { previewId: p3.body.previewId, accountId: acct.id, pin: PIN } });
ok(e3b.statusCode === 200 && e3b.body.ok, `retry heals to issued (${e3b.statusCode})`);
const hold3b = await prisma.hold.findUnique({ where: { idemKey: `wapay-fuel-exec-${p3.body.previewId}` } });
ok(hold3b?.status === 'SETTLED', `hold settled after heal (${hold3b?.status})`);
w = await wallet();
ok(w.availableCents === 139000 && w.pendingCents === 0, `wallet at R1390 after two purchases (got ${w.availableCents})`);
const tb2 = await trialBalance();
ok(tb2.balanced, 'trial balance still balanced');

// --- leg 4: redemption webhook (synthetic partial with fresh code) ---
console.log('LEG 4: partial redemption webhook re-arms a fresh code');
const ref1 = e1.body.reference;
// mark gift1 delivered first (as the chat flow would have)
await prisma.pendingGift.update({ where: { id: gift1.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
outbox.length = 0;
const wh = await call(webhookHandler, {
  body: { reference: ref1, event: 'partial_redemption', amountUsedCents: 2000, balanceCents: 3000, newWicode: '999888777666' },
});
ok(wh.statusCode === 200 && wh.body.ok, `webhook accepted (${wh.statusCode})`);
const gift1b = await prisma.pendingGift.findUnique({ where: { id: gift1.id } });
ok(gift1b.voucherPin === '999888777666' && gift1b.amountCents === 3000, 'gift row carries the fresh code + remaining balance');
ok(outbox.some((m) => m.text.includes('999888777666')), 'fresh wiCode delivered via captured send');
ok(gift1b.status === 'DELIVERED', `gift re-delivered atomically (${gift1b.status})`);
// unauthorized webhook is refused
const whBad = await call(webhookHandler, { headers: { authorization: 'Bearer wrong' }, body: { reference: ref1, event: 'redemption' } });
ok(whBad.statusCode === 401, `bad bearer refused (${whBad.statusCode})`);

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
