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
      async findFirst({ where }) {
        const now = new Date();
        const rows = otps
          .filter((o) => o.accountId === where.accountId)
          .filter((o) => (where.consumedAt === null ? !o.consumedAt : true))
          .filter((o) => (where.expiresAt?.gt ? o.expiresAt > where.expiresAt.gt : true))
          .filter((o) => (where.createdAt?.gt ? o.createdAt > where.createdAt.gt : true))
          .sort((a, b) => b.createdAt - a.createdAt);
        return rows[0] ? { ...rows[0] } : null;
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
  assert.match(prisma._otps[0].code, /^[0-9a-f]{64}$/);
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
  assert.equal(session.msisdn, '731234567');
});

test('session token: tamper, expiry, and allowlist removal all revoke', () => {
  armEnv();
  const token = mintAdminToken('731234567');
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
  const c = adminCookie(mintAdminToken('731234567'));
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(c.includes(flag), flag);
  assert.ok(clearAdminCookie().includes('Max-Age=0'));
});

test('requireAdmin: cookie or internal key, nothing else', () => {
  armEnv();
  process.env.WAPAY_INTERNAL_API_KEY = 'internal-test-key';
  const token = mintAdminToken('731234567');
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
