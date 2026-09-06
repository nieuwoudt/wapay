/**
 * WaPay for Business — portal auth, domain logic, and the wiring locks.
 *
 * Locks:
 * - auth FAILS CLOSED without a session secret; OTPs are hashed `biz:` and
 *   never collide with admin `adm:` or customer plaintext codes; one verify
 *   attempt per code; a business token can never open the admin console
 *   (and vice versa) even on a shared secret; registration needs a verified
 *   OTP token; cookie flags; requireBusiness = cookie or internal key + id;
 * - names rendered to third parties are sanitised and may not impersonate
 *   WaPay / rails / banks; customer numbers normalise to 0-form;
 * - the POS composer: items total, fee quote = the pay-page fee, message and
 *   wa.me deep link (the OWNER's own WhatsApp is the default send path);
 * - business links carry their own caps and never count against personal
 *   chat links; dashboards derive from PAID rows only; walk-in payers become
 *   customers; WaPay-originated nudges are flag- and relationship-gated;
 * - static: every business route gates before the DB; no bearer secrets, no
 *   betting/cash-out copy; middleware never intercepts /api; pay page shows
 *   the business; the processor hook is narrow and silent for non-owners.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  businessAuthConfigured, requestBusinessOtp, requestBusinessOtpInSession, verifyBusinessOtp, verifyBusinessPassword,
  hashBusinessPassword, mintBusinessToken, verifyBusinessToken, mintRegistrationToken, verifyRegistrationToken,
  businessCookie, clearBusinessCookie, requireBusiness, requireBusinessContext, mayRegister, BUSINESS_COOKIE,
  BUSINESS_OTP_LOCKOUT_BURNS, BUSINESS_PW_LOCKOUT_FAILS, businessSignupAllowlistReport,
} from '../lib/business-auth.js';
import { mintAdminToken, verifyAdminToken } from '../lib/admin-auth.js';
import {
  sanitizeLabel, validateBusinessName, normaliseCustomerMsisdn, waIdFor, maskNumber, parseContactsImport, validateItems,
  quoteLink, composeLinkMessage, waDeepLink, mergeRecentItems, createBusiness, upsertCustomer, importCustomers,
  listCustomersWithStats, getCustomerProfile, createBusinessLink, markLinkSent, cancelBusinessLink, listBusinessLinks,
  businessOverview, linkWalkInPayers, exportLinksCsv, sendLinkViaWaPay, monthKey, lastMonths, dayKey, classifyPaid,
  customerEligibleForNudge, businessPaidLine, MESSAGE_MAX,
} from '../lib/business.js';
import { businessHostDecision } from '../lib/business-host.js';
import {
  createPaymentRequest, getLatestPendingRequest, MAX_OPEN_REQUESTS, MAX_OPEN_BUSINESS_REQUESTS, MAX_BUSINESS_TTL_DAYS,
} from '../lib/payment-requests.js';
import { paymentRequestFeeCents } from '../lib/deposits.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const ROUTES = ['auth', 'overview', 'customers', 'customer', 'links', 'export', 'settings'].map((r) => [r, read(`../pages/api/business/${r}.js`)]);
const page = read('../pages/business/index.js');
const libBiz = read('../lib/business.js');
const libAuth = read('../lib/business-auth.js');
const processor = read('../pages/api/webhooks/message-processor-v2.js');
const payPage = read('../pages/pay/[code].js');
const notify = read('../lib/request-notify.js');
const middleware = read('../middleware.js');
const schema = read('../packages/domain/prisma/schema.prisma');
const migration = read('../packages/domain/prisma/migrations/20260904_business/migration.sql');

const OWNER = '0731234567';
function armEnv() { process.env.WAPAY_BUSINESS_SESSION_SECRET = 'biz-secret-0123456789abcdef'; delete process.env.WAPAY_BUSINESS_MSISDNS; process.env.WAPAY_BUSINESS_SIGNUPS = 'open'; }
function disarmEnv() { delete process.env.WAPAY_BUSINESS_SESSION_SECRET; delete process.env.WAPAY_ADMIN_SESSION_SECRET; delete process.env.WAPAY_BUSINESS_SIGNUPS; }

// ---------------------------------------------------------------------------
// In-memory Prisma stand-in — enough of the query surface the libs touch.
// ---------------------------------------------------------------------------
function matchWhere(row, where = {}) {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') { if (!v.some((w) => matchWhere(row, w))) return false; continue; }
    if (k === 'NOT') { if (matchWhere(row, v)) return false; continue; }
    if (k === 'businessId_msisdn') { if (row.businessId !== v.businessId || row.msisdn !== v.msisdn) return false; continue; }
    const rv = row[k];
    if (v === null) { if (rv !== null && rv !== undefined) return false; continue; }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('startsWith' in v && !String(rv ?? '').startsWith(v.startsWith)) return false;
      if ('contains' in v && !String(rv ?? '').toLowerCase().includes(String(v.contains).toLowerCase())) return false;
      if ('in' in v && !v.in.includes(rv)) return false;
      if ('not' in v && rv === v.not) return false;
      if ('gt' in v && !(rv > v.gt)) return false;
      if ('gte' in v && !(rv >= v.gte)) return false;
      if ('lt' in v && !(rv < v.lt)) return false;
      if ('lte' in v && !(rv <= v.lte)) return false;
      continue;
    }
    if (rv !== v) return false;
  }
  return true;
}
function table(rows, { idKey = 'id', uniques = [] } = {}) {
  let seq = 0;
  const sortRows = (arr, orderBy) => {
    if (!orderBy) return arr;
    const [[k, dir]] = Object.entries(orderBy);
    return [...arr].sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
  };
  return {
    _rows: rows,
    async findMany({ where = {}, orderBy, take, skip = 0, select } = {}) {
      let out = sortRows(rows.filter((r) => matchWhere(r, where)), orderBy).slice(skip);
      if (take) out = out.slice(0, take);
      // Honour `select` like Prisma does: a column that was not selected is
      // absent, so code that forgets to select what it reads fails HERE.
      return out.map((r) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, r[k]])) : { ...r }));
    },
    async findFirst({ where = {}, orderBy } = {}) { const r = sortRows(rows.filter((x) => matchWhere(x, where)), orderBy)[0]; return r ? { ...r } : null; },
    async findUnique({ where }) { const r = rows.find((x) => matchWhere(x, where)); return r ? { ...r } : null; },
    async count({ where = {} } = {}) { return rows.filter((r) => matchWhere(r, where)).length; },
    async create({ data }) {
      for (const u of uniques) if (rows.some((r) => u.every((k) => r[k] === data[k]))) { const e = new Error('unique'); e.code = 'P2002'; throw e; }
      if (rows.some((r) => r[idKey] === data[idKey])) { const e = new Error('unique'); e.code = 'P2002'; throw e; }
      const row = { createdAt: new Date(), updatedAt: new Date(), consumedAt: null, status: undefined, ...data };
      if (!row[idKey]) row[idKey] = `${idKey}-${++seq}`;
      if (row.status === undefined) delete row.status;
      rows.push(row); return { ...row };
    },
    async update({ where, data }) { const r = rows.find((x) => matchWhere(x, where)); if (!r) throw new Error('not found'); Object.assign(r, data); return { ...r }; },
    async updateMany({ where, data }) { let n = 0; for (const r of rows) if (matchWhere(r, where)) { Object.assign(r, data); n += 1; } return { count: n }; },
    async deleteMany({ where }) { const before = rows.length; for (let i = rows.length - 1; i >= 0; i -= 1) if (matchWhere(rows[i], where)) rows.splice(i, 1); return { count: before - rows.length }; },
    async aggregate({ where = {}, _sum, _count, _min, _max } = {}) {
      const hit = rows.filter((r) => matchWhere(r, where));
      const out = {};
      if (_sum) { out._sum = {}; for (const k of Object.keys(_sum)) out._sum[k] = hit.reduce((acc, r) => acc + (r[k] || 0), 0); }
      if (_count) out._count = { _all: hit.length };
      if (_min) { out._min = {}; for (const k of Object.keys(_min)) out._min[k] = hit.map((r) => r[k]).filter(Boolean).sort((x, y) => x - y)[0] || null; }
      if (_max) { out._max = {}; for (const k of Object.keys(_max)) out._max[k] = hit.map((r) => r[k]).filter(Boolean).sort((x, y) => y - x)[0] || null; }
      return out;
    },
    async createMany({ data, skipDuplicates }) {
      let n = 0;
      for (const d of data) {
        try { await this.create({ data: d }); n += 1; } catch (e) { if (!(skipDuplicates && e.code === 'P2002')) throw e; }
      }
      return { count: n };
    },
  };
}
function stubPrisma({ withBusiness = false, suspended = false } = {}) {
  const account = table([
    { id: 'acc-owner', msisdn: OWNER, waId: '27731234567', displayName: 'Lerato', onboardingState: 'S5_COMPLETED', status: 'ACTIVE' },
    { id: 'acc-payer', msisdn: '0821112222', waId: '27821112222', displayName: 'Thabo', onboardingState: 'S5_COMPLETED', status: 'ACTIVE' },
    // Said "hi" once, never finished onboarding: has an Account row + wallet but no PIN.
    { id: 'acc-hi', msisdn: '0839990000', waId: '27839990000', displayName: 'Friend', onboardingState: 'S0_INITIAL', onboardingStatus: 'NEW', status: 'ACTIVE' },
  ]);
  const business = table(withBusiness ? [{ id: 'biz1', accountId: 'acc-owner', name: 'I Love My Laundry', status: suspended ? 'SUSPENDED' : 'ACTIVE', passwordHash: null, settings: { defaultTtlDays: 7, recentItems: [] }, createdAt: new Date() }] : [], { uniques: [['accountId']] });
  const p = {
    account, business,
    otpCode: table([]),
    businessCustomer: table([], { uniques: [['businessId', 'msisdn']] }),
    paymentRequest: table([], { idKey: 'id' }),
    providerRequest: table([]),
  };
  // payment_requests default columns like the DB
  const origCreate = p.paymentRequest.create.bind(p.paymentRequest);
  p.paymentRequest.create = async ({ data }) => origCreate({ data: { status: 'PENDING', payerRef: null, paidAt: null, note: null, businessId: null, customerId: null, items: null, reference: null, channel: null, sentAt: null, ...data } });
  return p;
}
const biz = (prisma) => prisma.business._rows[0];

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

test('fail closed: nothing works without a session secret', async () => {
  disarmEnv();
  assert.equal(businessAuthConfigured(), false);
  let sent = 0;
  const out = await requestBusinessOtp({ prisma: stubPrisma(), msisdn: OWNER, send: async () => { sent += 1; return { ok: true }; } });
  assert.deepEqual(out, { ok: true }, 'generic ok, never an oracle');
  assert.equal(sent, 0);
  assert.equal((await verifyBusinessOtp({ prisma: stubPrisma(), msisdn: OWNER, code: '123456' })).ok, false);
  assert.equal(requireBusiness({ headers: {} }).ok, false);
  assert.equal((await requestBusinessOtpInSession({ prisma: stubPrisma({ withBusiness: true }), msisdn: OWNER })).ok, false);
});

test('OTP: biz-namespaced hash at rest, template first, text fallback, throttled, undeliverable deleted', async () => {
  armEnv();
  const prisma = stubPrisma();
  const templates = [], texts = [];
  await requestBusinessOtp({ prisma, msisdn: OWNER, sendTemplate: async (a) => { templates.push(a); return { ok: true }; }, send: async (a) => { texts.push(a); return { ok: true }; } });
  assert.equal(templates.length, 1); assert.equal(texts.length, 0);
  assert.equal(templates[0].to, '27731234567');
  assert.match(prisma.otpCode._rows[0].code, /^biz:[0-9a-f]{64}$/);
  assert.ok(!prisma.otpCode._rows[0].code.includes(templates[0].components[0].parameters[0].text), 'hash, not the code');
  // throttled inside 60s
  await requestBusinessOtp({ prisma, msisdn: OWNER, sendTemplate: async (a) => { templates.push(a); return { ok: true }; } });
  assert.equal(templates.length, 1);
  // fallback + undeliverable
  const p2 = stubPrisma();
  await requestBusinessOtp({ prisma: p2, msisdn: OWNER, sendTemplate: async () => ({ ok: false }), send: async (a) => { texts.push(a); return { ok: true }; } });
  assert.equal(texts.length, 1, 'free-form fallback after every template failed');
  const p3 = stubPrisma();
  await requestBusinessOtp({ prisma: p3, msisdn: OWNER, sendTemplate: async () => ({ ok: false }), send: async () => ({ ok: false }) });
  assert.equal(p3.otpCode._rows.length, 0, 'undeliverable code deleted so retry is not throttled');
  // unknown number: generic ok, nothing stored
  const p4 = stubPrisma();
  const out = await requestBusinessOtp({ prisma: p4, msisdn: '0839999999', send: async () => ({ ok: true }) });
  assert.deepEqual(out, { ok: true }); assert.equal(p4.otpCode._rows.length, 0);
});

async function issueCode(prisma) {
  const texts = [];
  await requestBusinessOtp({ prisma, msisdn: OWNER, send: async (a) => { texts.push(a); return { ok: true }; } });
  return texts[0].text.match(/\b(\d{6})\b/)[1];
}

test('verify: one attempt per code; no business → registration token; business → session; suspended → refused', async () => {
  armEnv();
  const p1 = stubPrisma();
  const code = await issueCode(p1);
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await verifyBusinessOtp({ prisma: p1, msisdn: OWNER, code: wrong })).ok, false);
  assert.equal((await verifyBusinessOtp({ prisma: p1, msisdn: OWNER, code })).ok, false, 'burned by the wrong guess');

  const p2 = stubPrisma();
  const c2 = await issueCode(p2);
  const reg = await verifyBusinessOtp({ prisma: p2, msisdn: OWNER, code: c2 });
  assert.equal(reg.ok, true); assert.equal(reg.token, undefined);
  assert.equal(verifyRegistrationToken(reg.registrationToken).accountId, 'acc-owner');

  const p3 = stubPrisma({ withBusiness: true });
  const c3 = await issueCode(p3);
  const sess = await verifyBusinessOtp({ prisma: p3, msisdn: OWNER, code: c3 });
  assert.equal(sess.ok, true);
  assert.deepEqual(verifyBusinessToken(sess.token), { ok: true, businessId: 'biz1', accountId: 'acc-owner' });

  const p4 = stubPrisma({ withBusiness: true });
  const c4 = await issueCode(p4);
  biz(p4).status = 'SUSPENDED'; // suspended AFTER the code went out
  assert.equal((await verifyBusinessOtp({ prisma: p4, msisdn: OWNER, code: c4 })).ok, false, 'suspended business cannot sign in');
});

test('shared otp_codes table: business verify never consumes admin or customer codes', async () => {
  armEnv();
  const prisma = stubPrisma({ withBusiness: true });
  prisma.otpCode._rows.push(
    { id: 'cust', accountId: 'acc-owner', code: '654321', consumedAt: null, createdAt: new Date(), expiresAt: new Date(Date.now() + 6e5) },
    { id: 'adm', accountId: 'acc-owner', code: 'adm:' + 'a'.repeat(64), consumedAt: null, createdAt: new Date(), expiresAt: new Date(Date.now() + 6e5) },
  );
  assert.equal((await verifyBusinessOtp({ prisma, msisdn: OWNER, code: '654321' })).ok, false);
  assert.equal(prisma.otpCode._rows.find((o) => o.id === 'cust').consumedAt, null, 'customer code untouched');
  assert.equal(prisma.otpCode._rows.find((o) => o.id === 'adm').consumedAt, null, 'admin code untouched');
});

test('tokens: tamper/expiry revoke; business and admin tokens are not interchangeable on a shared secret', () => {
  disarmEnv();
  process.env.WAPAY_ADMIN_SESSION_SECRET = 'shared-secret-0123456789abcdef';
  process.env.WAPAY_ADMIN_MSISDNS = '27731234567';
  const bt = mintBusinessToken({ businessId: 'biz1', accountId: 'acc-owner' });
  assert.equal(verifyBusinessToken(bt).ok, true, 'falls back to the admin secret');
  const [b64, exp, mac] = bt.split('.');
  assert.equal(verifyBusinessToken(`${b64}.${exp}.${'0'.repeat(mac.length)}`).ok, false);
  assert.equal(verifyBusinessToken(mintBusinessToken({ businessId: 'biz1', accountId: 'acc-owner' }, -1000)).ok, false);
  assert.equal(verifyAdminToken(bt).ok, false, 'a business token never opens the admin console');
  const at = mintAdminToken('27731234567');
  assert.equal(verifyBusinessToken(at).ok, false, 'an admin token never opens a business');
  const rt = mintRegistrationToken('acc-owner');
  assert.equal(verifyBusinessToken(rt).ok, false, 'a registration token is not a session');
  assert.equal(verifyRegistrationToken(bt).ok, false, 'a session is not a registration token');
  assert.equal(verifyRegistrationToken(mintRegistrationToken('acc-owner', -1)).ok, false, 'registration tokens expire');
  delete process.env.WAPAY_ADMIN_MSISDNS;
  armEnv();
});

test('cookie flags and requireBusiness (cookie, or internal key + explicit business id)', async () => {
  armEnv();
  const c = businessCookie(mintBusinessToken({ businessId: 'biz1', accountId: 'acc-owner' }));
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(c.includes(flag), flag);
  assert.ok(c.startsWith(`${BUSINESS_COOKIE}=`)); assert.ok(clearBusinessCookie().includes('Max-Age=0'));
  process.env.WAPAY_INTERNAL_API_KEY = 'internal-test-key';
  const token = mintBusinessToken({ businessId: 'biz1', accountId: 'acc-owner' });
  assert.equal(requireBusiness({ headers: { cookie: `wapay_biz=${token}` } }).businessId, 'biz1');
  assert.equal(requireBusiness({ headers: { 'x-internal-api-key': 'internal-test-key', 'x-wapay-business-id': 'biz1' } }).ok, true);
  assert.equal(requireBusiness({ headers: { 'x-internal-api-key': 'internal-test-key' } }).ok, false, 'internal key alone names no business');
  assert.equal(requireBusiness({ headers: { 'x-internal-api-key': 'wrong', 'x-wapay-business-id': 'biz1' } }).ok, false);
  assert.equal(requireBusiness({ headers: { cookie: 'wapay_biz=garbage' } }).ok, false);
  // context: the row must exist, be ACTIVE and belong to the token's account
  const prisma = stubPrisma({ withBusiness: true });
  assert.equal((await requireBusinessContext({ headers: { cookie: `wapay_biz=${token}` } }, prisma)).ok, true);
  const foreign = mintBusinessToken({ businessId: 'biz1', accountId: 'acc-payer' });
  assert.equal((await requireBusinessContext({ headers: { cookie: `wapay_biz=${foreign}` } }, prisma)).ok, false, 'token account must own the business');
  biz(prisma).status = 'SUSPENDED';
  assert.equal((await requireBusinessContext({ headers: { cookie: `wapay_biz=${token}` } }, prisma)).ok, false, 'suspended fails closed');
  delete process.env.WAPAY_INTERNAL_API_KEY;
});

test('registration is CLOSED by default; allowlist or WAPAY_BUSINESS_SIGNUPS=open admits; in-session code respects it', async () => {
  armEnv();
  delete process.env.WAPAY_BUSINESS_SIGNUPS;
  assert.equal(mayRegister('0839999999'), false, 'nothing set → nobody registers (fail closed)');
  assert.equal(mayRegister(OWNER), false);
  // A verified owner who is not invited gets an honest, tokenless answer
  // (reachable when the invitation is withdrawn between request and verify).
  const closed = stubPrisma();
  process.env.WAPAY_BUSINESS_SIGNUPS = 'open';
  const cc = await issueCode(closed);
  delete process.env.WAPAY_BUSINESS_SIGNUPS;
  const notInvited = await verifyBusinessOtp({ prisma: closed, msisdn: OWNER, code: cc });
  assert.deepEqual(notInvited, { ok: true, allowed: false });
  assert.equal((await requestBusinessOtpInSession({ prisma: stubPrisma(), msisdn: OWNER })).ok, false, 'in-session code refused when not invited');
  process.env.WAPAY_BUSINESS_SIGNUPS = 'open';
  assert.equal(mayRegister('0839999999'), true, 'explicitly opened');
  delete process.env.WAPAY_BUSINESS_SIGNUPS;
  process.env.WAPAY_BUSINESS_MSISDNS = '27731234567';
  assert.equal(mayRegister('0731234567'), true); assert.equal(mayRegister('0839999999'), false);
  const prisma = stubPrisma();
  const ok = await requestBusinessOtpInSession({ prisma, msisdn: OWNER });
  assert.equal(ok.ok, true); assert.match(ok.code, /^\d{6}$/); assert.equal(ok.hasBusiness, false);
  assert.match(prisma.otpCode._rows[0].code, /^biz:/, 'stored hashed');
  prisma.account._rows.push({ id: 'acc-x', msisdn: '0839999999', waId: '27839999999' });
  assert.equal((await requestBusinessOtpInSession({ prisma, msisdn: '0839999999' })).ok, false, 'not allowed to register, no business: silent');
  const p2 = stubPrisma();
  const c = await issueCode(p2);
  p2.account._rows.push({ id: 'acc-y', msisdn: '0839999998', waId: '27839999998' });
  assert.equal((await verifyBusinessOtp({ prisma: p2, msisdn: OWNER, code: c })).ok, true, 'allowlisted owner may register');
  delete process.env.WAPAY_BUSINESS_MSISDNS;
});

test('password: argon2id self-contained hash, wrong number == wrong password, lockout after 5 fails', async () => {
  armEnv();
  const prisma = stubPrisma({ withBusiness: true });
  biz(prisma).passwordHash = await hashBusinessPassword('correct horse battery');
  assert.match(biz(prisma).passwordHash, /^\$argon2id\$/);
  assert.equal((await verifyBusinessPassword({ prisma, msisdn: OWNER, password: 'correct horse battery' })).ok, true);
  const a = await verifyBusinessPassword({ prisma, msisdn: OWNER, password: 'wrong password!!' });
  const b = await verifyBusinessPassword({ prisma, msisdn: '0839999999', password: 'correct horse battery' });
  assert.deepEqual(a, { ok: false, error: 'BAD_CREDENTIALS' }); assert.deepEqual(b, a, 'identical answer shape');
  for (let i = 0; i < 4; i += 1) await verifyBusinessPassword({ prisma, msisdn: OWNER, password: 'wrong password!!' });
  assert.equal((await verifyBusinessPassword({ prisma, msisdn: OWNER, password: 'correct horse battery' })).error, 'LOCKED_OUT');
  await assert.rejects(() => hashBusinessPassword('short'), /10-200/);
});

// ---------------------------------------------------------------------------
// Labels, numbers, import
// ---------------------------------------------------------------------------

test('labels: sanitised for third parties; impersonating names rejected', () => {
  assert.equal(sanitizeLabel('  *I Love*  My_Laundry <b>  '), 'I Love MyLaundry b');
  assert.equal(validateBusinessName('I Love My Laundry').name, 'I Love My Laundry');
  for (const bad of ['WaPay Support', 'PayFast Refunds', 'Eskom Payments', 'SARS eFiling', 'Standard Bank Fees', 'x',
    'Wa Pay Support', 'W a P a y', 'Wa\u200bPay Support', 'WaPa\u0443 Support', 'Wa\u2060Pay', 'Vodacom Refunds', 'SASSA Grants', 'Capitec Bank Refunds', 'Please Pay Me Ltd']) {
    assert.equal(validateBusinessName(bad).ok, false, `must reject ${JSON.stringify(bad)}`);
  }
  for (const good of ["Thabo's Car Wash", 'Kasi Kitchen', 'Lerato Nails & Beauty', 'Soweto Laundry Co']) {
    assert.equal(validateBusinessName(good).ok, true, good);
  }
  assert.equal(normaliseCustomerMsisdn('+27 73 123 4567'), '0731234567');
  assert.equal(normaliseCustomerMsisdn('073 123 4567'), '0731234567');
  assert.equal(normaliseCustomerMsisdn('12345'), null);
  assert.equal(waIdFor('0731234567'), '27731234567');
  assert.equal(maskNumber('0731234567'), '073•••4567');
});

test('import parser: CSV either order, header skipped, bare numbers, undelimited, vCard, dedupe', () => {
  const rows = parseContactsImport([
    'name,phone',
    'Thabo Nkosi, 073 123 4567',
    '"082 555 1234";Lerato M',
    '0711111111',
    'Sipho 076 222 3333',
    'thabo nkosi again, 0731234567',
    'not a number, hello',
  ].join('\n'));
  assert.deepEqual(rows.map((r) => [r.msisdn, r.name]), [
    ['0731234567', 'Thabo Nkosi'], ['0825551234', 'Lerato M'], ['0711111111', null], ['0762223333', 'Sipho'],
  ]);
  const vcf = 'BEGIN:VCARD\nVERSION:3.0\nN:Nkosi;Thabo;;;\nFN:Thabo Nkosi\nTEL;TYPE=CELL:+27 73 123 4567\nEND:VCARD\nBEGIN:VCARD\nFN:Zanele\nTEL:0825550000\nEND:VCARD';
  assert.deepEqual(parseContactsImport(vcf).map((r) => [r.msisdn, r.name]), [['0731234567', 'Thabo Nkosi'], ['0825550000', 'Zanele']]);
});

// ---------------------------------------------------------------------------
// POS composer
// ---------------------------------------------------------------------------

test('items: totals in integer cents, bad rows rejected', () => {
  const v = validateItems([{ name: 'Wash & fold 5kg', qty: 1, unitCents: 12000 }, { name: 'Ironing', qty: 3, unitCents: 1000 }]);
  assert.equal(v.totalCents, 15000); assert.equal(v.items.length, 2);
  assert.deepEqual(validateItems([]), { items: [], totalCents: 0 });
  assert.throws(() => validateItems([{ name: '', qty: 1, unitCents: 100 }]), /name/);
  assert.throws(() => validateItems([{ name: 'x', qty: 0, unitCents: 100 }]), /Quantity/);
  assert.throws(() => validateItems([{ name: 'x', qty: 1, unitCents: 10.5 }]), /whole cents/);
  assert.throws(() => validateItems(Array.from({ length: 26 }, () => ({ name: 'x', qty: 1, unitCents: 100 }))), /At most/);
});

test('quote: the same banded receiver-pays fee the pay page uses; free under R50; payer always pays face', () => {
  const q = quoteLink(15000);
  assert.equal(q.feeCents, paymentRequestFeeCents(15000)); assert.equal(q.netCardCents, 15000 - q.feeCents); assert.equal(q.netBalanceCents, 15000);
  assert.equal(quoteLink(2000).feeCents, 0);
});

test('message + wa.me deep link: plain text, sanitised names, items, ref, url; no em dash; owner-side WhatsApp', () => {
  const msg = composeLinkMessage({ businessName: '*I Love My Laundry*', customerName: 'Thabo_Nkosi', amountCents: 15000, items: [{ name: 'Wash & fold 5kg', qty: 1, unitCents: 12000 }, { name: 'Ironing', qty: 3, unitCents: 1000 }], reference: 'T-1042', note: 'Ready from 4pm', url: 'https://pleasepayme.co.za/PRKWXQZM' });
  assert.match(msg, /^Hi ThaboNkosi 👋 I Love My Laundry here\./);
  assert.match(msg, /Please pay R150 for ref T-1042\./);
  assert.match(msg, /• Wash & fold 5kg R120/); assert.match(msg, /• Ironing x3 R30/);
  assert.match(msg, /Pay here: https:\/\/pleasepayme\.co\.za\/PRKWXQZM/);
  assert.match(msg, /No fees for you: pay from a WaPay balance or by card/, 'never reads as a card surcharge');
  assert.ok(!/[—–*_]/.test(msg), 'no em dashes or formatting glyphs'); assert.ok(msg.length <= MESSAGE_MAX);
  // Worst case: six 60-char items, a 60-char name, a 40-char ref and a 120-char note must never cut the URL.
  const huge = composeLinkMessage({ businessName: 'B'.repeat(60), customerName: 'Customer', amountCents: 300000,
    items: Array.from({ length: 12 }, (_, i) => ({ name: `Item number ${i} with a very long descriptive name that goes on`, qty: 9, unitCents: 2500 })),
    reference: 'R'.repeat(40), note: 'N'.repeat(120), url: 'https://pleasepayme.co.za/PRABCDEF' });
  assert.ok(huge.length <= MESSAGE_MAX, `fits ${huge.length}`);
  assert.match(huge, /\nPay here: https:\/\/pleasepayme\.co\.za\/PRABCDEF\n/, 'the URL survives intact');
  const link = waDeepLink({ msisdn: '0731234567', text: 'Pay R150 & thanks' });
  assert.equal(link, 'https://wa.me/27731234567?text=Pay%20R150%20%26%20thanks');
  assert.throws(() => waDeepLink({ msisdn: '12345', text: 'x' }));
});

test('recent items memory: newest first, deduped by name, capped', () => {
  const merged = mergeRecentItems([{ name: 'Ironing', unitCents: 1000 }, { name: 'Duvet', unitCents: 8000 }], [{ name: 'Wash & fold 5kg', unitCents: 12000 }, { name: 'ironing', unitCents: 1200 }]);
  assert.deepEqual(merged.map((i) => i.name), ['Wash & fold 5kg', 'ironing', 'Duvet']);
  assert.equal(mergeRecentItems([], Array.from({ length: 20 }, (_, i) => ({ name: `i${i}`, unitCents: 100 }))).length, 12);
});

// ---------------------------------------------------------------------------
// Links & caps
// ---------------------------------------------------------------------------

test('createPaymentRequest business branch: stamps business fields, caps TTL at 30d; personal path unchanged', async () => {
  const prisma = stubPrisma();
  const r = await createPaymentRequest({ prisma, accountId: 'acc-owner', amountCents: 15000, business: { businessId: 'biz1', customerId: 'c1', items: [{ name: 'x', qty: 1, unitCents: 15000 }], reference: '  T-1  ', ttlDays: 90 } });
  assert.equal(r.businessId, 'biz1'); assert.equal(r.customerId, 'c1'); assert.equal(r.reference, 'T-1'); assert.equal(r.items.length, 1);
  const days = (r.expiresAt - Date.now()) / 86400000;
  assert.ok(days > MAX_BUSINESS_TTL_DAYS - 1 && days <= MAX_BUSINESS_TTL_DAYS, 'TTL capped at 30 days');
  const p = await createPaymentRequest({ prisma, accountId: 'acc-owner', amountCents: 5000 });
  assert.equal(p.businessId, null); assert.equal(p.items, null);
  assert.ok((p.expiresAt - Date.now()) / 86400000 <= 7.01, 'personal links keep the 7-day TTL');
});

test('caps: business links count per business and never block the owner\'s personal chat links', async () => {
  const prisma = stubPrisma();
  for (let i = 0; i < MAX_OPEN_REQUESTS + 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await createPaymentRequest({ prisma, accountId: 'acc-owner', amountCents: 1000, business: { businessId: 'biz1' } });
  }
  assert.equal(prisma.paymentRequest._rows.length, MAX_OPEN_REQUESTS + 3, 'well past the personal cap');
  const personal = await createPaymentRequest({ prisma, accountId: 'acc-owner', amountCents: 1000 });
  assert.equal(personal.status, 'PENDING', 'personal link still allowed');
  assert.ok(MAX_OPEN_BUSINESS_REQUESTS > MAX_OPEN_REQUESTS);
  const latest = await getLatestPendingRequest({ prisma, accountId: 'acc-owner' });
  assert.equal(latest.id, personal.id, '"change my amount" in chat only ever touches personal links');
});

test('createBusinessLink: derives total from items, rejects mismatch and foreign customers, waLink only with a customer', async () => {
  const prisma = stubPrisma({ withBusiness: true });
  const { customer } = await upsertCustomer({ prisma, businessId: 'biz1', msisdn: '073 123 4567', name: 'Thabo Nkosi' });
  const out = await createBusinessLink({ prisma, business: biz(prisma), customerId: customer.id, items: [{ name: 'Wash & fold', qty: 1, unitCents: 12000 }, { name: 'Ironing', qty: 3, unitCents: 1000 }], reference: 'T-1042' });
  assert.equal(out.link.amountCents, 15000); assert.match(out.link.url, /^https:\/\/pleasepayme\.co\.za\/PR[A-Z]{6}$/);
  assert.match(out.waLink, /^https:\/\/wa\.me\/27731234567\?text=/); assert.equal(out.link.customerName, 'Thabo Nkosi');
  assert.deepEqual(biz(prisma).settings.recentItems.map((i) => i.name), ['Wash & fold', 'Ironing'], 'recent items remembered');
  await assert.rejects(() => createBusinessLink({ prisma, business: biz(prisma), items: [{ name: 'x', qty: 1, unitCents: 1000 }], amountCents: 2000 }), /does not match/);
  await assert.rejects(() => createBusinessLink({ prisma, business: biz(prisma), customerId: 'someone-elses', amountCents: 1000 }), /Unknown customer/);
  const walkIn = await createBusinessLink({ prisma, business: biz(prisma), amountCents: 2500 });
  assert.equal(walkIn.waLink, null); assert.equal(walkIn.quote.feeCents, 0);
  assert.equal(await markLinkSent({ prisma, businessId: 'biz1', code: walkIn.link.code, channel: 'WHATSAPP_BUSINESS' }), true);
  assert.equal(await markLinkSent({ prisma, businessId: 'other', code: walkIn.link.code, channel: 'COPY' }), false, 'scoped to the business');
  assert.equal(await cancelBusinessLink({ prisma, business: { id: 'other', accountId: 'acc-owner' }, code: walkIn.link.code }), false);
  assert.equal(await cancelBusinessLink({ prisma, business: biz(prisma), code: walkIn.link.code }), true);
  const open = await listBusinessLinks({ prisma, businessId: 'biz1', status: 'open' });
  assert.equal(open.total, 1); assert.equal(open.links[0].customerName, 'Thabo Nkosi');
});

// ---------------------------------------------------------------------------
// Derived CRM numbers
// ---------------------------------------------------------------------------

async function seededBusiness() {
  const prisma = stubPrisma({ withBusiness: true });
  const thabo = (await upsertCustomer({ prisma, businessId: 'biz1', msisdn: '0821112222', name: 'Thabo Nkosi' })).customer;
  const lerato = (await upsertCustomer({ prisma, businessId: 'biz1', msisdn: '0825551234', name: 'Lerato M' })).customer;
  const mk = async (customerId, amountCents, status, payerRef, paidAt, items) => {
    const r = await createPaymentRequest({ prisma, accountId: 'acc-owner', amountCents, business: { businessId: 'biz1', customerId, items } });
    const row = prisma.paymentRequest._rows.find((x) => x.id === r.id);
    Object.assign(row, { status, payerRef, paidAt });
    return row;
  };
  const now = new Date();
  const ago = (days) => new Date(now.getTime() - days * 86400000);
  await mk(thabo.id, 15000, 'PAID', 'PAYFAST:pf1', ago(2), [{ name: 'Wash & fold', qty: 1, unitCents: 15000 }]);
  await mk(thabo.id, 5000, 'PAID', 'WAPAY:acc-payer', ago(40));
  await mk(lerato.id, 3000, 'PAID', 'WAPAY:acc-x', ago(1));
  await mk(lerato.id, 8000, 'PENDING', null, null);
  const expired = await mk(lerato.id, 9000, 'PENDING', null, null);
  expired.expiresAt = ago(1);
  return { prisma, thabo, lerato };
}

test('customers list: derived paid/count/avg/outstanding, sortable by spend; expired links never count as outstanding', async () => {
  const { prisma } = await seededBusiness();
  const { customers } = await listCustomersWithStats({ prisma, businessId: 'biz1', sort: 'spend' });
  assert.equal(customers[0].name, 'Thabo Nkosi'); assert.equal(customers[0].paidCents, 20000); assert.equal(customers[0].paidCount, 2); assert.equal(customers[0].avgCents, 10000);
  assert.equal(customers[1].openCents, 8000, 'only the live pending link'); assert.equal(customers[1].openCount, 1);
  const found = await listCustomersWithStats({ prisma, businessId: 'biz1', q: '0825' });
  assert.equal(found.total, 1); assert.equal(found.customers[0].name, 'Lerato M');
});

test('customer profile: lifetime stats, fees on card rows only, 12-month series, top items, links; foreign id is null', async () => {
  const { prisma, thabo } = await seededBusiness();
  const p = await getCustomerProfile({ prisma, businessId: 'biz1', customerId: thabo.id });
  assert.equal(p.stats.paidCents, 20000); assert.equal(p.stats.feeCents, paymentRequestFeeCents(15000)); assert.equal(p.stats.netCents, 20000 - paymentRequestFeeCents(15000));
  assert.equal(p.monthly.length, 12); assert.equal(p.monthly[11].month, monthKey(new Date()));
  assert.equal(p.topItems[0].name, 'Wash & fold'); assert.equal(p.links.length, 2); assert.equal(p.links.find((l) => l.method === 'CARD').feeCents, paymentRequestFeeCents(15000));
  assert.equal(await getCustomerProfile({ prisma, businessId: 'other-biz', customerId: thabo.id }), null);
});

test('overview: period totals, method split, outstanding, 3/6/12-month sums, top customers, recent', async () => {
  const { prisma } = await seededBusiness();
  const o = await businessOverview({ prisma, businessId: 'biz1', rangeDays: 30 });
  assert.equal(o.vitals.paidCents, 18000, 'two payments inside 30 days'); assert.equal(o.vitals.paidCount, 2);
  assert.equal(o.vitals.feeCents, paymentRequestFeeCents(15000)); assert.equal(o.vitals.netCents, 18000 - paymentRequestFeeCents(15000));
  assert.equal(o.vitals.priorPaidCents, 5000, 'the 40-day-old payment sits in the prior window');
  assert.equal(o.vitals.outstandingCents, 8000); assert.equal(o.vitals.outstandingCount, 1);
  assert.equal(o.methods.card.cents, 15000); assert.equal(o.methods.wapay.cents, 3000);
  assert.equal(o.monthly.length, 12); assert.equal(o.totals.last12mCents, 23000); assert.ok(o.totals.last3mCents >= 18000);
  assert.equal(o.topCustomers[0].name, 'Thabo Nkosi'); assert.equal(o.recentPayments.length, 2); assert.equal(o.vitals.customers, 2);
  assert.deepEqual(lastMonths(3, new Date(Date.UTC(2026, 8, 4))), ['2026-07', '2026-08', '2026-09']);
});

test('walk-in payers become customers: card payer via signed intent number, balance payer via account; idempotent', async () => {
  const prisma = stubPrisma({ withBusiness: true });
  const card = await createPaymentRequest({ prisma, accountId: 'acc-owner', amountCents: 2500, business: { businessId: 'biz1' } });
  Object.assign(prisma.paymentRequest._rows.find((r) => r.id === card.id), { status: 'PAID', payerRef: 'PAYFAST:pf9', paidAt: new Date() });
  prisma.providerRequest._rows.push({ idemKey: `wapay-payreq-${card.id}`, metadata: { payerMsisdn: '0765554444' } });
  const bal = await createPaymentRequest({ prisma, accountId: 'acc-owner', amountCents: 1500, business: { businessId: 'biz1' } });
  Object.assign(prisma.paymentRequest._rows.find((r) => r.id === bal.id), { status: 'PAID', payerRef: 'WAPAY:acc-payer', paidAt: new Date() });
  assert.deepEqual(await linkWalkInPayers({ prisma, businessId: 'biz1' }), { linked: 2 });
  const cs = prisma.businessCustomer._rows;
  assert.deepEqual(cs.map((c) => [c.msisdn, c.source, c.accountId]).sort(), [['0765554444', 'PAYLINK', null], ['0821112222', 'PAYLINK', 'acc-payer']]);
  assert.ok(prisma.paymentRequest._rows.every((r) => r.customerId), 'requests now point at their customers');
  assert.deepEqual(await linkWalkInPayers({ prisma, businessId: 'biz1' }), { linked: 0 }, 'idempotent');
});

test('CSV export: header, one row per link, escaping', async () => {
  const { prisma } = await seededBusiness();
  const { csv, truncated } = await exportLinksCsv({ prisma, businessId: 'biz1', sinceDays: 90 });
  assert.equal(truncated, false);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'created,paid,code,status,method,customer,number,reference,items,amount,fee,net,link');
  assert.equal(lines.length, 6, 'five links + header');
  assert.ok(lines.some((l) => l.includes(',PAID,CARD,Thabo Nkosi,0821112222,,Wash & fold x1 @ 150.00,150.00,')));
  assert.ok(lines.some((l) => l.includes(',EXPIRED,')), 'lazily expired links are reported EXPIRED');
});

// ---------------------------------------------------------------------------
// WaPay-originated nudge — flag + relationship gated
// ---------------------------------------------------------------------------

test('nudge: disabled by default; needs a prior PAID relationship; one per link; marks channel WAPAY', async () => {
  const { prisma, thabo, lerato } = await seededBusiness();
  const sends = [];
  const send = { text: async (a) => { sends.push(a); return { ok: true }; }, template: async () => ({ ok: false }), direct: async () => ({ ok: false }), directEnabled: () => false };
  const orderChecks = [];
  const orderedSend = { text: async () => { orderChecks.push('text'); return { ok: true }; }, template: async () => { orderChecks.push('template'); return { ok: true }; }, direct: async () => { orderChecks.push('direct'); return { ok: false }; }, directEnabled: () => true };
  const fresh = (await upsertCustomer({ prisma, businessId: 'biz1', msisdn: '0790000000', name: 'New Person' })).customer;
  const link = await createBusinessLink({ prisma, business: biz(prisma), customerId: fresh.id, amountCents: 5000 });
  delete process.env.WAPAY_BUSINESS_NOTIFY;
  assert.equal((await sendLinkViaWaPay({ prisma, business: biz(prisma), customer: fresh, code: link.link.code, send })).error, 'DISABLED');
  process.env.WAPAY_BUSINESS_NOTIFY = 'true';
  assert.equal((await sendLinkViaWaPay({ prisma, business: biz(prisma), customer: fresh, code: link.link.code, send })).error, 'NOT_ELIGIBLE', 'a number the business merely typed is never pushed to');
  assert.equal(sends.length, 0);
  const forThabo = await createBusinessLink({ prisma, business: biz(prisma), customerId: thabo.id, amountCents: 6000, reference: 'T-2' });
  const out = await sendLinkViaWaPay({ prisma, business: biz(prisma), customer: thabo, code: forThabo.link.code, send });
  assert.equal(out.ok, true); assert.equal(sends.length, 1); assert.equal(sends[0].to, '27821112222');
  assert.match(sends[0].text, /A WaPay business, I Love My Laundry, sent you a payment request for R60 \(ref T-2\)/);
  assert.match(sends[0].text, /If you don't recognise this business, ignore this message/);
  assert.match(sends[0].text, /No fees for you/, 'never reads as a card surcharge');
  // Out-of-window rails go first: Direct Send, then the approved template, free-form text last.
  process.env.WAPAY_TEMPLATE_BUSINESS_REQUEST = 'biz_request_v1';
  const second = await createBusinessLink({ prisma, business: biz(prisma), customerId: thabo.id, amountCents: 7000 });
  assert.equal((await sendLinkViaWaPay({ prisma, business: biz(prisma), customer: thabo, code: second.link.code, send: orderedSend })).ok, true);
  assert.deepEqual(orderChecks, ['direct', 'template'], 'text is never tried while a window-crossing rail succeeds');
  delete process.env.WAPAY_TEMPLATE_BUSINESS_REQUEST;
  assert.ok(!/reply|yes|pin/i.test(sends[0].text), 'informational only: no action is planted on the recipient');
  assert.equal((await sendLinkViaWaPay({ prisma, business: biz(prisma), customer: thabo, code: forThabo.link.code, send })).error, 'ALREADY_SENT');
  // A later "copied" click must not reset the once-per-link guard, and a
  // browser can never forge the WAPAY mark itself.
  assert.equal(await markLinkSent({ prisma, businessId: 'biz1', code: forThabo.link.code, channel: 'COPY' }), false, 'WAPAY mark is never downgraded');
  const plain = await createBusinessLink({ prisma, business: biz(prisma), customerId: thabo.id, amountCents: 900 });
  await markLinkSent({ prisma, businessId: 'biz1', code: plain.link.code, channel: 'WAPAY' });
  assert.equal(prisma.paymentRequest._rows.find((r) => r.id === plain.link.code).channel, 'COPY', 'WAPAY from a caller is recorded as a plain copy');
  assert.equal((await sendLinkViaWaPay({ prisma, business: biz(prisma), customer: thabo, code: forThabo.link.code, send })).error, 'ALREADY_SENT');
  assert.equal(sends.length, 1, 'still exactly one push');
  // Manufactured consent: a typed number at a card checkout is NOT a relationship...
  const victim = (await upsertCustomer({ prisma, businessId: 'biz1', msisdn: '0790001111', name: 'Victim' })).customer;
  const cardWalkIn = await createPaymentRequest({ prisma, accountId: 'acc-owner', amountCents: 500, business: { businessId: 'biz1', customerId: victim.id } });
  Object.assign(prisma.paymentRequest._rows.find((r) => r.id === cardWalkIn.id), { status: 'PAID', payerRef: 'PAYFAST:pfX', paidAt: new Date() });
  assert.equal(await customerEligibleForNudge({ prisma, businessId: 'biz1', customerId: victim.id }), false, 'card payment under a customer row proves nothing');
  // ...and neither is the business paying its OWN ticket from its own wallet under the victim's row.
  const selfPaid = await createPaymentRequest({ prisma, accountId: 'acc-owner', amountCents: 500, business: { businessId: 'biz1', customerId: victim.id } });
  Object.assign(prisma.paymentRequest._rows.find((r) => r.id === selfPaid.id), { status: 'PAID', payerRef: 'WAPAY:acc-owner', paidAt: new Date() });
  assert.equal(await customerEligibleForNudge({ prisma, businessId: 'biz1', customerId: victim.id }), false, 'payer account must be the customer\'s own number');
  assert.equal(await customerEligibleForNudge({ prisma, businessId: 'biz1', customerId: thabo.id }), true, 'Thabo paid from his own wallet: eligible');
  assert.equal((await sendLinkViaWaPay({ prisma, business: biz(prisma), customer: lerato, code: forThabo.link.code, send })).error, 'BAD_CUSTOMER', 'link must belong to that customer');
  delete process.env.WAPAY_BUSINESS_NOTIFY;
});

// ---------------------------------------------------------------------------
// Host routing
// ---------------------------------------------------------------------------

test('business host: unset never locks out; set → /business only there, root rewrites, lookalikes blocked', () => {
  for (const host of ['pleasepayme.co.za', 'business.wapay.co.za', 'localhost:3000']) {
    assert.equal(businessHostDecision({ host, pathname: '/business', businessHost: '' }), 'pass');
  }
  const businessHost = 'business.wapay.co.za';
  assert.equal(businessHostDecision({ host: 'BUSINESS.wapay.co.za:443', pathname: '/business', businessHost }), 'pass');
  assert.equal(businessHostDecision({ host: 'business.wapay.co.za', pathname: '/', businessHost }), 'rewrite');
  assert.equal(businessHostDecision({ host: 'pleasepayme.co.za', pathname: '/business', businessHost }), 'block');
  assert.equal(businessHostDecision({ host: 'business.wapay.co.za.evil.com', pathname: '/business', businessHost }), 'block');
  assert.equal(businessHostDecision({ host: 'pleasepayme.co.za', pathname: '/PRKWXQZM', businessHost }), 'pass');
  assert.equal(businessHostDecision({ host: 'admin.wapay.co.za', pathname: '/admin', businessHost }), 'pass', 'admin pages are not this module\'s business');
});

// ---------------------------------------------------------------------------
// Statics — wiring that must never drift
// ---------------------------------------------------------------------------

test('static: every business route gates with requireBusinessContext BEFORE any DB access and answers 401', () => {
  for (const [name, src] of ROUTES) {
    const body = src.slice(src.indexOf('export default'));
    const gate = body.indexOf('requireBusinessContext(req)');
    const firstQuery = body.search(/prisma\.[a-z$]/);
    assert.ok(gate > -1, `${name}: gate present`);
    assert.ok(firstQuery === -1 || gate < firstQuery, `${name}: gate before the first DB touch`);
    assert.match(src, /401/, `${name}: 401`);
    assert.ok(!/\$queryRawUnsafe/.test(src), `${name}: no unsafe raw SQL`);
  }
});

test('static: no bearer secrets, no betting words, no cash-out copy anywhere in the portal', () => {
  for (const [, src] of [...ROUTES, ['page', page], ['lib', libBiz], ['auth', libAuth]]) {
    assert.ok(!src.includes('voucherPin'), 'never touches voucher PINs');
    assert.ok(!/\bbet(s|ting|tor)?\b|gambl|casino|wager|bookmak/i.test(src));
  }
  assert.ok(!/cash\s?-?\s?out|withdraw/i.test(page), 'no cash-out language in the UI');
  assert.ok(!/console\.(log|error)\([^)]*\b(code|password|token)\b/.test(libAuth), 'no codes/passwords/tokens in logs');
});

test('static: middleware gates both portals, never intercepts /api, 404s on the wrong host', () => {
  assert.match(middleware, /matcher: \['\/', '\/admin', '\/admin\/:path\*', '\/business', '\/business\/:path\*'\]/);
  assert.ok(!/'\/api/.test(middleware.match(/matcher: \[[^\]]*\]/)[0]));
  assert.match(middleware, /businessHostDecision/); assert.match(middleware, /adminHostDecision/); assert.match(middleware, /status: 404/);
});

test('static: pay page names the business and itemises; personal path intact; notification names customer + ref', () => {
  assert.match(payPage, /request\.businessId/); assert.match(payPage, /prisma\.business\.findUnique/); assert.match(payPage, /isBusiness/);
  assert.match(payPage, /maskedRequesterLabel\(account\)/, 'personal links still use the masked owner label');
  assert.match(payPage, /Number\.isInteger\(it\.unitCents\)/, 'items are re-validated before render');
  assert.match(notify, /if \(request\.businessId\)/); assert.match(notify, /businessPaidLine\(/, 'shared who-paid line');
  assert.match(notify, /prisma\.business\.findUnique/, 'payer receipt names the business');
  assert.match(processor, /businessPaidLine\(/, 'balance rail names the customer too');
  assert.match(processor, /businessLabelForRequest\(/, 'in-chat pay flow names the business');
  assert.match(payPage, /business\.status === 'ACTIVE'/, 'suspended business is not payable');
  assert.match(read('../pages/api/pay/checkout.js'), /businessRequestPayable\(\{ request \}\)/, 'checkout refuses a suspended business via the shared helper');
});

test('static: schema + migration carry the new fields, idempotently, without touching money tables', () => {
  for (const col of ['businessId', 'customerId', 'items', 'reference', 'channel', 'sentAt']) {
    assert.match(schema, new RegExp(`\\n\\s+${col}\\s+\\w+\\?`), `PaymentRequest.${col} is nullable`);
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS "${col}"`));
  }
  assert.match(schema, /model Business \{/); assert.match(schema, /model BusinessCustomer \{/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "businesses"/); assert.match(migration, /CREATE TABLE IF NOT EXISTS "business_customers"/);
  assert.match(migration, /^BEGIN;/m); assert.match(migration, /^COMMIT;/m);
  assert.ok(!/JournalEntry|JournalLine|Wallet|holds/.test(migration), 'no money tables touched');
});

test('processor: business-login matcher is narrow, sits after the admin hook, replies only when a code was issued', () => {
  const start = processor.indexOf('function matchBusinessLoginAsk(');
  assert.ok(start > -1);
  const body = processor.slice(start, processor.indexOf('\n}', start) + 2);
  // eslint-disable-next-line no-new-func
  const match = new Function(`${body}; return matchBusinessLoginAsk;`)();
  for (const yes of ['business login', 'Business Code', 'business sign in', 'portal login', 'business portal']) assert.equal(match(yes), true, yes);
  for (const yes2 of ['business login please', 'Business code!', 'wapay business login']) assert.equal(match(yes2), true, yes2);
  for (const no of ['my business needs airtime', 'please pay me R50', 'buy airtime for my business', 'admin login', 'login code', 'help', '', 'is this a business account?',
    'business portal is not loading', 'business code for my customers?']) {
    assert.equal(match(no), false, no);
  }
  assert.match(processor, /issued\.reason === 'THROTTLED' && issued\.hasBusiness/, 'owner asking twice is told about the throttle');
  assert.match(processor, /businessId: \{ not: null \}/, '"change my amount" never mints a personal link over open business tickets');
  const adminHook = processor.indexOf('matchAdminLoginAsk(text)');
  const bizHook = processor.indexOf('matchBusinessLoginAsk(text)');
  assert.ok(adminHook > -1 && bizHook > adminHook, 'business hook follows the admin hook');
  const block = processor.slice(bizHook, bizHook + 1000);
  assert.match(block, /requestBusinessOtpInSession/); assert.match(block, /issued\.ok/);
  assert.ok(!/not a business/i.test(block.split('issued.ok')[0]), 'silent for non-owners');
  assert.ok(bizHook < processor.indexOf('const slots = parseSlots(text'), 'runs before slot parsing like the admin hook');
});

test('page: four tabs, the composer, WhatsApp send path, import, export, and no admin command advertised', () => {
  for (const s of ["'overview', 'Overview'", "'customers', 'Customers'", "'links', 'Payment links'", "'settings', 'Settings'"]) assert.ok(page.includes(s), s);
  for (const c of ['<Composer', '<Created', '<LinksTable', '<CustomerProfile', '<MonthlyBars', '<Split']) assert.ok(page.includes(c), c);
  assert.match(page, /Send on WhatsApp/); assert.match(page, /window\.open\(result\.waLink/); assert.match(page, /\/api\/business\/export\?days=/);
  assert.match(page, /action: 'import'/); assert.match(page, /autoComplete="current-password"/);
  assert.ok(!/admin login/i.test(page), 'the admin chat command is never shown here');
  assert.match(page, /backdrop-filter:blur/, 'mirror-finish surfaces'); assert.match(page, /border-radius:20px/, 'rounded cards');
  assert.match(page, /incomplete\.length > 0/, 'an unfinished item row blocks link creation');
  assert.match(page, /r\.quote\?\.amountCents === totalCents/, 'a stale quote is never shown under a new total');
  assert.match(page, /if \(!w\) \{ setBlocked\(true\); return; \}/, 'a blocked popup is never recorded as sent');
  assert.match(page, /wapay:unauth/, 'an expired session returns to sign-in');
  assert.match(page, /setM\(null\); \/\/ never show the previous range/, 'range switch clears stale numbers');
  assert.ok(!/no fee under R50/.test(page), 'fee threshold copy comes from the server');
  assert.match(page, /prefers-color-scheme:dark/, 'dark palette defined');
});


// ---------------------------------------------------------------------------
// Adversarial review 2026-09-05 — regression guards
// ---------------------------------------------------------------------------

test('review: OTP request refuses wallets that own no business and may not register (no spam cannon)', async () => {
  armEnv();
  delete process.env.WAPAY_BUSINESS_SIGNUPS;
  const prisma = stubPrisma();
  const sends = [];
  const out = await requestBusinessOtp({ prisma, msisdn: OWNER, sendTemplate: async (a) => { sends.push(a); return { ok: true }; }, send: async (a) => { sends.push(a); return { ok: true }; } });
  assert.deepEqual(out, { ok: true }, 'still membership-neutral');
  assert.equal(sends.length, 0); assert.equal(prisma.otpCode._rows.length, 0);
  // A suspended business gets no code either (portal and in-session paths).
  const p2 = stubPrisma({ withBusiness: true, suspended: true });
  await requestBusinessOtp({ prisma: p2, msisdn: OWNER, send: async (a) => { sends.push(a); return { ok: true }; } });
  assert.equal(sends.length, 0); assert.equal(p2.otpCode._rows.length, 0);
  assert.equal((await requestBusinessOtpInSession({ prisma: p2, msisdn: OWNER })).reason, 'SUSPENDED');
  process.env.WAPAY_BUSINESS_SIGNUPS = 'open';
});

test('review: OTP and password lockouts are per SOURCE, so a stranger cannot lock the owner out', async () => {
  armEnv();
  const prisma = stubPrisma({ withBusiness: true });
  for (let i = 0; i < BUSINESS_OTP_LOCKOUT_BURNS; i += 1) {
    for (const o of prisma.otpCode._rows) if (o.code.startsWith('biz:')) o.createdAt = new Date(Date.now() - 2 * 60 * 1000);
    // eslint-disable-next-line no-await-in-loop
    const code = await issueCode(prisma);
    // eslint-disable-next-line no-await-in-loop
    await verifyBusinessOtp({ prisma, msisdn: OWNER, code: code === '000000' ? '111111' : '000000', source: '203.0.113.9' });
  }
  for (const o of prisma.otpCode._rows) if (o.code.startsWith('biz:')) o.createdAt = new Date(Date.now() - 2 * 60 * 1000);
  const fresh = await issueCode(prisma);
  assert.equal((await verifyBusinessOtp({ prisma, msisdn: OWNER, code: fresh, source: '203.0.113.9' })).error, 'LOCKED_OUT', 'the attacker source is locked out BEFORE consuming');
  assert.equal(prisma.otpCode._rows.filter((o) => o.code.startsWith('biz:') && !o.consumedAt).length, 1, 'the fresh code is NOT consumed by a locked-out source');
  assert.equal((await verifyBusinessOtp({ prisma, msisdn: OWNER, code: fresh, source: '198.51.100.7' })).ok, true, 'the owner, from their own connection, signs in');
  // Password: five failures from one source lock that source only.
  const p2 = stubPrisma({ withBusiness: true });
  biz(p2).passwordHash = await hashBusinessPassword('correct horse battery');
  for (let i = 0; i < BUSINESS_PW_LOCKOUT_FAILS; i += 1) await verifyBusinessPassword({ prisma: p2, msisdn: OWNER, password: 'wrong password!!', source: 'attacker' });
  assert.equal((await verifyBusinessPassword({ prisma: p2, msisdn: OWNER, password: 'correct horse battery', source: 'attacker' })).error, 'LOCKED_OUT');
  assert.equal((await verifyBusinessPassword({ prisma: p2, msisdn: OWNER, password: 'correct horse battery', source: 'owner-pc' })).ok, true);
  assert.ok(!libAuth.includes("code: `${PW_FAIL_PREFIX}${crypto.randomBytes"), 'password failures carry the source key');
  assert.match(libAuth, /await argon2\.verify\(await dummyHash\(\), password\)/, 'timing-equal refusal when no business or password exists');
});

test('review: fees and method come from the BOOKED intent, never today\'s env; REPAIR rows classify as card', () => {
  const row = { status: 'PAID', amountCents: 15000, payerRef: 'PAYFAST:pf1' };
  assert.deepEqual(classifyPaid(row, { status: 'SUCCESS', metadata: { feeCents: 123 } }), { method: 'CARD', feeCents: 123 }, 'booked fee wins');
  assert.deepEqual(classifyPaid(row, null), { method: 'CARD', feeCents: paymentRequestFeeCents(15000) }, 'legacy row without intent: banded fee');
  assert.deepEqual(classifyPaid({ status: 'PAID', amountCents: 5000, payerRef: 'REPAIR:replayed' }, { status: 'SUCCESS', providerRef: 'pf9', metadata: { feeCents: 440 } }), { method: 'CARD', feeCents: 440 }, 'a repaired row that the card leg settled is a card payment');
  assert.deepEqual(classifyPaid({ status: 'PAID', amountCents: 5000, payerRef: 'WAPAY:acc' }, null), { method: 'WAPAY', feeCents: 0 });
  assert.deepEqual(classifyPaid({ status: 'PENDING', amountCents: 5000 }, null), { method: null, feeCents: 0 });
});

test('review: buckets are SAST (UTC+2), not UTC', () => {
  const lateAugUtc = new Date(Date.UTC(2026, 7, 31, 23, 30)); // 01:30 SAST on 1 Sep
  assert.equal(monthKey(lateAugUtc), '2026-09'); assert.equal(dayKey(lateAugUtc), '2026-09-01');
  assert.deepEqual(lastMonths(2, lateAugUtc), ['2026-08', '2026-09']);
});

test('review: lifetime and outstanding totals come from aggregates, not the scanned slice; conversion compares like with like', async () => {
  const { prisma, thabo } = await seededBusiness();
  // 600 more paid links for Thabo: the 500-row scan must not understate the lifetime.
  for (let i = 0; i < 600; i += 1) {
    prisma.paymentRequest._rows.push({ id: `PRBULK${String(i).padStart(3, '0')}`, accountId: 'acc-owner', amountCents: 100, status: 'PAID', payerRef: 'WAPAY:acc-payer', paidAt: new Date(Date.now() - 400 * 86400000), createdAt: new Date(Date.now() - 400 * 86400000), expiresAt: new Date(), businessId: 'biz1', customerId: thabo.id, note: null, items: null, reference: null, channel: null, sentAt: null });
  }
  const p = await getCustomerProfile({ prisma, businessId: 'biz1', customerId: thabo.id });
  assert.equal(p.stats.paidCount, 602); assert.equal(p.stats.paidCents, 20000 + 60000); assert.equal(p.truncated, true); assert.equal(p.links.length, 500);
  const o = await businessOverview({ prisma, businessId: 'biz1', rangeDays: 30 });
  assert.equal(o.vitals.outstandingCents, 8000, 'aggregate, not a 500-row slice');
  assert.equal(o.vitals.linksCreated, 5, 'links created in the period (the bulk rows are 400 days old)');
  assert.equal(o.vitals.conversionPct, 60, '3 of the 5 links created in the period were paid: same population top and bottom');
});

test('review: import is batched and capped; a concurrent create adopts the winner', async () => {
  const prisma = stubPrisma({ withBusiness: true });
  const rows = parseContactsImport(Array.from({ length: 40 }, (_, i) => `Person ${i}, 07${String(10000000 + i).padStart(8, '0')}`).join('\n'));
  const out = await importCustomers({ prisma, businessId: 'biz1', rows });
  assert.equal(out.added, 40); assert.equal(out.refused, 0);
  const again = await importCustomers({ prisma, businessId: 'biz1', rows });
  assert.equal(again.added, 0); assert.equal(again.skipped, 40, 'all already there');
  // Race: a row appears between find and create → the loser adopts it.
  const racing = stubPrisma({ withBusiness: true });
  const origCreate = racing.businessCustomer.create.bind(racing.businessCustomer);
  let once = true;
  racing.businessCustomer.create = async (args) => { if (once) { once = false; await origCreate({ data: { ...args.data, id: 'winner' } }); } return origCreate(args); };
  const res = await upsertCustomer({ prisma: racing, businessId: 'biz1', msisdn: '0731230000', name: 'Racer' });
  assert.equal(res.customer.id, 'winner'); assert.equal(res.created, false);
});

test('review: who-paid line is shared by both rails and sanitised', async () => {
  const { prisma, thabo } = await seededBusiness();
  const r = prisma.paymentRequest._rows.find((x) => x.customerId === thabo.id);
  r.reference = '*T-1*';
  assert.equal(await businessPaidLine({ prisma, request: r }), '🧾 from Thabo Nkosi · ref T-1');
  assert.equal(await businessPaidLine({ prisma, request: { businessId: null } }), null);
});


// ---------------------------------------------------------------------------
// Completeness critics 2026-09-05 — regression guards
// ---------------------------------------------------------------------------

test('critics: a suspended business is not payable on ANY rail (pay page, checkout, chat confirm, chat PIN settle)', async () => {
  const { businessRequestPayable } = await import('../lib/business.js');
  const prisma = stubPrisma({ withBusiness: true });
  assert.equal(await businessRequestPayable({ prisma, request: { businessId: null } }), true, 'personal links are untouched');
  assert.equal(await businessRequestPayable({ prisma, request: { businessId: 'biz1' } }), true);
  biz(prisma).status = 'SUSPENDED';
  assert.equal(await businessRequestPayable({ prisma, request: { businessId: 'biz1' } }), false);
  assert.equal(await businessRequestPayable({ prisma, request: { businessId: 'nope' } }), false, 'missing row fails closed');
  const checkout = read('../pages/api/pay/checkout.js');
  assert.match(checkout, /businessRequestPayable\(\{ request \}\)/, 'checkout asks the shared helper');
  assert.equal((checkout.match(/res\.status\(410\)/g) || []).length, 1, 'still exactly one 410 path');
  const confirmIdx = processor.indexOf("await updateConversationState(from, 'PAYREQ_CONFIRM'");
  assert.ok(processor.slice(confirmIdx - 1500, confirmIdx).includes('businessRequestPayable({ request })'), 'chat confirm checks payability before PAYREQ_CONFIRM');
  const pinIdx = processor.indexOf("const request = await getPaymentRequest({ code: data.code });");
  assert.ok(processor.slice(pinIdx, pinIdx + 900).includes('businessStillPayable'), 'PIN settle re-checks payability');
  assert.match(payPage, /business\.status === 'ACTIVE'/);
  assert.match(processor, /will see your number for its records/, 'balance payers are told the business receives their number');
  assert.match(payPage, /receives your number for its records/, 'card payers too');
});

test('critics: nudge claims the link atomically before sending; a failed send releases the claim', async () => {
  const { prisma, thabo } = await seededBusiness();
  process.env.WAPAY_BUSINESS_NOTIFY = 'true';
  const link = await createBusinessLink({ prisma, business: biz(prisma), customerId: thabo.id, amountCents: 5000 });
  let inFlight = 0, maxInFlight = 0, sends = 0;
  const slowSend = { text: async () => { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 20)); inFlight -= 1; sends += 1; return { ok: true }; }, template: async () => ({ ok: false }), direct: async () => ({ ok: false }), directEnabled: () => false };
  const [a, b] = await Promise.all([
    sendLinkViaWaPay({ prisma, business: biz(prisma), customer: thabo, code: link.link.code, send: slowSend }),
    sendLinkViaWaPay({ prisma, business: biz(prisma), customer: thabo, code: link.link.code, send: slowSend }),
  ]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true], 'exactly one winner');
  assert.equal(sends, 1, 'the customer gets ONE message');
  // Undeliverable: the claim is released so the owner can retry later.
  const second = await createBusinessLink({ prisma, business: biz(prisma), customerId: thabo.id, amountCents: 6000 });
  const dead = { text: async () => ({ ok: false, error: 'down' }), template: async () => ({ ok: false }), direct: async () => ({ ok: false }), directEnabled: () => false };
  assert.equal((await sendLinkViaWaPay({ prisma, business: biz(prisma), customer: thabo, code: second.link.code, send: dead })).error, 'UNDELIVERABLE');
  const row = prisma.paymentRequest._rows.find((r) => r.id === second.link.code);
  assert.equal(row.channel, null, 'claim released'); assert.equal(row.sentAt, null);
  delete process.env.WAPAY_BUSINESS_NOTIFY;
  const linksRoute = read('../pages/api/business/links.js');
  assert.match(linksRoute, /\['WHATSAPP_BUSINESS', 'COPY'\]\.includes\(body\.channel\)/, 'route refuses channel WAPAY from browsers');
});

test('critics: password set/clear needs a fresh factor; owners must be onboarded wallets', async () => {
  armEnv();
  const { verifyStepUp } = await import('../lib/business-auth.js');
  const prisma = stubPrisma({ withBusiness: true });
  // No password yet → a fresh code is the factor.
  assert.deepEqual(await verifyStepUp({ prisma, business: biz(prisma), msisdn: OWNER }), { ok: false, error: 'STEP_UP_REQUIRED' });
  const code = await issueCode(prisma);
  assert.equal((await verifyStepUp({ prisma, business: biz(prisma), msisdn: OWNER, code })).via, 'otp');
  // With a password → the current password is the factor; a cookie alone is refused.
  biz(prisma).passwordHash = await hashBusinessPassword('correct horse battery');
  assert.deepEqual(await verifyStepUp({ prisma, business: biz(prisma), msisdn: OWNER }), { ok: false, error: 'STEP_UP_REQUIRED' });
  assert.equal((await verifyStepUp({ prisma, business: biz(prisma), msisdn: OWNER, currentPassword: 'wrong password!!' })).error, 'STEP_UP_FAILED');
  assert.equal((await verifyStepUp({ prisma, business: biz(prisma), msisdn: OWNER, currentPassword: 'correct horse battery' })).via, 'password');
  const settings = read('../pages/api/business/settings.js');
  assert.match(settings, /verifyStepUp\(/); assert.match(settings, /clear-password/); assert.match(settings, /business_password_set/);
  assert.match(page, /action: 'clear-password'/); assert.match(page, /currentPassword: stepUp/);
  // "No wallet, no business": a first-contact account is not an owner.
  const p2 = stubPrisma();
  const sends = [];
  await requestBusinessOtp({ prisma: p2, msisdn: '0839990000', send: async (a) => { sends.push(a); return { ok: true }; } });
  assert.equal(sends.length, 0, 'no code for an unfinished onboarding');
  assert.equal((await requestBusinessOtpInSession({ prisma: p2, msisdn: '0839990000' })).ok, false);
});

test('critics: overview range lookup ignores prototype keys; CSV window is created-or-paid; hosts must differ', async () => {
  const overviewRoute = read('../pages/api/business/overview.js');
  assert.match(overviewRoute, /Object\.hasOwn\(RANGES, rangeKey\)/);
  const { prisma } = await seededBusiness();
  // A ticket created long ago but paid inside the window appears in the export.
  const old = prisma.paymentRequest._rows.find((r) => r.status === 'PAID' && r.payerRef === 'WAPAY:acc-payer');
  old.createdAt = new Date(Date.now() - 200 * 86400000);
  const { csv } = await exportLinksCsv({ prisma, businessId: 'biz1', sinceDays: 90 });
  assert.ok(csv.includes(old.id), 'paid-in-window row exported despite an old createdAt');
  assert.match(middleware, /portal_host_collision/, 'identical admin/business hosts are logged and business gating disabled');
  const e2e = read('../tests/e2e/business-e2e.mjs');
  assert.match(e2e, /new URL\(RAW\)\.searchParams\.get\('schema'\)/, 'scratch-schema guard parses the URL');
  assert.match(e2e, /SELECT current_schema\(\)/, 'and verifies the live connection');
});


// ---------------------------------------------------------------------------
// Founder live test 2026-09-06 — a nine-digit invite entry must be loud
// ---------------------------------------------------------------------------

test('allowlist: a malformed entry is reported and ignored, never silently emptying the invite list', () => {
  armEnv();
  delete process.env.WAPAY_BUSINESS_SIGNUPS;
  process.env.WAPAY_BUSINESS_MSISDNS = '078705175, 0787051175 ,27731234567,+27 82 555 1234';
  const report = businessSignupAllowlistReport();
  assert.deepEqual(report.malformed, ['078705175'], 'the nine-digit typo is named');
  assert.deepEqual(report.valid, ['27787051175', '27731234567', '27825551234']);
  assert.equal(mayRegister('0787051175'), true, 'the well-formed twin still gets in');
  assert.equal(mayRegister('078705175'), false);
  const authRoute = read('../pages/api/business/auth.js');
  assert.match(authRoute, /malformed/, 'internal-key probe surfaces the parse');
  assert.match(authRoute, /if \(isInternal\)/, 'and only for internal-key callers');
  assert.match(libAuth, /business_allowlist_malformed/, 'logged once per cold start');
  delete process.env.WAPAY_BUSINESS_MSISDNS;
});

test('brand: the portal renders the official lockup and favicons, not a drawn placeholder', () => {
  assert.match(page, /\/brand\/wapay-lockup-120\.png/); assert.match(page, /\/brand\/wapay-lockup-240\.png 2x/);
  assert.match(page, /rel="apple-touch-icon"/); assert.match(page, /\/brand\/favicon-32\.png/);
  assert.ok(!/className="mark"/.test(page), 'the invented W tile is gone');
  assert.ok(!/content:"W"/.test(page), 'no CSS-drawn mark');
  for (const f of ['wapay-lockup-120.png', 'wapay-lockup-240.png', 'favicon-32.png', 'favicon-48.png', 'apple-touch-icon.png', 'wapay-favicon-128.png']) {
    assert.ok(existsSync(fileURLToPath(new URL(`../public/brand/${f}`, import.meta.url))), `public/brand/${f} ships with the app`);
  }
});
