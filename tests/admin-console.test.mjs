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
  requestAdminOtpInSession,
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
  // 2026-09-04: the business portal (/business) joined the matcher; still pages only.
  assert.match(mw, /matcher: \['\/', '\/admin', '\/admin\/:path\*', '\/business', '\/business\/:path\*'\]/, 'matcher is page-only');
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
  assert.equal(templates.length, 1, 'stops at the first template that works');
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
  assert.equal(texts.length, 1, 'fallback used only after EVERY template candidate failed');
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
  assert.ok(out.diag.tried.length >= 2, 'every candidate template is reported');
  assert.match(out.diag.tried[0].error, /paused/);
  assert.equal(out.diag.textOk, false);
  assert.match(out.diag.to, /^\d\d•+\d{4}$/, 'destination masked, never printed in full');
  const blob = JSON.stringify(out.diag);
  assert.ok(!/\b\d{6}\b/.test(blob), 'the OTP code never appears in the diagnosis');
  // The public route strips it.
  assert.match(authRoute, /if \(!isInternal\) return res\.status\(200\)\.json\(\{ ok: true \}\)/, 'diag is internal-key gated');
});

test('template candidates: a WABA-mismatched name is skipped for one that works', async () => {
  armEnv();
  const prisma = stubPrisma();
  const tried = [];
  await requestAdminOtp({
    prisma, msisdn: ADMIN,
    // Mirrors production: the first candidate is approved on a DIFFERENT WABA.
    sendTemplate: async (a) => {
      tried.push(a.templateName);
      return a.templateName === 'otp_register'
        ? { ok: true, data: { messages: [{ id: 'wamid.OK' }] } }
        : { ok: false, error: '(#132001) Template name does not exist in the translation' };
    },
    send: async () => { throw new Error('free-form must NOT be reached'); },
  });
  assert.ok(tried.includes('otp_register'), 'falls through to the template on our WABA');
  assert.equal(prisma._otps.length, 1, 'code delivered and kept');
});

// ---------------------------------------------------------------------------
// In-session admin code (BUGLOG #33): the admin asks FROM their phone, so the
// reply rides an open window and never depends on a per-WABA template.
// ---------------------------------------------------------------------------

test('in-session code: issued to an allowlisted admin, refused for everyone else', async () => {
  armEnv();
  const prisma = stubPrisma();
  const ok = await requestAdminOtpInSession({ prisma, msisdn: ADMIN });
  assert.equal(ok.ok, true);
  assert.match(ok.code, /^\d{6}$/, 'plaintext code returned for immediate in-session delivery');
  assert.equal(prisma._otps.length, 1);
  assert.match(prisma._otps[0].code, /^adm:[0-9a-f]{64}$/, 'stored hashed, never plaintext');
  // A non-admin gets nothing at all.
  const no = await requestAdminOtpInSession({ prisma: stubPrisma(), msisdn: '0839999999' });
  assert.equal(no.ok, false);
  assert.equal(no.code, undefined);
});

test('in-session code: same throttle as the push path', async () => {
  armEnv();
  const prisma = stubPrisma();
  assert.equal((await requestAdminOtpInSession({ prisma, msisdn: ADMIN })).ok, true);
  assert.equal((await requestAdminOtpInSession({ prisma, msisdn: ADMIN })).ok, false, 'throttled inside 60s');
});

test('admin-login matcher: narrow enough that customer sentences never match', () => {
  const src = readFileSync(fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)), 'utf8');
  const start = src.indexOf('function matchAdminLoginAsk(');
  assert.ok(start > -1, 'the matcher exists');
  const body = src.slice(start, src.indexOf('\n}', start) + 2);
  // eslint-disable-next-line no-new-func
  const match = new Function(`${body}; return matchAdminLoginAsk;`)();
  for (const yes of ['admin login', 'Admin Login', 'admin code', 'login code', 'console login']) {
    assert.equal(match(yes), true, yes);
  }
  for (const no of [
    'please pay me R50', 'buy airtime', 'what is my balance', 'my admin friend logged in',
    'send R20 to 0781234567', 'I need a code for my voucher', 'help', '',
  ]) {
    assert.equal(match(no), false, no);
  }
});

test('static: the in-session code path is allowlist-gated and stays silent otherwise', () => {
  const src = readFileSync(fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)), 'utf8');
  const i = src.indexOf('matchAdminLoginAsk(text)');
  const block = src.slice(i, i + 1200);
  assert.match(block, /requestAdminOtpInSession/);
  assert.match(block, /issued\.ok/, 'only replies when a code was actually issued');
  assert.ok(!/not an admin/i.test(block.split('issued.ok')[0]), 'no pre-emptive rejection message');
});

// ---------------------------------------------------------------------------
// Dashboard completeness (founder 2026-08-29: several sections were missing).
// The bug was computing a block and forgetting to put it in the response, so
// these assert the whole path: computed -> returned -> rendered.
// ---------------------------------------------------------------------------

test('metrics: every computed block is actually RETURNED in the payload', () => {
  const body = metricsRoute.slice(metricsRoute.indexOf('return res.status(200).json('));
  for (const key of ['vitals', 'funnel', 'signupsBySource', 'cohorts', 'selling', 'ops', 'flows', 'revenue']) {
    assert.match(body, new RegExp(`\\b${key}[,:]`), `${key} must be in the response payload`);
  }
  // Guard the exact class of bug: a block computed but never returned.
  for (const key of ['selling', 'ops']) {
    assert.match(metricsRoute, new RegExp(`const ${key} = await safe`), `${key} is computed`);
  }
});

test('dashboard renders every section the founder asked for', () => {
  for (const heading of [
    'The funnel',
    'New accounts per week, by source',
    'Revenue by line',
    'Retention',
    "What's being sold",
    'Take rate',
    'Money movement per week',
    'Money-engine health',
  ]) {
    assert.ok(adminPage.includes(heading), `dashboard section missing: ${heading}`);
  }
  for (const comp of ['<WeeklyFlows', '<TakeRate', '<OpsHealth', '<Cohorts', '<Funnel', '<StackBars']) {
    assert.ok(adminPage.includes(comp), `component not rendered: ${comp}`);
  }
});

test('customer list: gated, searchable, and never exposes bearer secrets', () => {
  const listRoute = read('../pages/api/admin/customers.js');
  const body = listRoute.slice(listRoute.indexOf('export default'));
  const gate = body.indexOf('requireAdmin(req)');
  const firstQuery = body.search(/prisma\.[a-z$]/);
  assert.ok(gate > -1 && (firstQuery === -1 || gate < firstQuery), 'auth gate precedes any DB access');
  assert.match(listRoute, /401/);
  assert.ok(!listRoute.includes('voucherPin'), 'never selects voucher PINs');
  assert.match(listRoute, /Math\.min\(MAX_LIMIT/, 'page size is capped');
  // Search must go through Prisma parameters, never string-built SQL.
  assert.ok(!/\$queryRawUnsafe/.test(listRoute), 'no unsafe raw SQL');
  // The page wires the list and makes rows open a profile.
  assert.match(adminPage, /\/api\/admin\/customers\?limit=/, 'page calls the list endpoint');
  assert.match(adminPage, /openCustomer\(cu\.msisdn\)/, 'rows open the full profile');
});

// ---------------------------------------------------------------------------
// Password sign-in (founder ask 2026-08-30: the WhatsApp code round-trip is
// fragile and the number-every-time friction is real)
// ---------------------------------------------------------------------------

test('password login: argon2id hash from env, never a stored/plaintext password', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/admin-auth.js', import.meta.url)), 'utf8');
  assert.match(src, /WAPAY_ADMIN_PASSWORD_HASH/);
  // Self-contained hash: NOT peppered, or a hash generated anywhere but
  // production could never verify (caught in prod verification 2026-08-30).
  assert.match(src, /argon2\.verify\(process\.env\.WAPAY_ADMIN_PASSWORD_HASH\.trim\(\), password\)/);
  const fn = src.slice(src.indexOf('export async function verifyAdminPassword'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  const code = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''); // comments may explain the pepper; code must not use it
  assert.ok(!/PIN_PEPPER/.test(code), 'the admin password hash must not be peppered');
  // No logging call anywhere may carry the hash env or the password value.
  // (Superseded the earlier word-match version, which flagged an operator
  // HINT string that merely contains the word "password".)
  const logCalls = [...src.matchAll(/console\.(?:log|error|warn)\(([^;]*?)\);/gs)].map((m) => m[1]);
  for (const call of logCalls) {
    // Strip string literals: prose may SAY "password" (an operator hint),
    // what must never appear is the password VARIABLE being logged.
    const code = call
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\$]|\\.|\$(?!\{))*`/g, '``');
    assert.ok(!/PASSWORD_HASH/.test(code), `hash env inside a log call: ${call.slice(0, 90)}`);
    assert.ok(!/\bpassword\b(?!_|Login|Hash)/.test(code), `password variable inside a log call: ${call.slice(0, 90)}`);
    assert.ok(!/\$\{\s*password\s*\}/.test(call), `password interpolated into a log call: ${call.slice(0, 90)}`);
  }
});

test('password login: allowlist-gated, fails closed, and never an oracle', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/admin-auth.js', import.meta.url)), 'utf8');
  const fn = src.slice(src.indexOf('export async function verifyAdminPassword'), src.indexOf('\n/**', src.indexOf('export async function verifyAdminPassword')));
  assert.match(fn, /if \(!adminAuthConfigured\(\) \|\| !adminPasswordConfigured\(\)\) return \{ ok: false, error: 'NOT_CONFIGURED' \}/);
  assert.match(fn, /if \(!isAdminMsisdn\(msisdn\)\) return \{ ok: false, error: 'BAD_CREDENTIALS' \}/);
  assert.match(fn, /catch \{\s*\n\s*valid = false;/, 'a malformed hash env refuses, never crashes open');
  // Wrong number and wrong password are indistinguishable to the caller.
  const route = readFileSync(fileURLToPath(new URL('../pages/api/admin/auth.js', import.meta.url)), 'utf8');
  assert.match(route, /error: out\.error === 'LOCKED_OUT' \? 'LOCKED_OUT' : 'BAD_CREDENTIALS'/);
});

test('password login: brute force burns into a lockout', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/admin-auth.js', import.meta.url)), 'utf8');
  assert.match(src, /ADMIN_PW_LOCKOUT_FAILS = 5/);
  assert.match(src, /ADMIN_PW_LOCKOUT_WINDOW_MS = 15 \* 60 \* 1000/);
  assert.match(src, /if \(fails >= ADMIN_PW_LOCKOUT_FAILS\)/);
  // The lockout check runs BEFORE the argon2 verify.
  const fn = src.slice(src.indexOf('export async function verifyAdminPassword'));
  assert.ok(fn.indexOf('ADMIN_PW_LOCKOUT_FAILS)') < fn.indexOf('argon2.verify'), 'lockout precedes verification');
});

test('the login page never advertises the WhatsApp admin-login command', () => {
  const page = readFileSync(fileURLToPath(new URL('../pages/admin/index.js', import.meta.url)), 'utf8');
  // A public page must not teach an attacker the in-chat command (founder,
  // 2026-08-30). The command still works from the founder's phone.
  assert.ok(!/admin login/i.test(page), 'the in-chat command must not appear on the public login page');
  assert.ok(!/WaPay number/i.test(page), 'the WhatsApp number hint is gone too');
  assert.match(page, /autoComplete="current-password"/, 'password field is a real credential field');
  assert.match(page, /wapay_admin_msisdn/, 'the number is remembered so only the password is typed');
});

test('password hash shape probe: diagnoses a mangled paste without leaking the hash', async () => {
  const prev = process.env.WAPAY_ADMIN_PASSWORD_HASH;
  const { adminPasswordHashShape } = await import('../lib/admin-auth.js');
  try {
    process.env.WAPAY_ADMIN_PASSWORD_HASH =
      '$argon2id$v=19$m=65536,t=3,p=1$KVFBF2bBFo7jnZnTLVCNZg$xJkEKMMJ/D8FqB/4V8jh4qqfSl6totBzzLyInXDN5gI';
    const good = adminPasswordHashShape();
    assert.equal(good.looksValid, true);
    assert.equal(good.algorithm, 'argon2id');
    // An unquoted shell paste eats the $-segments — the classic footgun.
    process.env.WAPAY_ADMIN_PASSWORD_HASH = 'id=19=65536,t=3,p=1KVFB';
    assert.equal(adminPasswordHashShape().looksValid, false);
    delete process.env.WAPAY_ADMIN_PASSWORD_HASH;
    assert.equal(adminPasswordHashShape(), null);
  } finally {
    if (prev === undefined) delete process.env.WAPAY_ADMIN_PASSWORD_HASH;
    else process.env.WAPAY_ADMIN_PASSWORD_HASH = prev;
  }
  // The probe exposes shape only, to internal-key callers only.
  const route = readFileSync(fileURLToPath(new URL('../pages/api/admin/auth.js', import.meta.url)), 'utf8');
  assert.match(route, /isInternal \? \{ passwordHash: adminPasswordHashShape\(\)/);
  const lib = readFileSync(fileURLToPath(new URL('../lib/admin-auth.js', import.meta.url)), 'utf8');
  const fn = lib.slice(lib.indexOf('export function adminPasswordHashShape'));
  assert.ok(!/return raw|hash: raw|value: raw/.test(fn.slice(0, fn.indexOf('\n}'))), 'the hash value is never returned');
});
