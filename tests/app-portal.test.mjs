/**
 * The personal web portal (2026-10-21, docs/briefs/PERSONAL_PORTAL_BRIEF.md).
 *
 * Locks:
 * - sign-in: the cell number and the PIN through verifyPIN only; a wrong PIN and
 *   an unknown number answer the same; 5 failures per number and per IP in 15
 *   minutes lock for 15 minutes (verifyPIN is not asked again); a malformed PIN
 *   never reaches the verifier; the web never spends the shared counter past 8;
 *   the session cookie is HttpOnly, Secure, SameSite=Lax, 24 h, Path=/api/app,
 *   dies when the PIN changes, and no other console's token opens it;
 * - CSRF: every POST needs the header equal to the cookie and our MAC, bound to
 *   the session once signed in; cross-site requests are refused;
 * - forgot PIN: the whole ID number on file (last characters + keyed digest);
 *   a miss, no ID on file and an unknown number answer the same; three misses
 *   pause resets (the chat's counter); the reset sets the chat's cool-off;
 * - money: payout request, send execute and link create are unreachable
 *   without the session AND a fresh PIN proof for this account, intent and
 *   amount; the proof is checked before the vault is read or a row written;
 *   freeze, rules and cool-off refuse with the chat's own words; the answers
 *   carry labels and last digits only; audit rows for every action;
 * - structure: no model, no WhatsApp send, no proof minted outside verifyPIN,
 *   no PIN in a log line, no em dash in customer copy, the dev fixture can
 *   never run in production.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.WAPAY_APP_SESSION_SECRET = 'test-app-session-secret-0123456789';
process.env.WAPAY_PIN_PROOF_SECRET ||= 'test-pin-proof-secret';
delete process.env.WAPAY_PAYOUT_KYC;

const { issuePinProof, verifyPinProof } = await import('@wapay/auth/pin-proof');
const { createFixtureDeps, FIXTURE_CELL } = await import('../lib/app-dev-fixture.js');
const auth = await import('../lib/app-auth.js');
const { devFixtureOn } = await import('../lib/app-deps.js');
const { webLine, activityPage, comingSoonTiles, linkQuote, bannerFor } = await import('../lib/app-portal.js');
const { newIntentId, INTENT_PREFIX } = await import('../lib/app-money.js');
const { appOrigin } = await import('../lib/app-http.js');
const { dailyCapCopy, kycThresholdCopy } = await import('../lib/payout-rules.js');
const { FROZEN_PAYOUT_COPY, FROZEN_SEND_COPY } = await import('../lib/payout-freeze.js');
const { mintBusinessToken } = await import('../lib/business-auth.js');
const { startKycSession, kycReturnUrl } = await import('../lib/didit-kyc.js');
const { createAuthHandler } = await import('../pages/api/app/auth.js');
const { createForgotHandler } = await import('../pages/api/app/forgot.js');
const { createPinHandler } = await import('../pages/api/app/pin.js');
const { createPayoutHandler } = await import('../pages/api/app/payout.js');
const { createSendHandler } = await import('../pages/api/app/send.js');
const { createLinksHandler } = await import('../pages/api/app/links.js');
const { createHomeHandler } = await import('../pages/api/app/home.js');
const { createActivityHandler } = await import('../pages/api/app/activity.js');
const { createProfileHandler } = await import('../pages/api/app/profile.js');
const { createTopupHandler } = await import('../pages/api/app/topup.js');

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const ACC = 'cfixtureaccount000000000001';
const DEST = 'cfixturedest0000000001';
const PIN = '2580';

// ---------------------------------------------------------------------------
// Harness: the fixture's in-memory database, a verifyPIN stand-in that issues
// REAL proofs, and spies on every library that moves money.
// ---------------------------------------------------------------------------

function harness(over = {}) {
  const d = createFixtureDeps();
  const t = d.prisma._tables;
  const calls = { verifyPIN: [], requestPayout: [], sendMoney: [], createPaymentRequest: [], loadDestination: [], loadIdentity: [], resetPIN: [], setPIN: [], save: [], saveIdentity: [], kyc: [], deposit: [] };
  const pin = { value: PIN };
  const factor = (id = ACC) => t.authFactor.find((f) => f.accountId === id);
  const deps = {
    ...d,
    slowWork: async () => {},
    verifyPinProof,
    async verifyPIN({ accountId, pin: typed, approves }) {
      calls.verifyPIN.push({ accountId, approves: approves || null });
      const f = factor(accountId);
      if (!f) return { ok: false, error: 'PIN_NOT_SET' };
      if (f.lockedUntil && new Date(f.lockedUntil).getTime() > Date.now()) return { ok: false, error: f.attempts >= 10 ? 'HARD_LOCKOUT' : 'SOFT_LOCKOUT', lockedUntil: f.lockedUntil };
      if (typed !== pin.value) {
        f.attempts += 1;
        if (f.attempts >= 5) f.lockedUntil = new Date(Date.now() + 15 * 60000);
        return { ok: false, error: 'INVALID_PIN', lockedUntil: f.lockedUntil || undefined };
      }
      f.attempts = 0;
      f.lockedUntil = null;
      return { ok: true, ...(approves ? { proof: issuePinProof({ accountId, intentId: approves.intentId, amountCents: approves.amountCents }) } : {}) };
    },
    async setPIN({ accountId, pin: next }) { calls.setPIN.push(accountId); pin.value = next; factor(accountId).setAt = new Date(Date.now() + 1000); return { ok: true }; },
    async resetPIN({ accountId, newPin, otpVerified }) { calls.resetPIN.push({ accountId, otpVerified }); if (!otpVerified) return { ok: false }; pin.value = newPin; factor(accountId).setAt = new Date(Date.now() + 1000); factor(accountId).attempts = 0; return { ok: true }; },
    async requestPayout(args) {
      calls.requestPayout.push(args);
      const v = verifyPinProof(args.authorization, { accountId: args.account.id, intentId: args.intentId, amountCents: args.amountCents });
      if (!v.ok) return { ok: false, error: 'NOT_AUTHORISED' };
      return { ok: true, status: 'PENDING', reference: 'WPTESTREF0000001', amountCents: args.amountCents, feeCents: 800, outcome: 'PENDING' };
    },
    async sendMoney(args) {
      calls.sendMoney.push(args);
      const v = verifyPinProof(args.authorization, { accountId: args.sender.id, intentId: args.previewId, amountCents: args.amountCents });
      if (!v.ok) return { ok: false, error: 'NOT_AUTHORISED' };
      return { ok: true, delivered: 'HELD', amountCents: args.amountCents, replayed: false };
    },
    async createPaymentRequest(args) { calls.createPaymentRequest.push(args); return d.createPaymentRequest(args); },
    async loadPayoutDestinationSecret(args) { calls.loadDestination.push(args.id); return d.loadPayoutDestinationSecret(args); },
    async loadPayoutIdentitySecret(args) { calls.loadIdentity.push(args.accountId); return d.loadPayoutIdentitySecret(args); },
    async savePayoutDestination(args) { calls.save.push(args); return d.savePayoutDestination(args); },
    async savePayoutIdentity(args) { calls.saveIdentity.push(args); return d.savePayoutIdentity(args); },
    async startKycSession(args) { calls.kyc.push(args); return { ok: true, url: 'https://verify.example.test/session/abc' }; },
    async createDepositIntent(args) { calls.deposit.push(args); return d.createDepositIntent(args); },
    ...over,
  };
  return { deps, calls, t, pin, factor };
}

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}
async function call(handler, { method = 'GET', body, query = {}, cookie = '', csrf, ip = '10.1.1.1', headers = {} } = {}) {
  const req = { method, body, query, socket: {}, headers: { host: 'app.wapay.co.za', 'x-real-ip': ip, ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-wapay-csrf': csrf } : {}), ...headers } };
  const res = mkRes();
  await handler(req, res);
  return res;
}
function preSession() {
  const csrf = auth.mintPreCsrf();
  return { cookie: `wapay_app_csrf=${csrf}`, csrf };
}
async function signedIn(h, id = ACC) {
  const f = h.factor(id);
  const { token, sid } = auth.mintAppToken({ accountId: id, pinSetAt: auth.pinSetAtOf(f) });
  const csrf = auth.csrfForSession(sid);
  return { cookie: `wapay_app=${token}; wapay_app_csrf=${csrf}`, csrf, token };
}
const cookieValue = (setCookie, name) => {
  const all = Array.isArray(setCookie) ? setCookie : [setCookie];
  const hit = all.find((c) => String(c).startsWith(`${name}=`));
  return hit ? String(hit).split(';')[0].slice(name.length + 1) : null;
};
async function proofVia(h, s, { purpose, intentId, amountCents }) {
  const r = await call(createPinHandler(h.deps), { method: 'POST', ...s, body: { purpose, intentId, amountCents, pin: PIN } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  return r.body.proof;
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

test('sign-in: the right PIN opens a session with the binding cookie flags and an APP_LOGIN row', async () => {
  const h = harness();
  const s = preSession();
  const r = await call(createAuthHandler(h.deps), { method: 'POST', ...s, body: { action: 'login', msisdn: '060 000 0919', pin: PIN } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const cookies = r.headers['set-cookie'];
  const session = cookies.find((c) => c.startsWith('wapay_app='));
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=86400', 'Path=/api/app']) assert.ok(session.includes(flag), flag);
  assert.match(r.body.csrf, /^s\./, 'a CSRF token bound to the new session');
  const v = auth.verifyAppToken(cookieValue(cookies, 'wapay_app'));
  assert.equal(v.ok, true);
  assert.equal(v.accountId, ACC);
  assert.equal(h.calls.verifyPIN.length, 1);
  assert.equal(h.calls.verifyPIN[0].approves, null, 'signing in approves no money');
  assert.ok(h.t.auditLog.some((a) => a.event === 'APP_LOGIN' && a.metadata.ok === true));
  assert.ok(!JSON.stringify(h.t.auditLog).includes(PIN), 'the PIN is in no audit row');
});

test('sign-in: a wrong PIN and an unknown number answer exactly the same', async () => {
  const h = harness();
  const s = preSession();
  const wrong = await call(createAuthHandler(h.deps), { method: 'POST', ...s, body: { action: 'login', msisdn: FIXTURE_CELL, pin: '1111' } });
  const unknown = await call(createAuthHandler(h.deps), { method: 'POST', ...s, ip: '10.9.9.9', body: { action: 'login', msisdn: '0829999999', pin: '1111' } });
  assert.equal(wrong.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.deepEqual(wrong.body, unknown.body);
  assert.equal(wrong.headers['set-cookie'], undefined, 'no session on a failure');
  assert.equal(h.calls.verifyPIN.length, 1, 'the verifier is asked only for a real account');
});

test('sign-in: 5 failures for a number lock it for 15 minutes without asking verifyPIN again; 5 from one IP lock that IP', async () => {
  const h = harness();
  const s = preSession();
  for (let i = 0; i < 5; i += 1) {
    const r = await call(createAuthHandler(h.deps), { method: 'POST', ...s, ip: `10.2.0.${i}`, body: { action: 'login', msisdn: FIXTURE_CELL, pin: '1111' } });
    assert.ok([401, 423].includes(r.statusCode), String(r.statusCode));
  }
  const asked = h.calls.verifyPIN.length;
  const locked = await call(createAuthHandler(h.deps), { method: 'POST', ...s, ip: '10.2.0.99', body: { action: 'login', msisdn: FIXTURE_CELL, pin: PIN } });
  assert.equal(locked.statusCode, 429);
  assert.equal(locked.body.error, 'LOCKED');
  assert.equal(h.calls.verifyPIN.length, asked, 'locked: the verifier is not asked');

  const h2 = harness();
  for (let i = 0; i < 5; i += 1) await call(createAuthHandler(h2.deps), { method: 'POST', ...s, ip: '10.3.3.3', body: { action: 'login', msisdn: `08200000${10 + i}`, pin: '1111' } });
  const ipLocked = await call(createAuthHandler(h2.deps), { method: 'POST', ...s, ip: '10.3.3.3', body: { action: 'login', msisdn: FIXTURE_CELL, pin: PIN } });
  assert.equal(ipLocked.statusCode, 429, 'the IP is locked whatever number it tries next');
});

test('sign-in: a malformed PIN never reaches the verifier; the web never spends the shared counter past 8', async () => {
  const h = harness();
  const s = preSession();
  for (const bad of ['12a4', '123', '1234567', '', ' 2580']) {
    const r = await call(createAuthHandler(h.deps), { method: 'POST', ...s, body: { action: 'login', msisdn: FIXTURE_CELL, pin: bad } });
    assert.equal(r.statusCode, 400);
  }
  assert.equal(h.calls.verifyPIN.length, 0);
  h.factor().attempts = 8;
  const r = await call(createAuthHandler(h.deps), { method: 'POST', ...s, body: { action: 'login', msisdn: FIXTURE_CELL, pin: PIN } });
  assert.equal(r.statusCode, 423);
  assert.equal(r.body.error, 'PIN_RESET_NEEDED');
  assert.equal(h.calls.verifyPIN.length, 0, 'the 9th and 10th attempts (the long lock) are never spent from the web');
  h.factor().attempts = 5;
  h.factor().lockedUntil = new Date(Date.now() + 10 * 60000);
  const soft = await call(createAuthHandler(h.deps), { method: 'POST', ...s, body: { action: 'login', msisdn: FIXTURE_CELL, pin: PIN } });
  assert.equal(soft.statusCode, 423);
  assert.equal(soft.body.error, 'PIN_LOCKED');
});

test('CSRF: no header, a mismatch, a forged token or a cross-site request is refused before anything else', async () => {
  const h = harness();
  const s = preSession();
  const body = { action: 'login', msisdn: FIXTURE_CELL, pin: PIN };
  assert.equal((await call(createAuthHandler(h.deps), { method: 'POST', cookie: s.cookie, body })).statusCode, 403);
  assert.equal((await call(createAuthHandler(h.deps), { method: 'POST', cookie: s.cookie, csrf: auth.mintPreCsrf(), body })).statusCode, 403);
  assert.equal((await call(createAuthHandler(h.deps), { method: 'POST', cookie: 'wapay_app_csrf=p.abc.def', csrf: 'p.abc.def', body })).statusCode, 403);
  assert.equal((await call(createAuthHandler(h.deps), { method: 'POST', ...s, headers: { 'sec-fetch-site': 'cross-site' }, body })).statusCode, 403);
  assert.equal((await call(createAuthHandler(h.deps), { method: 'POST', ...s, headers: { origin: 'https://evil.example' }, body })).statusCode, 403);
  assert.equal(h.calls.verifyPIN.length, 0);
  // Signed in, a token minted for another session (or a pre-session one) opens nothing.
  const a = await signedIn(h);
  const other = await signedIn(h);
  const r = await call(createLinksHandler(h.deps), { method: 'POST', cookie: `wapay_app=${a.token}; wapay_app_csrf=${other.csrf}`, csrf: other.csrf, body: { action: 'cancel', code: 'PRDEMOEF' } });
  assert.equal(r.statusCode, 403);
});

test('the session: tampered, expired, PIN changed, another console, unfinished account: all refused', async () => {
  const h = harness();
  const ok = await signedIn(h);
  const home = createHomeHandler(h.deps);
  assert.equal((await call(home, { cookie: ok.cookie })).statusCode, 200);
  const [b64, exp, sig] = ok.token.split('.');
  assert.equal((await call(home, { cookie: `wapay_app=${b64}.${Number(exp) + 1}.${sig}` })).statusCode, 401, 'tampered');
  const old = auth.mintAppToken({ accountId: ACC, pinSetAt: auth.pinSetAtOf(h.factor()), now: Date.now() - 25 * 3600 * 1000 });
  assert.equal((await call(home, { cookie: `wapay_app=${old.token}` })).statusCode, 401, 'expired after 24 h');
  process.env.WAPAY_BUSINESS_SESSION_SECRET = process.env.WAPAY_APP_SESSION_SECRET;
  const biz = mintBusinessToken({ businessId: 'b1', accountId: ACC });
  assert.equal((await call(home, { cookie: `wapay_app=${biz}` })).statusCode, 401, 'a business token never opens the app');
  delete process.env.WAPAY_BUSINESS_SESSION_SECRET;
  h.factor().setAt = new Date(Date.now() + 5000);
  assert.equal((await call(home, { cookie: ok.cookie })).statusCode, 401, 'a PIN change ends the session');
  const h2 = harness();
  const s2 = await signedIn(h2);
  h2.t.account[0].onboardingState = 'S3_PIN';
  h2.t.account[0].onboardingStatus = 'IN_PROGRESS';
  assert.equal((await call(createHomeHandler(h2.deps), { cookie: s2.cookie })).statusCode, 401);
});

test('fails closed without a secret; logout clears both cookies', async () => {
  const h = harness();
  const saved = process.env.WAPAY_APP_SESSION_SECRET;
  delete process.env.WAPAY_APP_SESSION_SECRET;
  try {
    const g = await call(createAuthHandler(h.deps));
    assert.equal(g.body.configured, false);
    const p = await call(createAuthHandler(h.deps), { method: 'POST', body: { action: 'login', msisdn: FIXTURE_CELL, pin: PIN } });
    assert.equal(p.statusCode, 503);
    assert.equal((await call(createHomeHandler(h.deps))).statusCode, 503);
  } finally {
    process.env.WAPAY_APP_SESSION_SECRET = saved;
  }
  const s = await signedIn(h);
  const out = await call(createAuthHandler(h.deps), { method: 'POST', ...s, body: { action: 'logout' } });
  assert.equal(out.statusCode, 200);
  const cleared = out.headers['set-cookie'];
  assert.ok(cleared.some((c) => c.startsWith('wapay_app=;') && c.includes('Max-Age=0')));
  assert.ok(cleared.some((c) => c.startsWith('wapay_app_csrf=;') && c.includes('Max-Age=0')));
});

// ---------------------------------------------------------------------------
// Forgot PIN
// ---------------------------------------------------------------------------

test('forgot PIN: the whole ID on file opens the reset; the new PIN twice resets it, sets the cool-off, audits and signs in', async () => {
  const h = harness();
  const s = preSession();
  const forgot = createForgotHandler(h.deps);
  const c = await call(forgot, { method: 'POST', ...s, body: { action: 'check', msisdn: FIXTURE_CELL, idNumber: '900101 5800 083' } });
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
  assert.ok(c.body.resetToken);
  const weak = await call(forgot, { method: 'POST', ...s, body: { action: 'reset', resetToken: c.body.resetToken, pin: '1234', pinAgain: '1234' } });
  assert.equal(weak.statusCode, 400);
  const differ = await call(forgot, { method: 'POST', ...s, body: { action: 'reset', resetToken: c.body.resetToken, pin: '4826', pinAgain: '4827' } });
  assert.equal(differ.body.error, 'PIN_MISMATCH');
  const r = await call(forgot, { method: 'POST', ...s, body: { action: 'reset', resetToken: c.body.resetToken, pin: '4826', pinAgain: '4826' } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(h.calls.resetPIN, [{ accountId: ACC, otpVerified: true }]);
  assert.equal(h.t.account[0].profile.pinReset.via, 'app');
  assert.equal(h.t.account[0].profile.pinReset.idChecked, false, 'one factor (the ID, not the phone): the chat cool-off applies');
  assert.ok(h.t.auditLog.some((a) => a.event === 'APP_PIN_RESET'));
  assert.ok(auth.verifyAppToken(cookieValue(r.headers['set-cookie'], 'wapay_app')).ok, 'signed in with the new PIN');
  const again = await call(forgot, { method: 'POST', ...s, body: { action: 'reset', resetToken: c.body.resetToken, pin: '5937', pinAgain: '5937' } });
  assert.equal(again.body.error, 'START_AGAIN', 'the token works once');
});

test('forgot PIN: a wrong ID, no ID on file and an unknown number get one answer; 3 misses pause resets (the chat counter)', async () => {
  const h = harness();
  const s = preSession();
  const forgot = createForgotHandler(h.deps);
  const tail = await call(forgot, { method: 'POST', ...s, body: { action: 'check', msisdn: FIXTURE_CELL, idNumber: '8001015800083' } });
  assert.equal(tail.statusCode, 401, 'the last digits alone never pass');
  const h2 = harness();
  h2.t.payoutIdentity.length = 0;
  const none = await call(createForgotHandler(h2.deps), { method: 'POST', ...s, body: { action: 'check', msisdn: FIXTURE_CELL, idNumber: '9001015800083' } });
  const unknown = await call(createForgotHandler(h2.deps), { method: 'POST', ...s, ip: '10.4.4.4', body: { action: 'check', msisdn: '0821112222', idNumber: '9001015800083' } });
  assert.deepEqual(none.body, tail.body);
  assert.deepEqual(unknown.body, tail.body);
  assert.match(tail.body.line, /help@wapay\.co\.za/);
  await call(forgot, { method: 'POST', ...s, ip: '10.5.0.1', body: { action: 'check', msisdn: FIXTURE_CELL, idNumber: '9001015800084' } });
  await call(forgot, { method: 'POST', ...s, ip: '10.5.0.2', body: { action: 'check', msisdn: FIXTURE_CELL, idNumber: '9001015800085' } });
  assert.equal(h.t.auditLog.filter((a) => a.event === 'PIN_RESET_ID_FAILED').length, 3, 'counted where the chat counts');
  const paused = await call(forgot, { method: 'POST', ...s, ip: '10.5.0.3', body: { action: 'check', msisdn: FIXTURE_CELL, idNumber: '9001015800083' } });
  assert.equal(paused.statusCode, 429, 'even the right ID waits after three misses');
  assert.equal(h.calls.resetPIN.length, 0);
});

test('forgot PIN: a vault that cannot be read fails closed', async () => {
  const h = harness({ async loadPayoutIdentitySecretStrict() { throw new Error('VAULT_BAD_VALUE'); } });
  const r = await call(createForgotHandler(h.deps), { method: 'POST', ...preSession(), body: { action: 'check', msisdn: FIXTURE_CELL, idNumber: '9001015800083' } });
  assert.equal(r.statusCode, 503);
  assert.equal(r.body.resetToken, undefined);
});

test('idNumberMatches: the whole number, case and spacing aside, never the tail alone', () => {
  assert.equal(auth.idNumberMatches('900101 5800 083', '9001015800083'), true);
  assert.equal(auth.idNumberMatches('fn123456', 'FN123456'), true);
  assert.equal(auth.idNumberMatches('083', '9001015800083'), false);
  assert.equal(auth.idNumberMatches('1111115800083', '9001015800083'), false);
});

// ---------------------------------------------------------------------------
// The PIN step and the proof
// ---------------------------------------------------------------------------

test('the PIN step: a correct PIN returns a proof for exactly this intent and amount; wrong PINs count and lock', async () => {
  const h = harness();
  const s = await signedIn(h);
  const pin = createPinHandler(h.deps);
  const intentId = newIntentId('payout');
  assert.equal((await call(pin, { method: 'POST', body: { purpose: 'payout', intentId, amountCents: 10000, pin: PIN } })).statusCode, 401, 'no session');
  assert.equal((await call(pin, { method: 'POST', cookie: s.cookie, body: { purpose: 'payout', intentId, amountCents: 10000, pin: PIN } })).statusCode, 403, 'no CSRF');
  assert.equal((await call(pin, { method: 'POST', ...s, body: { purpose: 'payout', intentId, amountCents: 10000, pin: '12x4' } })).statusCode, 400);
  assert.equal((await call(pin, { method: 'POST', ...s, body: { purpose: 'payout', intentId: newIntentId('link'), amountCents: 10000, pin: PIN } })).body.error, 'BAD_INTENT', 'a link intent is not a pay-out');
  assert.equal(h.calls.verifyPIN.length, 0);
  const ok = await call(pin, { method: 'POST', ...s, body: { purpose: 'payout', intentId, amountCents: 10000, pin: PIN } });
  assert.equal(ok.statusCode, 200);
  assert.equal(verifyPinProof(ok.body.proof, { accountId: ACC, intentId, amountCents: 10000 }).ok, true);
  assert.equal(verifyPinProof(ok.body.proof, { accountId: ACC, intentId, amountCents: 10001 }).ok, false);
  assert.deepEqual(h.calls.verifyPIN.at(-1).approves, { intentId, amountCents: 10000 });
  for (let i = 0; i < 4; i += 1) assert.equal((await call(pin, { method: 'POST', ...s, body: { purpose: 'payout', intentId, amountCents: 10000, pin: '1111' } })).statusCode, 401);
  const fifth = await call(pin, { method: 'POST', ...s, body: { purpose: 'payout', intentId, amountCents: 10000, pin: '1111' } });
  assert.ok([401, 423].includes(fifth.statusCode));
  const sixth = await call(pin, { method: 'POST', ...s, body: { purpose: 'payout', intentId, amountCents: 10000, pin: PIN } });
  assert.equal(sixth.statusCode, 429, 'five wrong PINs in 15 minutes: the step is locked');
});

test('the PIN step for a send checks the preview belongs to this account and amount before a PIN attempt is spent', async () => {
  const h = harness();
  const s = await signedIn(h);
  h.t.providerRequest.push({ id: 'preview-send-someone-else', idemKey: 'preview-send-someone-else', route: 'send-preview', status: 'PENDING', accountId: 'cotheraccount', provider: 'WAPAY', requestTs: new Date(), metadata: { amountCents: 5000, recipientMsisdn: '0820000001', expiresAt: new Date(Date.now() + 60000).toISOString() } });
  const r = await call(createPinHandler(h.deps), { method: 'POST', ...s, body: { purpose: 'send', intentId: 'preview-send-someone-else', amountCents: 5000, pin: PIN } });
  assert.equal(r.statusCode, 404);
  assert.equal(h.calls.verifyPIN.length, 0);
});

// ---------------------------------------------------------------------------
// Pay out
// ---------------------------------------------------------------------------

async function checked(h, s, body = {}) {
  const r = await call(createPayoutHandler(h.deps), { method: 'POST', ...s, body: { action: 'check', method: 'PAYSHAP', amountCents: 50000, destinationId: DEST, ...body } });
  return r;
}

test('pay out: the context shows labels and last digits only', async () => {
  const h = harness();
  const s = await signedIn(h);
  const r = await call(createPayoutHandler(h.deps), { cookie: s.cookie });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.saved[0].label, 'Mine: TymeBank account •••595');
  assert.equal(r.body.identity.idLast3, '083');
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes('5100000595') && !text.includes('9001015800083'), 'no full account or ID number');
  assert.equal(h.calls.loadDestination.length + h.calls.loadIdentity.length, 0, 'nothing decrypted to show the screen');
});

test('pay out: check quotes the fee and mints the intent; request pays through requestPayout with the proof, the vault read at use', async () => {
  const h = harness();
  const s = await signedIn(h);
  const c = await checked(h, s);
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
  assert.ok(c.body.intentId.startsWith(INTENT_PREFIX.payout));
  assert.equal(c.body.totalCents, c.body.amountCents + c.body.feeCents);
  assert.equal(c.body.destinationLabel, 'Mine: TymeBank account •••595');
  const proof = await proofVia(h, s, { purpose: 'payout', intentId: c.body.intentId, amountCents: 50000 });
  const r = await call(createPayoutHandler(h.deps), { method: 'POST', ...s, body: { action: 'request', intentId: c.body.intentId, method: 'PAYSHAP', amountCents: 50000, destinationId: DEST, proof } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.payoutStatus, 'PENDING');
  assert.equal(h.calls.requestPayout.length, 1);
  const args = h.calls.requestPayout[0];
  assert.equal(args.authorization, proof);
  assert.equal(args.recipient.account_number, '5100000595', 'the saved account, decrypted at the moment of use');
  assert.equal(args.recipient.id_number, '9001015800083');
  assert.equal(args.recipient.mobile, '27600000919', "PayShap's SMS rides on the customer's own number");
  assert.deepEqual(h.calls.loadDestination, [DEST]);
  assert.ok(!JSON.stringify(r.body).includes('5100000595'), 'the answer carries no full number');
  const row = h.t.auditLog.find((a) => a.event === 'APP_PAYOUT');
  assert.equal(row.metadata.status, 'PENDING');
  assert.ok(!JSON.stringify(row).includes('5100000595'));
});

test('pay out: unreachable without the session and a fresh proof for this intent and amount; nothing decrypted first', async () => {
  const h = harness();
  const s = await signedIn(h);
  const c = await checked(h, s);
  const intentId = c.body.intentId;
  const payout = createPayoutHandler(h.deps);
  const base = { action: 'request', intentId, method: 'PAYSHAP', amountCents: 50000, destinationId: DEST };
  const good = issuePinProof({ accountId: ACC, intentId, amountCents: 50000 });
  assert.equal((await call(payout, { method: 'POST', body: { ...base, proof: good } })).statusCode, 401, 'no session');
  assert.equal((await call(payout, { method: 'POST', cookie: s.cookie, body: { ...base, proof: good } })).statusCode, 403, 'no CSRF');
  const cases = [
    undefined,
    'nonsense',
    issuePinProof({ accountId: ACC, intentId, amountCents: 50100 }),
    issuePinProof({ accountId: ACC, intentId: newIntentId('payout'), amountCents: 50000 }),
    issuePinProof({ accountId: 'cotheraccount', intentId, amountCents: 50000 }),
    issuePinProof({ accountId: ACC, intentId, amountCents: 50000, now: Date.now() - 121000 }),
  ];
  for (const proof of cases) {
    const r = await call(payout, { method: 'POST', ...s, body: { ...base, proof } });
    assert.equal(r.statusCode, 403, `proof ${String(proof).slice(0, 12)}`);
    assert.equal(r.body.error, 'NO_PROOF');
  }
  const linkIntent = newIntentId('link');
  const wrongPurpose = await call(payout, { method: 'POST', ...s, body: { ...base, intentId: linkIntent, proof: issuePinProof({ accountId: ACC, intentId: linkIntent, amountCents: 50000 }) } });
  assert.equal(wrongPurpose.body.error, 'BAD_INTENT', "a link's proof never pays out");
  assert.equal(h.calls.requestPayout.length, 0);
  assert.equal(h.calls.loadDestination.length + h.calls.loadIdentity.length, 0, 'no saved detail decrypted without the proof');
});

test("pay out: a frozen account, the daily cap and the KYC threshold refuse in the chat's own words", async () => {
  const h = harness();
  const s = await signedIn(h);
  h.t.account[0].profile.payouts = { frozen: true, reason: 'check', at: new Date().toISOString() };
  const frozen = await checked(h, s);
  assert.equal(frozen.statusCode, 423);
  assert.ok(frozen.body.line.startsWith(FROZEN_PAYOUT_COPY.split(' A person')[0]));
  const intentId = newIntentId('payout');
  const proof = issuePinProof({ accountId: ACC, intentId, amountCents: 50000 });
  const req = await call(createPayoutHandler(h.deps), { method: 'POST', ...s, body: { action: 'request', intentId, method: 'PAYSHAP', amountCents: 50000, destinationId: DEST, proof } });
  assert.equal(req.statusCode, 423);
  assert.equal(h.calls.requestPayout.length, 0, 'frozen: no rail call');
  delete h.t.account[0].profile.payouts;

  const cap = { ok: false, error: 'DAILY_CAP', capCents: 1000000, usedCents: 900000, remainingCents: 100000, newAccount: true, newAccountDays: 7, isNew: true, verified: false };
  const h2 = harness({ async checkPayoutRules() { return cap; } });
  const s2 = await signedIn(h2);
  const capped = await checked(h2, s2);
  assert.equal(capped.statusCode, 409);
  assert.ok(capped.body.line.includes('New accounts can pay out up to R10,000 in any 24 hours.'));
  assert.ok(capped.body.line.includes(dailyCapCopy(cap).split(' Type a smaller')[0].replace('⏸ ', '')));
  assert.ok(!/"cancel"|\*/.test(capped.body.line), 'no chat-only instruction on the web');

  const kyc = { ok: false, error: 'KYC_REQUIRED', reason: 'SINGLE', thresholdCents: 300000, usedCents: 0, kycConfigured: true };
  const h3 = harness({ async checkPayoutRules() { return kyc; } });
  const s3 = await signedIn(h3);
  const needs = await checked(h3, s3);
  assert.equal(needs.statusCode, 403);
  assert.ok(needs.body.line.includes('Pay-outs over R3,000 need a once-off identity check on your phone.'), 'the threshold is read from the rule result');
  assert.ok(needs.body.line.endsWith('Verify your ID below, or choose a smaller amount.'));
  assert.equal(needs.body.kyc.canVerify, true);
  assert.ok(kycThresholdCopy(kyc).includes('Reply *VERIFY*'), 'the chat keeps its own instruction');
});

test('pay out: KYC refused at the rail remembers the pay-out for after the check; the Didit link comes back to the portal', async () => {
  const kyc = { ok: false, error: 'KYC_REQUIRED', reason: 'SINGLE', thresholdCents: 300000, kycConfigured: true };
  const h = harness({ async requestPayout() { return kyc; } });
  const s = await signedIn(h);
  const intentId = newIntentId('payout');
  const proof = await proofVia(h, s, { purpose: 'payout', intentId, amountCents: 50000 });
  const r = await call(createPayoutHandler(h.deps), { method: 'POST', ...s, body: { action: 'request', intentId, method: 'PAYSHAP', amountCents: 50000, destinationId: DEST, proof } });
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, 'KYC_REQUIRED');
  assert.equal(h.t.account[0].profile.app.pendingPayout.amountCents, 50000);
  assert.equal(h.t.account[0].profile.app.pendingPayout.destinationId, DEST);
  assert.equal(h.t.account[0].profile.kyc.pendingWithdraw.amountCents, 50000, "the chat's own record too");
  const k = await call(createPayoutHandler(h.deps), { method: 'POST', ...s, body: { action: 'kyc', pending: { amountCents: 50000, method: 'PAYSHAP', destinationId: DEST } } });
  assert.equal(k.statusCode, 200);
  assert.equal(h.calls.kyc[0].callbackUrl, 'https://app.wapay.co.za/app/pay-out?kyc=done');
  h.t.account[0].profile.kyc.status = 'VERIFIED';
  const ctx = await call(createPayoutHandler(h.deps), { cookie: s.cookie });
  assert.deepEqual(ctx.body.pending, { amountCents: 50000, method: 'PAYSHAP', destinationId: DEST });
});

test('pay out: new details wait out the PIN-reset cool-off; saved details still pay', async () => {
  const h = harness();
  h.t.account[0].profile.pinReset = { at: new Date().toISOString(), idChecked: false, via: 'app' };
  const s = await signedIn(h);
  const fresh = await checked(h, s, { destinationId: null, details: { bank: 'FNB', accountNumber: '62000000123' } });
  assert.equal(fresh.statusCode, 423);
  assert.equal(fresh.body.error, 'COOL_OFF');
  assert.match(fresh.body.line, /can only go to an account or number saved before the reset/);
  const intentId = newIntentId('payout');
  const proof = await proofVia(h, s, { purpose: 'payout', intentId, amountCents: 50000 });
  const sneaky = await call(createPayoutHandler(h.deps), { method: 'POST', ...s, body: { action: 'request', intentId, method: 'PAYSHAP', amountCents: 50000, details: { bank: 'FNB', accountNumber: '62000000123' }, proof } });
  assert.equal(sneaky.statusCode, 423, 'checked again right before the money');
  assert.equal(h.calls.requestPayout.length, 0);
  assert.equal((await checked(h, s)).statusCode, 200, 'a saved destination still works');
});

test('pay out: new details are saved only on the tick and only after the rail accepted', async () => {
  const h = harness();
  const s = await signedIn(h);
  const details = { bank: 'Capitec', accountNumber: '1234 5678 90' };
  const c = await checked(h, s, { destinationId: null, details });
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
  assert.equal(c.body.destinationLabel, 'Capitec account •••890');
  assert.equal(c.body.canSave, true);
  const proof = await proofVia(h, s, { purpose: 'payout', intentId: c.body.intentId, amountCents: 50000 });
  const r = await call(createPayoutHandler(h.deps), { method: 'POST', ...s, body: { action: 'request', intentId: c.body.intentId, method: 'PAYSHAP', amountCents: 50000, details, save: true, nickname: 'mine', proof } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(h.calls.requestPayout[0].recipient.branch_code, '470010', "Capitec's universal branch code");
  assert.equal(h.calls.save.length, 1);
  assert.equal(h.calls.save[0].nickname, 'Mine');

  const failing = harness({ async requestPayout() { return { ok: false, error: 'BAD_RECIPIENT', field: 'account_number' }; } });
  const s2 = await signedIn(failing);
  const c2 = await checked(failing, s2, { destinationId: null, details });
  const proof2 = await proofVia(failing, s2, { purpose: 'payout', intentId: c2.body.intentId, amountCents: 50000 });
  const r2 = await call(createPayoutHandler(failing.deps), { method: 'POST', ...s2, body: { action: 'request', intentId: c2.body.intentId, method: 'PAYSHAP', amountCents: 50000, details, save: true, proof: proof2 } });
  assert.equal(r2.statusCode, 400);
  assert.match(r2.body.line, /Nothing has left your balance/);
  assert.equal(failing.calls.save.length, 0, 'nothing saved when nothing was paid');
});

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

test('send: preview then execute with the proof through sendMoney; the answer never says whether the number is a member', async () => {
  const answers = [];
  for (const delivered of ['BALANCE', 'HELD']) {
    const h = harness({ async sendMoney(args) { const v = verifyPinProof(args.authorization, { accountId: args.sender.id, intentId: args.previewId, amountCents: args.amountCents }); return v.ok ? { ok: true, delivered, amountCents: args.amountCents } : { ok: false, error: 'NOT_AUTHORISED' }; } });
    const s = await signedIn(h);
    const send = createSendHandler(h.deps);
    const p = await call(send, { method: 'POST', ...s, body: { action: 'preview', msisdn: '078 123 4567', amountCents: 5000 } });
    assert.equal(p.statusCode, 200, JSON.stringify(p.body));
    assert.ok(p.body.previewId.startsWith('preview-send-'));
    const proof = await proofVia(h, s, { purpose: 'send', intentId: p.body.previewId, amountCents: 5000 });
    const r = await call(send, { method: 'POST', ...s, body: { action: 'execute', previewId: p.body.previewId, proof } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.delivered, undefined);
    assert.ok(!/BALANCE|HELD|\bmember\b/.test(JSON.stringify(r.body)));
    assert.equal(r.body.lines[1], 'It is in their WaPay balance, or it waits there for them until they join WaPay. No fee.');
    answers.push(r.body);
    assert.ok(h.t.auditLog.some((a) => a.event === 'APP_SEND' && a.metadata.ok === true));
    const again = await call(send, { method: 'POST', ...s, body: { action: 'execute', previewId: p.body.previewId, proof } });
    assert.equal(again.body.replayed, true, 'one execution per preview');
  }
  assert.deepEqual(answers[0], answers[1], 'a member and anyone else: the same answer, word for word');
});

test('send: no proof, a proof for another amount, a frozen sender or a web-reset cool-off: nothing moves', async () => {
  const h = harness();
  const s = await signedIn(h);
  const send = createSendHandler(h.deps);
  const p = await call(send, { method: 'POST', ...s, body: { action: 'preview', msisdn: '0781234567', amountCents: 5000 } });
  for (const proof of [undefined, issuePinProof({ accountId: ACC, intentId: p.body.previewId, amountCents: 5001 })]) {
    const r = await call(send, { method: 'POST', ...s, body: { action: 'execute', previewId: p.body.previewId, proof } });
    assert.equal(r.statusCode, 403);
  }
  assert.equal(h.calls.sendMoney.length, 0);
  assert.equal(h.t.providerRequest.find((x) => x.id === p.body.previewId).status, 'PENDING', 'not even claimed');
  assert.equal((await call(send, { method: 'POST', body: { action: 'execute', previewId: p.body.previewId } })).statusCode, 401);

  h.t.account[0].profile.payouts = { frozen: true };
  const frozen = await call(send, { method: 'POST', ...s, body: { action: 'preview', msisdn: '0781234567', amountCents: 5000 } });
  assert.equal(frozen.statusCode, 423);
  assert.ok(frozen.body.line.startsWith(FROZEN_SEND_COPY.split(' A person')[0]));
  delete h.t.account[0].profile.payouts;

  h.t.account[0].profile.pinReset = { at: new Date().toISOString(), idChecked: false, via: 'app' };
  const cool = await call(send, { method: 'POST', ...s, body: { action: 'preview', msisdn: '0781234567', amountCents: 5000 } });
  assert.equal(cool.statusCode, 423);
  assert.equal(cool.body.error, 'COOL_OFF');
  const self = harness();
  const s2 = await signedIn(self);
  const own = await call(createSendHandler(self.deps), { method: 'POST', ...s2, body: { action: 'preview', msisdn: FIXTURE_CELL, amountCents: 5000 } });
  assert.equal(own.body.error, 'SELF');
});

// ---------------------------------------------------------------------------
// Get paid
// ---------------------------------------------------------------------------

test('get paid: create needs the proof; one intent makes one link; the list and the audit carry the name the customer gave', async () => {
  const h = harness();
  const s = await signedIn(h);
  const links = createLinksHandler(h.deps);
  const prep = await call(links, { method: 'POST', ...s, body: { action: 'prepare', amountCents: 25000 } });
  assert.equal(prep.statusCode, 200);
  assert.ok(prep.body.intentId.startsWith(INTENT_PREFIX.link));
  assert.equal(prep.body.netCardCents, 25000 - prep.body.feeCents);
  const base = { action: 'create', intentId: prep.body.intentId, amountCents: 25000, label: 'Test Payer', note: 'Rent' };
  assert.equal((await call(links, { method: 'POST', body: { ...base } })).statusCode, 401);
  assert.equal((await call(links, { method: 'POST', ...s, body: { ...base } })).statusCode, 403);
  assert.equal((await call(links, { method: 'POST', ...s, body: { ...base, proof: issuePinProof({ accountId: ACC, intentId: prep.body.intentId, amountCents: 25100 }) } })).statusCode, 403);
  assert.equal(h.calls.createPaymentRequest.length, 0);
  const proof = await proofVia(h, s, { purpose: 'link', intentId: prep.body.intentId, amountCents: 25000 });
  // What it is for is required (founder 2026-10-24) and refused in plain words when it could mislead the payer:
  // nothing is claimed or created, and the same proof still makes the link once the words are fixed.
  for (const [note, reason] of [[undefined, 'EMPTY'], ['   ', 'EMPTY'], ['Rent https://evil.example/x', 'LINK'], ['call 082 123 4567', 'NUMBER'], ['WaPay admin fee', 'IMPERSONATION']]) {
    const refused = await call(links, { method: 'POST', ...s, body: { ...base, note, proof } });
    assert.equal(refused.statusCode, 400, String(note));
    assert.equal(refused.body.error, 'DESCRIPTION');
    assert.equal(refused.body.reason, reason, String(note));
    assert.ok(refused.body.line && !/—/.test(refused.body.line), 'a plain line for the screen');
  }
  assert.equal(h.calls.createPaymentRequest.length, 0, 'no link without a description');
  assert.equal(h.t.auditLog.filter((a) => a.event === 'APP_LINK_CREATED' && a.metadata.intentId === prep.body.intentId).length, 0, 'no claim row either');
  const made = await call(links, { method: 'POST', ...s, body: { ...base, proof } });
  assert.equal(made.statusCode, 200, JSON.stringify(made.body));
  assert.match(made.body.link.url, /^https:\/\/pleasepayme\.co\.za\/PR[A-Z]{6}$/);
  assert.equal(made.body.link.note, 'Rent');
  // The share text is the chat's one forwardable card: who asks, the amount, what for, the link, how to pay.
  assert.equal(made.body.shareText, `🙏 *Demo Customer •••919 is asking you to pay R250*\nFor: Rent\n\nPay here: ${made.body.link.url}\nNo fee for you: pay by card, Instant EFT and more, or from a WaPay balance.`);
  const replay = await call(links, { method: 'POST', ...s, body: { ...base, proof } });
  assert.equal(replay.body.link.code, made.body.link.code);
  assert.equal(h.calls.createPaymentRequest.length, 1, 'the same proof never mints a second link');
  const audit = h.t.auditLog.find((a) => a.event === 'APP_LINK_CREATED' && a.metadata.code === made.body.link.code);
  assert.equal(audit.metadata.label, 'Test Payer');
  const list = await call(links, { cookie: s.cookie });
  assert.equal(list.body.links[0].label, 'Test Payer');
  const cancel = await call(links, { method: 'POST', ...s, body: { action: 'cancel', code: made.body.link.code } });
  assert.equal(cancel.statusCode, 200);
});

test('your links (2026-10-24): every link with its status; an open one carries the card to share, the reminder and a WhatsApp link with no number; the page is in the navigation and on home', async () => {
  const h = harness();
  const s = await signedIn(h);
  const r = await call(createLinksHandler(h.deps), { cookie: s.cookie });
  assert.equal(r.statusCode, 200);
  const open = r.body.links.find((l) => l.code === 'PRDEMOEF');
  const paid = r.body.links.find((l) => l.code === 'PRDEMOCD');
  assert.equal(open.status, 'OPEN');
  assert.ok(open.createdAt && open.expiresAt, 'when it was made and when it closes');
  assert.match(open.shareText, /^🙏 \*Demo Customer •••919 is asking you to pay R250\*\n\nPay here: https:\/\/pleasepayme\.co\.za\/PRDEMOEF\n/);
  assert.match(open.reminderText, /^🔔 \*Reminder: Demo Customer •••919 is asking you to pay R250\*\n\nPay here: https:\/\/pleasepayme\.co\.za\/PRDEMOEF\n[^\n]+\nOpen until \d{1,2} [A-Z][a-z]{2}\.$/);
  assert.equal(open.remindUrl, `https://wa.me/?text=${encodeURIComponent(open.reminderText)}`, 'WhatsApp asks the customer who to send it to: WaPay sends nothing');
  assert.equal(paid.status, 'PAID');
  assert.equal(paid.paidBy, 'card');
  assert.equal(paid.note, 'Rent');
  assert.equal(paid.shareText, undefined, 'a paid link has nothing to share or remind');
  assert.match(read('../components/app/Shell.js'), /\{ key: 'links', href: '\/app\/links', label: 'Links', icon: 'link' \}/);
  const page = read('../pages/app/links.js');
  assert.match(page, /await navigator\.share\(\{ text \}\)/, 'the reminder through the share sheet');
  assert.match(page, /href=\{l\.remindUrl\} target="_blank"/, 'or WhatsApp opened with the text ready');
  assert.match(page, /body: \{ action: 'cancel', code: l\.code \}/);
  assert.match(page, /copyText\(l\.url\)/);
  assert.match(read('../pages/app/index.js'), /href="\/app\/links"/);
  assert.match(read('../pages/app/pay.js'), /href="\/app\/links"/);
  assert.match(read('../pages/app/get-paid.js'), /const d = sanitizeLinkDescription\(note\);/, 'what it is for is checked before the PIN step');
});

test("get paid: the open-link cap answers honestly and releases the intent's claim", async () => {
  const h = harness({ async createPaymentRequest() { throw Object.assign(new Error('cap'), { code: 'REQUEST_LIMIT', limit: 'OPEN', openCount: 10 }); } });
  const s = await signedIn(h);
  const intentId = newIntentId('link');
  const proof = await proofVia(h, s, { purpose: 'link', intentId, amountCents: 25000 });
  const r = await call(createLinksHandler(h.deps), { method: 'POST', ...s, body: { action: 'create', intentId, amountCents: 25000, note: 'Rent', proof } });
  assert.equal(r.statusCode, 429);
  assert.match(r.body.line, /10 payment links waiting to be paid/);
  assert.equal(h.t.auditLog.filter((a) => a.event === 'APP_LINK_CREATED' && a.metadata.intentId === intentId).length, 0);
});

// ---------------------------------------------------------------------------
// Reads, top-up, profile
// ---------------------------------------------------------------------------

test('every signed-in read answers 401 before it touches a balance, a journal, a link or the vault', async () => {
  const h = harness();
  const touched = new Set();
  const spy = new Proxy(h.deps.prisma, { get(target, prop) { if (typeof prop === 'string' && !prop.startsWith('$') && prop !== '_tables' && prop !== 'account') touched.add(prop); return target[prop]; } });
  const deps = { ...h.deps, prisma: spy };
  for (const make of [createHomeHandler, createActivityHandler, createPayoutHandler, createLinksHandler, createProfileHandler, createSendHandler, createTopupHandler]) {
    const r = await call(make(deps), { cookie: 'wapay_app=nope' });
    assert.equal(r.statusCode, 401, make.name);
  }
  assert.deepEqual([...touched], []);
});

test('home and activity: balance as spend + cash, sends read the same for members and others, fees as their own line', async () => {
  const h = harness();
  const s = await signedIn(h);
  const t = h.t;
  const add = (source, idemKey, metadata, lines) => {
    const id = `e-${idemKey}`;
    t.journalEntry.push({ id, idemKey, source, metadata, createdAt: new Date() });
    for (const l of lines) t.journalLine.push({ id: `l-${idemKey}-${l.accountCode}`, entryId: id, ...l });
  };
  t.providerRequest.push({ id: 'preview-send-aaa', idemKey: 'preview-send-aaa', route: 'send-preview', status: 'SUCCESS', accountId: ACC, requestTs: new Date(), metadata: { recipientMsisdn: '0781234567' } });
  add('P2P_SEND', 'send-preview-send-aaa', {}, [{ accountCode: `WALLET:${ACC}:SPEND`, debitCents: 5000 }]);
  add('GIFT_HELD', 'gift-held-gift-preview-send-bbb', { recipientMasked: '082•••765' }, [{ accountCode: `WALLET:${ACC}:SPEND`, debitCents: 4000 }]);
  const home = await call(createHomeHandler(h.deps), { cookie: s.cookie });
  assert.equal(home.statusCode, 200);
  assert.equal(home.body.balance.totalCents, home.body.balance.spendCents + home.body.balance.cashCents);
  assert.equal(home.body.recent.length, 5);
  const act = await activityPage(h.deps, t.account[0]);
  const sends = act.items.filter((i) => i.kind === 'SEND');
  assert.equal(sends.length, 2);
  assert.deepEqual(sends.map((x) => x.sub), ['free', 'free'], 'a member and anyone else read the same');
  assert.ok(sends.every((x) => x.title.startsWith('Sent · ')));
  const payout = act.items.find((i) => i.kind === 'PAYOUT');
  assert.equal(payout.amountCents, -284900);
  assert.equal(payout.feeCents, 850);
  assert.ok(!act.items.some((i) => i.kind === 'ADJUSTMENT'), 'the SPEND to CASH step nets to nothing and is left out');
});

test('top-up: the card link comes back to the page the customer is on; another account cannot read the outcome', async () => {
  process.env.PAYFAST_MERCHANT_ID = 'test-merchant';
  process.env.PAYFAST_MERCHANT_KEY = 'test-merchant-key-placeholder';
  try {
    let built = null;
    const h = harness({ buildCheckoutUrl(args) { built = args; return 'https://sandbox.payfast.co.za/eng/process?test=1'; } });
    const s = await signedIn(h);
    const r = await call(createTopupHandler(h.deps), { method: 'POST', ...s, body: { action: 'card', amountCents: 10000 } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(h.calls.deposit[0].accountId, ACC);
    assert.equal(built.amountCents, r.body.grossCents);
    assert.ok(built.returnUrl.startsWith('https://app.wapay.co.za/app/top-up?paid='));
    const mine = await call(createTopupHandler(h.deps), { cookie: s.cookie, query: { paid: r.body.paymentId } });
    assert.equal(mine.body.state, 'WAITING');
    h.t.providerRequest.find((x) => x.id === r.body.paymentId).accountId = 'cotheraccount';
    assert.equal((await call(createTopupHandler(h.deps), { cookie: s.cookie, query: { paid: r.body.paymentId } })).statusCode, 404);
  } finally {
    delete process.env.PAYFAST_MERCHANT_ID;
    delete process.env.PAYFAST_MERCHANT_KEY;
  }
});

test('profile: remove touches only your own destination; change PIN needs the current PIN and keeps you signed in', async () => {
  const h = harness();
  const s = await signedIn(h);
  const profile = createProfileHandler(h.deps);
  h.t.payoutDestination.push({ ...h.t.payoutDestination[0], id: 'cotherdest', accountId: 'cotheraccount' });
  assert.equal((await call(profile, { method: 'POST', ...s, body: { action: 'remove', id: 'cotherdest' } })).statusCode, 404);
  assert.equal(h.t.payoutDestination.length, 2);
  const wrong = await call(profile, { method: 'POST', ...s, body: { action: 'pin', currentPin: '1111', newPin: '4826', newPinAgain: '4826' } });
  assert.equal(wrong.statusCode, 401);
  assert.equal(h.calls.setPIN.length, 0);
  const ok = await call(profile, { method: 'POST', ...s, body: { action: 'pin', currentPin: PIN, newPin: '4826', newPinAgain: '4826' } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(h.calls.setPIN.length, 1);
  const fresh = cookieValue(ok.headers['set-cookie'], 'wapay_app');
  assert.equal((await call(createHomeHandler(h.deps), { cookie: `wapay_app=${fresh}` })).statusCode, 200, 'the new session opens');
  assert.equal((await call(createHomeHandler(h.deps), { cookie: s.cookie })).statusCode, 401, 'the old one does not');
  assert.ok(h.t.auditLog.some((a) => a.event === 'APP_PIN_CHANGE'));
});

// ---------------------------------------------------------------------------
// Copy, config and structure
// ---------------------------------------------------------------------------

test("webLine keeps the chat's rule sentences and drops only the chat's instructions", () => {
  const cap = dailyCapCopy({ capCents: 1000000, usedCents: 900000, remainingCents: 100000, newAccount: true });
  assert.equal(webLine(cap), '⏸ New accounts can pay out up to R10,000 in any 24 hours. You have paid out R9,000 in the last 24 hours, so up to R1,000 more works now. Choose a smaller amount.');
  const frozen = webLine(FROZEN_PAYOUT_COPY);
  assert.ok(frozen.startsWith('⏸ Pay-outs on this account are paused while we check a recent payment. Nothing has left your balance and your money is safe.'));
  assert.ok(!frozen.includes('reply'));
  const off = kycThresholdCopy({ reason: 'DAILY', thresholdCents: 1000000 }, { configured: false });
  assert.ok(webLine(off).endsWith('Choose a smaller amount.'));
});

test('the banner: on by default, off by switch, text overridable; tiles light up by the launch switches', () => {
  assert.equal(bannerFor({}).show, false);
  assert.equal(bannerFor({ WAPAY_APP_WHATSAPP_PAUSED: 'on' }).show, true);
  assert.equal(bannerFor({ WAPAY_APP_BANNER: 'Back <b>soon</b>' }).text, 'Back bsoon/b');
  const keep = { hold: process.env.WAPAY_LAUNCH_HOLD, air: process.env.VAS_LIVE_AIRTIME };
  try {
    delete process.env.WAPAY_LAUNCH_HOLD;
    process.env.VAS_LIVE_AIRTIME = 'true';
    assert.equal(comingSoonTiles({ account: { waId: '27600000919' } }).find((t) => t.id === 'AIRTIME').live, false, 'the launch hold outranks the switch');
    process.env.WAPAY_LAUNCH_HOLD = 'off';
    const air = comingSoonTiles({ account: { waId: '27600000919' } }).find((t) => t.id === 'AIRTIME');
    assert.equal(air.live, true);
    assert.equal(comingSoonTiles({}).find((t) => t.id === 'IN_STORE').live, false);
  } finally {
    if (keep.hold === undefined) delete process.env.WAPAY_LAUNCH_HOLD; else process.env.WAPAY_LAUNCH_HOLD = keep.hold;
    if (keep.air === undefined) delete process.env.VAS_LIVE_AIRTIME; else process.env.VAS_LIVE_AIRTIME = keep.air;
  }
  assert.equal(linkQuote(400).ok, false);
});

test('return links only ever point at our own hosts', () => {
  const req = (host) => ({ headers: { host } });
  assert.equal(appOrigin(req('app.wapay.co.za'), {}), 'https://app.wapay.co.za');
  assert.equal(appOrigin(req('wapay-api.vercel.app'), {}), 'https://wapay-api.vercel.app');
  assert.equal(appOrigin(req('evil.example'), { APP_BASE_URL: 'https://wapay-api.vercel.app/' }), 'https://wapay-api.vercel.app');
  assert.equal(appOrigin(req('localhost:3021'), { NODE_ENV: 'production', APP_BASE_URL: 'https://wapay.co.za' }), 'https://wapay.co.za');
});

test('the Didit session takes the portal return link; the chat keeps its WhatsApp one', async () => {
  const keep = { k: process.env.DIDIT_API_KEY, w: process.env.DIDIT_WORKFLOW_ID, s: process.env.DIDIT_WEBHOOK_SECRET };
  process.env.DIDIT_API_KEY = 'test-api-key';
  process.env.DIDIT_WORKFLOW_ID = 'test-workflow';
  process.env.DIDIT_WEBHOOK_SECRET = 'test-webhook';
  try {
    const { createMemoryPrisma } = await import('../lib/app-dev-fixture.js');
    const prisma = createMemoryPrisma({ account: [{ id: 'acc1', waId: '27600000919', profile: {} }] });
    const bodies = [];
    const fetchFn = async (url, opts) => { bodies.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ session_id: 's1', url: 'https://verify.didit.me/x' }) }; };
    await startKycSession({ prisma, account: { id: 'acc1', waId: '27600000919', profile: {} }, fetchFn, callbackUrl: 'https://app.wapay.co.za/app/pay-out?kyc=done' });
    await startKycSession({ prisma, account: { id: 'acc1', waId: '27600000919', profile: {} }, fetchFn });
    await startKycSession({ prisma, account: { id: 'acc1', waId: '27600000919', profile: {} }, fetchFn, callbackUrl: 'javascript:alert(1)' });
    assert.equal(bodies[0].callback, 'https://app.wapay.co.za/app/pay-out?kyc=done');
    assert.equal(bodies[1].callback, kycReturnUrl());
    assert.equal(bodies[2].callback, kycReturnUrl(), 'only an https link is ever handed to Didit');
  } finally {
    for (const [k, v] of [['DIDIT_API_KEY', keep.k], ['DIDIT_WORKFLOW_ID', keep.w], ['DIDIT_WEBHOOK_SECRET', keep.s]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('the dev fixture can never run in production', () => {
  assert.equal(devFixtureOn({ NODE_ENV: 'development', WAPAY_APP_DEV_FIXTURE: '1' }), true);
  assert.equal(devFixtureOn({ NODE_ENV: 'production', WAPAY_APP_DEV_FIXTURE: '1' }), false);
  assert.equal(devFixtureOn({ NODE_ENV: 'development', WAPAY_APP_DEV_FIXTURE: '1', VERCEL: '1' }), false);
  assert.equal(devFixtureOn({ NODE_ENV: 'development', WAPAY_APP_DEV_FIXTURE: '1', VERCEL_ENV: 'preview' }), false);
  assert.equal(devFixtureOn({ NODE_ENV: 'development' }), false);
  const deps = read('../lib/app-deps.js');
  assert.ok(!/createFixtureDeps\(realAppDeps/.test(deps), 'the fixture is never built on the real dependencies');
  assert.match(read('../lib/app-dev-fixture.js'), /createMemoryPrisma\(seed\(now\)\)/);
});

const PORTAL_FILES = [
  ...['app-auth', 'app-deps', 'app-dev-fixture', 'app-http', 'app-login', 'app-money', 'app-portal'].map((f) => `../lib/${f}.js`),
  ...readdirSync(fileURLToPath(new URL('../pages/api/app/', import.meta.url))).map((f) => `../pages/api/app/${f}`),
  ...readdirSync(fileURLToPath(new URL('../pages/app/', import.meta.url))).map((f) => `../pages/app/${f}`),
  ...readdirSync(fileURLToPath(new URL('../components/app/', import.meta.url))).map((f) => `../components/app/${f}`),
];

test('structure: the proof is checked before the vault, the claim and the money call, in every money action', () => {
  const money = read('../lib/app-money.js');
  const fn = (name) => money.slice(money.indexOf(`export async function ${name}(`), money.indexOf('\nexport ', money.indexOf(`export async function ${name}(`) + 10));
  const payout = fn('payoutRequest');
  assert.ok(payout.indexOf('checkProof(') > 0);
  assert.ok(payout.indexOf('checkProof(') < payout.indexOf('deps.loadPayoutDestinationSecret('), 'proof → vault');
  assert.ok(payout.indexOf('deps.loadPayoutDestinationSecret(') < payout.indexOf('deps.requestPayout('), 'vault → rail');
  assert.match(payout, /authorization: proof/);
  const send = fn('sendExecute');
  assert.ok(send.indexOf('checkProof(') > 0 && send.indexOf('checkProof(') < send.indexOf('providerRequest.updateMany(') && send.indexOf('providerRequest.updateMany(') < send.indexOf('deps.sendMoney('), 'proof → claim → money');
  assert.match(send, /authorization: proof/);
  const link = fn('createLink');
  assert.ok(link.indexOf('checkProof(') > 0 && link.indexOf('checkProof(') < link.indexOf('auditLog.create(') && link.indexOf('auditLog.create(') < link.indexOf('deps.createPaymentRequest('), 'proof → claim → link');
  assert.match(money, /deps\.verifyPinProof\(proof, \{ accountId: account\.id, intentId, amountCents \}\)/);
  assert.match(read('../lib/app-deps.js'), /import \{ verifyPinProof \} from '@wapay\/auth\/pin-proof';/, 'the real verifier in production');
  assert.match(money, /deps\.verifyPIN\(\{ accountId: account\.id, pin, approves: \{ intentId, amountCents \} \}\)/, 'proofs come from verifyPIN');
});

test('structure: no model, no WhatsApp send, no proof minted, no PIN or ID in a log line, no em dash in the copy', () => {
  for (const f of PORTAL_FILES) {
    const src = read(f);
    assert.ok(!/@wapay\/ai|packages\/ai|localize\.js|openai/i.test(src), `${f}: no model`);
    assert.ok(!/@wapay\/whatsapp|sendWhatsApp|notifyCustomer/.test(src), `${f}: no WhatsApp send`);
    assert.ok(!/issuePinProof\(/.test(src), `${f}: only verifyPIN issues a proof`);
    assert.ok(!src.includes('—'), `${f}: no em dash`);
    for (const line of src.split('\n').filter((l) => /console\.(log|error|warn)\(/.test(l))) {
      assert.ok(!/\b(pin|newPin|currentPin|pinAgain|idNumber|proof|token)\b(?![_A-Za-z])/.test(line.replace(/'[^']*'|"[^"]*"/g, "''")), `${f}: a secret in a log line: ${line.trim().slice(0, 80)}`);
    }
  }
  const fixturePin = read('../lib/app-dev-fixture.js');
  assert.match(fixturePin, /FIXTURE_PIN = '2580'/, 'the fixture PIN belongs to an in-memory account only');
});

test('structure: the routes go through the gate first, and the cookie is scoped to the API', () => {
  for (const f of readdirSync(fileURLToPath(new URL('../pages/api/app/', import.meta.url)))) {
    const src = read(`../pages/api/app/${f}`);
    const h = src.slice(src.indexOf('return async function handler'));
    const gateAt = h.search(/await gate\(|requireAppSession\(/);
    assert.ok(gateAt > 0, `${f}: gated`);
    assert.ok(gateAt < h.search(/deps\.prisma|homeView|activityPage|payoutContext|linksOf|profileView|balancesOf/) || h.search(/deps\.prisma|homeView|activityPage|payoutContext|linksOf|profileView|balancesOf/) < 0, `${f}: gate before any read`);
  }
  assert.match(auth.appCookie('x'), /Path=\/api\/app; HttpOnly; Secure; SameSite=Lax; Max-Age=86400/);
  assert.match(read('../next.config.js'), /X-Frame-Options', value: 'DENY'/, 'the PIN pages cannot be framed');
});

test('the app host: unset changes nothing; set, only its bare root goes to /app; the flags readout says what is on', async () => {
  const { appHostDecision } = await import('../lib/app-host.js');
  assert.equal(appHostDecision({ host: 'app.wapay.co.za', pathname: '/', appHost: '' }), 'pass');
  assert.equal(appHostDecision({ host: 'APP.wapay.co.za:443', pathname: '/', appHost: 'app.wapay.co.za' }), 'redirect');
  assert.equal(appHostDecision({ host: 'app.wapay.co.za', pathname: '/business', appHost: 'app.wapay.co.za' }), 'pass');
  assert.equal(appHostDecision({ host: 'app.wapay.co.za.evil.com', pathname: '/', appHost: 'app.wapay.co.za' }), 'pass');
  assert.equal(appHostDecision({ host: 'pleasepayme.co.za', pathname: '/', appHost: 'app.wapay.co.za' }), 'pass');
  const mw = read('../middleware.js');
  assert.ok(mw.indexOf("appHostDecision(") > mw.indexOf("if (admin === 'block' || business === 'block')"), 'the portals keep their gates first');
  assert.match(read('../pages/api/internal/flags.js'), /app: \{ configured: appAuthConfigured\(\), host: /);
});

test('the identity-check link handed to the page is https only', async () => {
  for (const [url, ok] of [['https://verify.didit.me/session/abc', true], ['javascript:alert(1)', false], ['http://verify.example/x', false], ['/app/pay-out?kyc=done', true]]) {
    const h = harness({ async startKycSession() { return { ok: true, url }; } });
    const s = await signedIn(h);
    const r = await call(createProfileHandler(h.deps), { method: 'POST', ...s, body: { action: 'verify' } });
    assert.equal(r.statusCode, ok ? 200 : 502, url);
    if (!ok) assert.equal(r.body.url, undefined);
  }
});

test('no answer ever carries the account row, its PIN hash or its profile', async () => {
  const h = harness();
  h.factor().secretHash = 'argon2-hash-marker';
  const s = await signedIn(h);
  for (const make of [createHomeHandler, createProfileHandler, createPayoutHandler, createLinksHandler, createActivityHandler, createSendHandler, createAuthHandler]) {
    const r = await call(make(h.deps), { cookie: s.cookie });
    assert.equal(r.statusCode, 200, make.name);
    const text = JSON.stringify(r.body);
    assert.ok(!/argon2-hash-marker|authFactors|secretHash|"profile"|onboardingState/.test(text), `${make.name} leaks the account row`);
  }
});

test('the portal domain defaults to app.wapay.co.za, WAPAY_APP_HOST overrides it, and off disables the root redirect', async () => {
  const { configuredAppHost, appHostDecision, DEFAULT_APP_HOST } = await import('../lib/app-host.js');
  assert.equal(DEFAULT_APP_HOST, 'app.wapay.co.za');
  assert.equal(configuredAppHost({}), 'app.wapay.co.za');
  assert.equal(configuredAppHost({ WAPAY_APP_HOST: 'App.Example.co.za ' }), 'app.example.co.za');
  assert.equal(configuredAppHost({ WAPAY_APP_HOST: 'off' }), '');
  assert.equal(appHostDecision({ host: 'app.wapay.co.za', pathname: '/', appHost: configuredAppHost({}) }), 'redirect');
  assert.equal(appHostDecision({ host: 'pleasepayme.co.za', pathname: '/', appHost: configuredAppHost({}) }), 'pass');
  assert.equal(appHostDecision({ host: 'app.wapay.co.za', pathname: '/pay/X', appHost: configuredAppHost({}) }), 'pass');
});

test('an open Didit check is re-read from the decision endpoint when the pay-out screen loads, once a minute, and never when already decided', async () => {
  const { refreshOpenKyc } = await import('../lib/app-money.js');
  const calls = [];
  const verified = { id: 'kyc1', waId: '27830000001', profile: { kyc: { status: 'VERIFIED', sessionId: 's1', fullName: 'Thandi Dlamini' } } };
  const deps = { kycConfigured: () => true, syncKycFromDecision: async (a) => { calls.push(a); return { ok: true, kyc: { status: 'VERIFIED', fullName: 'Thandi Dlamini' } }; }, prisma: { account: { findUnique: async () => verified } } };
  const pending = { id: 'kyc1', waId: '27830000001', profile: { kyc: { status: 'PENDING', sessionId: 's1' } } };
  const NOW = Date.parse('2026-10-21T14:00:00Z');
  const a = await refreshOpenKyc(deps, { account: pending, now: NOW });
  assert.equal(a.profile.kyc.status, 'VERIFIED');
  assert.equal(calls.length, 1); assert.equal(calls[0].sessionId, 's1'); assert.equal(calls[0].accountId, 'kyc1');
  await refreshOpenKyc(deps, { account: pending, now: NOW + 30 * 1000 });
  assert.equal(calls.length, 1, 'throttled to once a minute');
  await refreshOpenKyc(deps, { account: pending, now: NOW + 61 * 1000 });
  assert.equal(calls.length, 2, 'asked again after a minute');
  const done = await refreshOpenKyc(deps, { account: verified, now: NOW + 5 * 60 * 1000 });
  assert.equal(calls.length, 2, 'a decided check is never re-read'); assert.equal(done, verified);
  const noSession = await refreshOpenKyc(deps, { account: { id: 'kyc2', profile: { kyc: { status: 'PENDING' } } }, now: NOW });
  assert.equal(calls.length, 2, 'no session id, nothing to ask'); assert.equal(noSession.profile.kyc.status, 'PENDING');
});
