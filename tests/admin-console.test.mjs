/**
 * Admin console (Mission Control) — auth semantics + route guards.
 *
 * Locks:
 * - FAIL CLOSED everywhere: unset envs → no login, no OTP send, no session,
 *   401 on every admin API;
 * - allowlist matches 073… / 2773… / +27… forms of the same number;
 * - OTP is stored HASHED, throttled to one send per minute, and each code
 *   allows exactly ONE verify attempt (a wrong guess consumes it);
 * - session tokens are HMAC-signed, expire, and die the moment a number
 *   leaves the allowlist; the cookie is HttpOnly + Secure + SameSite=Strict;
 * - metrics & customer routes 401 before touching the DB;
 * - the customer payload can NEVER carry voucher PINs (bearer secrets);
 * - no betting words, no cash-out promises in any of the new surfaces.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  adminAuthConfigured, isAdminMsisdn, requestAdminOtp, verifyAdminOtp,
  mintAdminToken, verifyAdminToken, adminCookie, clearAdminCookie, requireAdmin,
} from '../lib/admin-auth.js';
import { adminHostDecision } from '../lib/admin-host.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const authLib = read('../lib/admin-auth.js');
const authRoute = read('../pages/api/admin/auth.js');
const metricsRoute = read('../pages/api/admin/metrics.js');
const customerRoute = read('../pages/api/admin/customer.js');
const adminPage = read('../pages/admin/index.js');

const ADMIN = '0731234567';
function armEnv() {
  process.env.WAPAY_ADMIN_MSISDNS = '27731234567';
  process.env.WAPAY_ADMIN_SESSION_SECRET = 'test-secret-0123456789abcdef';
}
function disarmEnv() {
  delete process.env.WAPAY_ADMIN_MSISDNS;
  delete process.env.WAPAY_ADMIN_SESSION_SECRET;
}

function stubPrisma() {
  const otps = [];
  return {
    _otps: otps,
    account: {
      async findMany() {
        return [{ id: 'acc-admin', msisdn: ADMIN, waId: '27731234567' }];
      },
    },
    otpCode: {
      _match(o, where) {
        const now = new Date();
        if (where.accountId && o.accountId !== where.accountId) return false;
        if (where.code?.startsWith && !String(o.code).startsWith(where.code.startsWith)) return false;
        if (where.consumedAt === null && o.consumedAt) return false;
        if (where.consumedAt?.gt && !(o.consumedAt && o.consumedAt > where.consumedAt.gt)) return false;
        if (where.expiresAt?.gt && !(o.expiresAt > where.expiresAt.gt)) return false;
        if (where.createdAt?.gt && !(o.createdAt > where.createdAt.gt)) return false;
        void now;
        return true;
      },
      async findFirst({ where }) {
        const rows = otps.filter((o) => this._match(o, where)).sort((a, b) => b.createdAt - a.createdAt);
        return rows[0] ? { ...rows[0] } : null;
      },
      async count({ where }) {
        return otps.filter((o) => this._match(o, where)).length;
      },
      async create({ data }) {
        const row = { id: 'otp' + otps.length, consumedAt: null, createdAt: new Date(), ...data };
        otps.push(row);
        return { ...row };
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const o of otps) {
          if (o.id !== where.id) continue;
          if (where.consumedAt === null && o.consumedAt) continue;
          Object.assign(o, data);
          count += 1;
        }
        return { count };
      },
      async deleteMany({ where }) {
        const before = otps.length;
        for (let i = otps.length - 1; i >= 0; i -= 1) if (otps[i].id === where.id) otps.splice(i, 1);
        return { count: before - otps.length };
      },
    },
  };
}

test('fail closed: nothing works without the envs', async () => {
  disarmEnv();
  assert.equal(adminAuthConfigured(), false);
  assert.equal(isAdminMsisdn(ADMIN), false);
  let sent = 0;
  const out = await requestAdminOtp({ prisma: stubPrisma(), msisdn: ADMIN, send: async () => { sent += 1; return { ok: true }; } });
  assert.deepEqual(out, { ok: true }, 'generic ok — never an oracle');
  assert.equal(sent, 0, 'no OTP leaves the building unconfigured');
  assert.equal((await verifyAdminOtp({ prisma: stubPrisma(), msisdn: ADMIN, code: '123456' })).ok, false);
  assert.equal(requireAdmin({ headers: {} }).ok, false);
});

test('allowlist matches every SA form of the number, rejects others', () => {
  armEnv();
  for (const form of ['0731234567', '27731234567', '+27 73 123 4567', '073 123 4567']) {
    assert.equal(isAdminMsisdn(form), true, form);
  }
  assert.equal(isAdminMsisdn('0839999999'), false);
  assert.equal(isAdminMsisdn(''), false);
});

test('OTP: hashed at rest, sent to the admin WhatsApp, resend throttled', async () => {
  armEnv();
  const prisma = stubPrisma();
  const sends = [];
  await requestAdminOtp({ prisma, msisdn: ADMIN, send: async (a) => { sends.push(a); return { ok: true }; } });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, '27731234567');
  const code = sends[0].text.match(/\b(\d{6})\b/)[1];
  assert.equal(prisma._otps.length, 1);
  assert.ok(!prisma._otps[0].code.includes(code), 'DB stores a hash, never the code');
  assert.match(prisma._otps[0].code, /^adm:[0-9a-f]{64}$/);
  // resend inside 60s: silently throttled
  await requestAdminOtp({ prisma, msisdn: ADMIN, send: async (a) => { sends.push(a); return { ok: true }; } });
  assert.equal(sends.length, 1, 'no second send within the minute');
});

test('OTP verify: one attempt per code — a wrong guess burns it', async () => {
  armEnv();
  const prisma = stubPrisma();
  const sends = [];
  await requestAdminOtp({ prisma, msisdn: ADMIN, send: async (a) => { sends.push(a); return { ok: true }; } });
  const code = sends[0].text.match(/\b(\d{6})\b/)[1];
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await verifyAdminOtp({ prisma, msisdn: ADMIN, code: wrong })).ok, false);
  // The REAL code now fails too — the wrong guess consumed it.
  assert.equal((await verifyAdminOtp({ prisma, msisdn: ADMIN, code })).ok, false, 'burned');
});

test('OTP verify: right code mints a working session token', async () => {
  armEnv();
  const prisma = stubPrisma();
  const sends = [];
  await requestAdminOtp({ prisma, msisdn: ADMIN, send: async (a) => { sends.push(a); return { ok: true }; } });
  const code = sends[0].text.match(/\b(\d{6})\b/)[1];
  const out = await verifyAdminOtp({ prisma, msisdn: ADMIN, code });
  assert.equal(out.ok, true);
  const session = verifyAdminToken(out.token);
  assert.equal(session.ok, true);
  assert.equal(session.msisdn, '27731234567');
});

test('session token: tamper, expiry, and allowlist removal all revoke', () => {
  armEnv();
  const token = mintAdminToken('27731234567');
  assert.equal(verifyAdminToken(token).ok, true);
  const [b64, exp, mac] = token.split('.');
  assert.equal(verifyAdminToken(`${b64}.${exp}.${'0'.repeat(mac.length)}`).ok, false, 'tampered mac');
  assert.equal(verifyAdminToken(`${b64}.${Date.now() - 1000}.${mac}`).ok, false, 'expired (and mac no longer matches)');
  const expired = mintAdminToken('731234567', -1000);
  assert.equal(verifyAdminToken(expired).ok, false, 'minted-expired');
  process.env.WAPAY_ADMIN_MSISDNS = '27839999999'; // admin removed
  assert.equal(verifyAdminToken(token).ok, false, 'allowlist removal revokes live sessions');
  armEnv();
});

test('cookie: HttpOnly + Secure + SameSite=Strict, and clears properly', () => {
  armEnv();
  const c = adminCookie(mintAdminToken('27731234567'));
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(c.includes(flag), flag);
  assert.ok(clearAdminCookie().includes('Max-Age=0'));
});

test('requireAdmin: cookie or internal key, nothing else', () => {
  armEnv();
  process.env.WAPAY_INTERNAL_API_KEY = 'internal-test-key';
  const token = mintAdminToken('27731234567');
  assert.equal(requireAdmin({ headers: { cookie: `wapay_admin=${token}` } }).ok, true);
  assert.equal(requireAdmin({ headers: { 'x-internal-api-key': 'internal-test-key' } }).ok, true);
  assert.equal(requireAdmin({ headers: { 'x-internal-api-key': 'wrong' } }).ok, false);
  assert.equal(requireAdmin({ headers: { cookie: 'wapay_admin=garbage' } }).ok, false);
  assert.equal(requireAdmin({ headers: {} }).ok, false);
  delete process.env.WAPAY_INTERNAL_API_KEY;
});

// ---------------------------------------------------------------------------
// Statics — the wiring that must never drift
// ---------------------------------------------------------------------------

test('static: metrics & customer routes gate BEFORE any query', () => {
  for (const src of [metricsRoute, customerRoute]) {
    const body = src.slice(src.indexOf('export default'));
    const gate = body.indexOf('requireAdmin(req)');
    const firstQuery = body.search(/prisma\.[a-z$]/);
    assert.ok(gate > -1, 'route calls requireAdmin');
    assert.ok(firstQuery === -1 || gate < firstQuery, 'gate sits before the first DB touch');
    assert.match(src, /401/);
  }
});

test('static: the customer payload can never carry a voucher PIN', () => {
  assert.ok(!customerRoute.includes('voucherPin: true'), 'voucherPin must never be selected');
  assert.match(customerRoute, /voucherPin DELIBERATELY not selected/, 'the invariant is documented in place');
  assert.ok(!adminPage.includes('voucherPin'), 'the page never even references PINs');
});

test('static: OTP codes and tokens are never logged', () => {
  assert.ok(!/console\.(log|error)\([^)]*\bcode\b/.test(authLib), 'no code in logs');
  assert.ok(!/console\.(log|error)\([^)]*token/.test(authLib), 'no token in logs');
});

test('static: auth route sets the cookie only on verified success', () => {
  const verifyIdx = authRoute.indexOf("action === 'verify'");
  const block = authRoute.slice(verifyIdx, authRoute.indexOf('return res.status(200)', verifyIdx));
  assert.match(block, /if \(!out\.ok\) return res\.status\(401\)/);
});

test('policy: no betting words, no cash-out copy in the console', () => {
  for (const src of [adminPage, authRoute, metricsRoute, customerRoute, authLib]) {
    assert.ok(!/\bbet(s|ting|tor)?\b|gambl|casino|wager|bookmak/i.test(src));
  }
  // "CASHOUT_" appears only as a ledger source-code constant in metrics
  // bucketing — never as customer-facing copy on the page.
  assert.ok(!/cash\s?-?\s?out|withdraw/i.test(adminPage), 'no cash-out language in the UI');
});

// ---------------------------------------------------------------------------
// Review 2026-08-28 — regression guards for the confirmed findings
// ---------------------------------------------------------------------------

test('CRITICAL: a foreign number colliding in the last 9 digits is NOT an admin', () => {
  armEnv(); // allowlist = 27731234567
  assert.equal(isAdminMsisdn('447731234567'), false, 'UK number sharing 9 trailing digits rejected');
  assert.equal(isAdminMsisdn('1731234567'), false);
  assert.equal(isAdminMsisdn('27731234567'), true, 'the real admin still matches');
});

test('admin OTP never consumes a customer money-flow OTP (shared table)', async () => {
  armEnv();
  const prisma = stubPrisma();
  // A live customer onboarding OTP (6-digit plaintext, no adm: prefix).
  prisma._otps.push({ id: 'cust1', accountId: 'acc-admin', code: '654321', consumedAt: null,
    createdAt: new Date(), expiresAt: new Date(Date.now() + 6e5) });
  const r = await verifyAdminOtp({ prisma, msisdn: ADMIN, code: '654321' });
  assert.equal(r.ok, false, 'the customer code is not a valid admin code');
  const cust = prisma._otps.find((o) => o.id === 'cust1');
  assert.equal(cust.consumedAt, null, 'and it was NOT burned by the admin verify');
});

test('admin OTP lockout after repeated burns', async () => {
  armEnv();
  const prisma = stubPrisma();
  const sends = [];
  const send = async (a) => { sends.push(a); return { ok: true }; };
  // Burn the lockout threshold of admin codes.
  for (let i = 0; i < 5; i += 1) {
    // bypass the 60s resend throttle by ageing the previous row
    for (const o of prisma._otps) o.createdAt = new Date(Date.now() - 2 * 60 * 1000);
    await requestAdminOtp({ prisma, msisdn: ADMIN, send });
    await verifyAdminOtp({ prisma, msisdn: ADMIN, code: '000000' });
  }
  for (const o of prisma._otps) o.createdAt = new Date(Date.now() - 2 * 60 * 1000);
  await requestAdminOtp({ prisma, msisdn: ADMIN, send });
  const realCode = sends[sends.length - 1].text.match(/\b(\d{6})\b/)[1];
  const r = await verifyAdminOtp({ prisma, msisdn: ADMIN, code: realCode });
  assert.equal(r.ok, false, 'locked out even with a correct code after too many burns');
});

test('internal-key compare is constant-time (hashed), rejects wrong/array keys', () => {
  armEnv();
  process.env.WAPAY_INTERNAL_API_KEY = 'k'.repeat(40);
  assert.equal(requireAdmin({ headers: { 'x-internal-api-key': 'k'.repeat(40) } }).ok, true);
  assert.equal(requireAdmin({ headers: { 'x-internal-api-key': 'x'.repeat(40) } }).ok, false);
  assert.equal(requireAdmin({ headers: { 'x-internal-api-key': ['k'.repeat(40)] } }).ok, false, 'array header rejected, no throw');
  delete process.env.WAPAY_INTERNAL_API_KEY;
});

// ---------------------------------------------------------------------------
// Host routing — the console lives on the wapay.co.za admin domain only
// (founder 2026-08-28), never on the customer-facing pay-link domain.
// ---------------------------------------------------------------------------

test('admin host: unset WAPAY_ADMIN_HOST never locks anyone out', () => {
  for (const host of ['pleasepayme.co.za', 'admin.wapay.co.za', 'localhost:3000']) {
    assert.equal(adminHostDecision({ host, pathname: '/admin', adminHost: '' }), 'pass');
    assert.equal(adminHostDecision({ host, pathname: '/admin', adminHost: undefined }), 'pass');
  }
});

test('admin host: /admin serves ONLY on the configured admin host', () => {
  const adminHost = 'admin.wapay.co.za';
  assert.equal(adminHostDecision({ host: 'admin.wapay.co.za', pathname: '/admin', adminHost }), 'pass');
  assert.equal(adminHostDecision({ host: 'ADMIN.WAPAY.CO.ZA', pathname: '/admin', adminHost }), 'pass', 'host is case-insensitive');
  assert.equal(adminHostDecision({ host: 'admin.wapay.co.za:443', pathname: '/admin/anything', adminHost }), 'pass', 'port ignored');
  // Customer-facing domains must 404 the console, not redirect (no advertising).
  assert.equal(adminHostDecision({ host: 'pleasepayme.co.za', pathname: '/admin', adminHost }), 'block');
  assert.equal(adminHostDecision({ host: 'wa-pay.me', pathname: '/admin/customers', adminHost }), 'block');
  // A lookalike host must not pass.
  assert.equal(adminHostDecision({ host: 'admin.wapay.co.za.evil.com', pathname: '/admin', adminHost }), 'block');
});

test('admin host: the admin domain root opens the console; pay pages are untouched', () => {
  const adminHost = 'admin.wapay.co.za';
  assert.equal(adminHostDecision({ host: 'admin.wapay.co.za', pathname: '/', adminHost }), 'rewrite');
  // Customer pay pages on the pay domain are never intercepted.
  assert.equal(adminHostDecision({ host: 'pleasepayme.co.za', pathname: '/', adminHost }), 'pass');
  assert.equal(adminHostDecision({ host: 'pleasepayme.co.za', pathname: '/PRKWXQZM', adminHost }), 'pass');
});

test('static: middleware never intercepts APIs (webhooks must stay reachable)', () => {
  const mw = read('../middleware.js');
  assert.match(mw, /matcher: \['\/', '\/admin', '\/admin\/:path\*'\]/, 'matcher is page-only');
  assert.ok(!/'\/api/.test(mw.match(/matcher: \[[^\]]*\]/)[0]), 'no /api in the matcher');
  assert.match(mw, /status: 404/, 'wrong host gets 404, not a redirect');
});

// ---------------------------------------------------------------------------
// Delivery (fixed 2026-08-28): an admin logs in from a computer, so WhatsApp's
// 24-hour service window is normally CLOSED. The code must go out on an
// APPROVED AUTHENTICATION TEMPLATE, with free-form text only as a fallback.
// ---------------------------------------------------------------------------

test('OTP delivery: authentication TEMPLATE first (crosses the 24h window)', async () => {
  armEnv();
  const prisma = stubPrisma();
  const templates = [], texts = [];
  await requestAdminOtp({
    prisma, msisdn: ADMIN,
    sendTemplate: async (a) => { templates.push(a); return { ok: true }; },
    send: async (a) => { texts.push(a); return { ok: true }; },
  });
  assert.equal(templates.length, 1, 'template attempted');
  assert.equal(texts.length, 0, 'free-form NOT used when the template succeeds');
  assert.equal(templates[0].to, '27731234567');
  assert.match(templates[0].templateName, /otp/i, 'an authentication OTP template');
  const param = templates[0].components[0].parameters[0].text;
  assert.match(param, /^\d{6}$/, 'the code rides in the body parameter');
  assert.equal(prisma._otps.length, 1, 'code row persists on successful delivery');
});

test('OTP delivery: falls back to free-form when the template fails', async () => {
  armEnv();
  const prisma = stubPrisma();
  const texts = [];
  await requestAdminOtp({
    prisma, msisdn: ADMIN,
    sendTemplate: async () => ({ ok: false, error: 'template_not_found' }),
    send: async (a) => { texts.push(a); return { ok: true }; },
  });
  assert.equal(texts.length, 1, 'fallback used');
  assert.equal(prisma._otps.length, 1, 'row kept — it was delivered');
});

test('OTP delivery: undeliverable code is DELETED so retry is not throttled', async () => {
  armEnv();
  const prisma = stubPrisma();
  await requestAdminOtp({
    prisma, msisdn: ADMIN,
    sendTemplate: async () => ({ ok: false }),
    send: async () => ({ ok: false, error: 'outside 24h window' }),
  });
  assert.equal(prisma._otps.length, 0, 'no orphan code blocking the next attempt');
  // And the immediate retry is allowed (not throttled behind a phantom row).
  const texts = [];
  await requestAdminOtp({
    prisma, msisdn: ADMIN,
    sendTemplate: async (a) => { texts.push(a); return { ok: true }; },
    send: async () => ({ ok: true }),
  });
  assert.equal(texts.length, 1, 'retry goes out immediately');
});

test('static: the auth route wires the template sender', () => {
  assert.match(authRoute, /sendWhatsAppTemplate/, 'template sender imported and passed');
  assert.match(authRoute, /sendTemplate: sendWhatsAppTemplate/);
});

test('delivery diagnosis: returned to internal callers, never leaked publicly, never carries the code', async () => {
  armEnv();
  const prisma = stubPrisma();
  const out = await requestAdminOtp({
    prisma, msisdn: ADMIN,
    sendTemplate: async () => ({ ok: false, error: 'template paused' }),
    send: async () => ({ ok: false, error: 'outside window' }),
  });
  assert.equal(out.ok, true, 'still a generic ok — never an oracle');
  assert.equal(out.diag.templateOk, false);
  assert.match(out.diag.templateError, /paused/);
  assert.equal(out.diag.textOk, false);
  assert.match(out.diag.to, /^\d\d•+\d{4}$/, 'destination masked, never printed in full');
  const blob = JSON.stringify(out.diag);
  assert.ok(!/\b\d{6}\b/.test(blob), 'the OTP code never appears in the diagnosis');
  // The public route strips it.
  assert.match(authRoute, /isInternal \? out : \{ ok: true \}/, 'diag is internal-key gated');
});
