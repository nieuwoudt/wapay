/**
 * WaPay personal portal (/app): sign-in, session, CSRF and rate limits (2026-10-21).
 *
 * Why it exists: Meta restricted WaPay's WhatsApp number for 30 days on
 * 2026-10-20, so customers holding balances could not be answered in chat.
 * The portal is the personal twin of WaPay for Business (lib/business-auth.js)
 * and nothing in it depends on WhatsApp: sign-in, PIN reset, pay-outs and
 * receipts all complete on the web.
 *
 * - Sign-in: the WaPay cell number and the customer's own WaPay PIN, checked
 *   ONLY by @wapay/auth verifyPIN (the chat's verifier, with its own lockout:
 *   5 wrong = 15 minutes, 10 wrong = locked until a reset). In front of it the
 *   portal counts its own failures: 5 per number and 5 per IP in 15 minutes,
 *   then a 15-minute lockout (the business portal's constants). The web never
 *   spends the shared counter past APP_WEB_PIN_CEILING, so a stranger who
 *   knows a number cannot push that account into the long lock from here.
 *   Only PIN-shaped input reaches the verifier (constitution #9).
 * - Session: stateless `b64(accountId|sid|pinSetAt).exp.mac`, HMAC-SHA256
 *   under WAPAY_APP_SESSION_SECRET (falls back to the business, then the admin
 *   secret; the payload is domain-separated with `app|`, so no other console's
 *   token opens this one). 24 hours, HttpOnly, Secure, SameSite=Lax, and
 *   scoped to Path=/api/app: the pages never see it. Bound to the PIN's setAt,
 *   so a PIN change or reset anywhere (chat or web) ends every web session.
 * - CSRF: signed double-submit. The token travels in a cookie AND in the
 *   x-wapay-csrf header; they must match and the token must carry our MAC.
 *   Signed in, it is derived from the session id, so a token minted for one
 *   session (or tossed into the jar by another site) opens nothing.
 *   Cross-site requests are refused on Sec-Fetch-Site / Origin first.
 * - Rate limits: rows in processed_messages (prefix `app-rl:`, a nullable
 *   account id, no migration), counted over a window. Every POST is counted
 *   per IP and per account; failures have their own tighter counts.
 * - FAIL CLOSED: without a session secret nothing signs and nothing opens.
 *
 * Never log a PIN, an ID number, a token or a raw IP (IPs and numbers are
 * keyed through an HMAC before they are stored).
 */
import crypto from 'node:crypto';
import { normSa } from './admin-auth.js';

export const APP_COOKIE = 'wapay_app';
export const APP_CSRF_COOKIE = 'wapay_app_csrf';
export const APP_CSRF_HEADER = 'x-wapay-csrf';
export const APP_COOKIE_PATH = '/api/app';
export const APP_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Failed sign-ins: 5 per number and 5 per IP in 15 minutes, then 15 minutes locked. */
export const APP_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const APP_LOGIN_MAX_FAILS = 5;
/** Failed PIN re-entries at a money step: the same 5 per account and per IP. */
export const APP_PIN_MAX_FAILS = 5;
/** The web never takes the shared PIN counter past this (verifyPIN locks for a year at 10). */
export const APP_WEB_PIN_CEILING = 8;
/** Wrong ID numbers in a reset: 3 in 24 hours, shared with the chat's PIN_RESET_ID_FAILED count. */
export const APP_RESET_MAX_FAILS = 3;
export const APP_RESET_WINDOW_MS = 24 * 60 * 60 * 1000;
export const APP_RESET_TOKEN_TTL_MS = 10 * 60 * 1000;
/** Every POST: at most this many per IP and per account in the window. */
export const APP_POST_WINDOW_MS = 15 * 60 * 1000;
export const APP_POST_MAX_PER_IP = 150;
export const APP_POST_MAX_PER_ACCOUNT = 90;

const RL_PREFIX = 'app-rl:';
const PIN_SHAPE = /^\d{4,6}$/;

const log = (type, data = {}) => console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));

// ---------------------------------------------------------------------------
// Secret, MAC, small helpers
// ---------------------------------------------------------------------------

export function appSessionSecret(env = process.env) {
  const s = env.WAPAY_APP_SESSION_SECRET || env.WAPAY_BUSINESS_SESSION_SECRET || env.WAPAY_ADMIN_SESSION_SECRET || '';
  return s.length >= 16 ? s : null;
}

export function appAuthConfigured(env = process.env) {
  return !!appSessionSecret(env);
}

function mac(payload) {
  const secret = appSessionSecret();
  if (!secret) throw new Error('app session secret not configured');
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

const b64u = (s) => Buffer.from(String(s), 'utf8').toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url').toString('utf8');

/** Exactly a 4 to 6 digit PIN; anything else never reaches the verifier (constitution #9). */
export function pinShaped(pin) {
  return typeof pin === 'string' && PIN_SHAPE.test(pin);
}

/** "0831234567", "+27 83 123 4567", "27831234567" → "27831234567", else null. */
export function normCell(raw) {
  return normSa(raw);
}

/** "083•••4567" for the screen; never the middle digits. */
export function maskCell(raw) {
  const n = normSa(raw);
  if (!n) return '';
  const local = `0${n.slice(2)}`;
  return `${local.slice(0, 3)}•••${local.slice(-4)}`;
}

/**
 * A short keyed digest for a number or an IP, so a counter row never holds
 * the raw value. Keyed by the session secret; a bare sha256 when the portal
 * is not configured (then nothing works anyway).
 */
export function keyOf(kind, value) {
  const secret = appSessionSecret();
  const h = secret ? crypto.createHmac('sha256', secret) : crypto.createHash('sha256');
  return h.update(`${kind}|${String(value ?? '')}`).digest('hex').slice(0, 20);
}

/** The caller's network source: Vercel's x-real-ip, else the first hop of x-forwarded-for. */
export function clientIp(req) {
  const real = String(req?.headers?.['x-real-ip'] || '').trim();
  if (real) return real;
  const xff = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req?.socket?.remoteAddress || 'unknown';
}

export function readCookie(req, name) {
  const raw = req?.headers?.cookie || '';
  for (const part of String(raw).split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session token
// ---------------------------------------------------------------------------

const newSid = () => crypto.randomBytes(12).toString('base64url');

/** The PIN's setAt as epoch ms (what a session is bound to), or null. */
export function pinSetAtOf(factor) {
  const t = factor?.setAt ? new Date(factor.setAt).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

export function mintAppToken({ accountId, pinSetAt, sid = newSid(), now = Date.now(), ttlMs = APP_SESSION_TTL_MS } = {}) {
  if (!appSessionSecret()) throw new Error('app session secret not configured');
  if (!accountId || !Number.isFinite(pinSetAt)) throw new Error('accountId and pinSetAt are required');
  const exp = now + ttlMs;
  const subject = `${accountId}|${sid}|${pinSetAt}`;
  return { token: `${b64u(subject)}.${exp}.${mac(`app|${subject}|${exp}`)}`, sid, exp };
}

export function verifyAppToken(token, now = Date.now()) {
  try {
    if (!appSessionSecret()) return { ok: false };
    const [b64, expStr, sig] = String(token || '').split('.');
    if (!b64 || !expStr || !sig) return { ok: false };
    const subject = unb64u(b64);
    const [accountId, sid, pinSetAtStr] = subject.split('|');
    const exp = Number(expStr);
    const pinSetAt = Number(pinSetAtStr);
    if (!accountId || !sid || !Number.isFinite(pinSetAt) || !Number.isFinite(exp) || exp < now) return { ok: false };
    if (!safeEqual(mac(`app|${subject}|${exp}`), sig)) return { ok: false };
    return { ok: true, accountId, sid, pinSetAt, exp };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function appCookie(token) {
  return `${APP_COOKIE}=${token}; Path=${APP_COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(APP_SESSION_TTL_MS / 1000)}`;
}
export function clearAppCookie() {
  return `${APP_COOKIE}=; Path=${APP_COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
export function csrfCookie(token) {
  return `${APP_CSRF_COOKIE}=${token}; Path=${APP_COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(APP_SESSION_TTL_MS / 1000)}`;
}
export function clearCsrfCookie() {
  return `${APP_CSRF_COOKIE}=; Path=${APP_COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// CSRF (signed double-submit)
// ---------------------------------------------------------------------------

/** The token for a signed-in session: derived from the session id, never stored. */
export function csrfForSession(sid) {
  return `s.${mac(`appcsrf|${sid}`)}`;
}

/** A token for the sign-in and reset forms, before there is a session. */
export function mintPreCsrf() {
  const n = crypto.randomBytes(18).toString('base64url');
  return `p.${n}.${mac(`apppre|${n}`)}`;
}

export function preCsrfValid(token) {
  try {
    const [kind, n, m] = String(token || '').split('.');
    return kind === 'p' && !!n && !!m && safeEqual(m, mac(`apppre|${n}`));
  } catch {
    return false;
  }
}

/** Refuse what a browser says came from another site. Same-origin and typed URLs pass. */
export function sameOriginRequest(req) {
  const site = String(req?.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req?.headers?.origin;
  if (!origin) return true;
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim().toLowerCase();
  try {
    return !!host && new URL(String(origin)).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

/**
 * The CSRF check for a POST: same origin, header equal to cookie, and the
 * token ours (bound to the session when there is one).
 */
export function checkCsrf(req, session = null) {
  try {
    if (!appSessionSecret()) return { ok: false, reason: 'NOT_CONFIGURED' };
    if (!sameOriginRequest(req)) return { ok: false, reason: 'CROSS_SITE' };
    const header = req?.headers?.[APP_CSRF_HEADER];
    const cookie = readCookie(req, APP_CSRF_COOKIE);
    if (typeof header !== 'string' || !header || !cookie || !safeEqual(header, cookie)) return { ok: false, reason: 'CSRF' };
    if (session?.sid) return safeEqual(header, csrfForSession(session.sid)) ? { ok: true } : { ok: false, reason: 'CSRF' };
    return preCsrfValid(header) ? { ok: true } : { ok: false, reason: 'CSRF' };
  } catch {
    return { ok: false, reason: 'CSRF' };
  }
}

// ---------------------------------------------------------------------------
// Rate limits (processed_messages rows)
// ---------------------------------------------------------------------------

/**
 * Counter rows in processed_messages: `app-rl:<key>:<random>`. Reads fail
 * open (a counter hiccup must not lock customers out; verifyPIN keeps its own
 * lockout in the database); writes are best-effort.
 */
export function dbLimiter(prisma) {
  return {
    async count(key, windowMs, now = Date.now()) {
      try {
        return await prisma.processedMessage.count({ where: { waMessageId: { startsWith: `${RL_PREFIX}${key}:` }, processedAt: { gt: new Date(now - windowMs) } } });
      } catch (error) {
        log('app_ratelimit_read_failed', { error: error?.message });
        return 0;
      }
    },
    async hit(key, { accountId = null } = {}) {
      await prisma.processedMessage
        .create({ data: { waMessageId: `${RL_PREFIX}${key}:${crypto.randomBytes(6).toString('hex')}`, accountId } })
        .catch((error) => log('app_ratelimit_write_failed', { error: error?.message }));
    },
  };
}

/** The general POST budget: per IP and per account. Counts this request when it passes. */
export async function postBudgetOk(limiter, { ip, accountId = null, now = Date.now() } = {}) {
  const ipKey = `post:ip:${keyOf('ip', ip)}`;
  const accKey = accountId ? `post:a:${accountId}` : null;
  const [byIp, byAccount] = await Promise.all([
    limiter.count(ipKey, APP_POST_WINDOW_MS, now),
    accKey ? limiter.count(accKey, APP_POST_WINDOW_MS, now) : 0,
  ]);
  if (byIp >= APP_POST_MAX_PER_IP || byAccount >= APP_POST_MAX_PER_ACCOUNT) return false;
  await Promise.all([limiter.hit(ipKey), accKey ? limiter.hit(accKey, { accountId }) : null]);
  return true;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** A finished, open WaPay account (PIN set at onboarding; not closed or suspended). */
export function appEligible(account) {
  if (!account) return false;
  const onboarded = account.onboardingState === 'S5_COMPLETED' || account.onboardingStatus === 'COMPLETED';
  const status = account.status == null ? 'ACTIVE' : String(account.status).toUpperCase();
  return onboarded && status === 'ACTIVE';
}

/**
 * The account behind a typed number, by the EXACT full number (both stored
 * forms), with its PIN factor; 0 or several matches, or an unfinished account,
 * is null. Same closure of the tail-collision hole as the business portal.
 */
export async function findAppAccount(prisma, msisdn) {
  const n = normSa(msisdn);
  if (!n) return null;
  const local = `0${n.slice(2)}`;
  const candidates = await prisma.account.findMany({
    where: { OR: [{ waId: n }, { msisdn: n }, { msisdn: local }, { waId: local }] },
    include: { authFactors: { where: { type: 'PIN' } } },
    take: 3,
  });
  const exact = (candidates || []).filter((a) => normSa(a.waId) === n || normSa(a.msisdn) === n);
  if (exact.length !== 1) return null;
  return appEligible(exact[0]) ? exact[0] : null;
}

const pinFactorOf = (account) => (Array.isArray(account?.authFactors) ? account.authFactors.find((f) => f.type === 'PIN') || null : null);

/**
 * Whether the web may ask verifyPIN at all for this account right now:
 * { ok } or { ok:false, error: 'PIN_NOT_SET' | 'PIN_LOCKED' | 'PIN_RESET_NEEDED', lockedUntil }.
 * Reads the shared counter; never compares a PIN.
 */
export function webPinGate(factor, now = Date.now()) {
  if (!factor) return { ok: false, error: 'PIN_NOT_SET' };
  if (Number(factor.attempts || 0) >= APP_WEB_PIN_CEILING) return { ok: false, error: 'PIN_RESET_NEEDED' };
  const until = factor.lockedUntil ? new Date(factor.lockedUntil).getTime() : 0;
  if (until > now) return { ok: false, error: until - now > 60 * 60 * 1000 ? 'PIN_RESET_NEEDED' : 'PIN_LOCKED', lockedUntil: new Date(until).toISOString() };
  return { ok: true };
}

/**
 * Gate for every signed-in route: a valid cookie, the live account, still
 * eligible, and the PIN unchanged since the session began.
 * @returns {Promise<{ ok: boolean, account?: object, sid?: string, factor?: object }>}
 */
export async function requireAppSession(req, { prisma }, now = Date.now()) {
  const v = verifyAppToken(readCookie(req, APP_COOKIE), now);
  if (!v.ok) return { ok: false };
  const account = await prisma.account.findUnique({ where: { id: v.accountId }, include: { authFactors: { where: { type: 'PIN' } } } });
  if (!appEligible(account)) return { ok: false };
  const factor = pinFactorOf(account);
  if (!factor || pinSetAtOf(factor) !== v.pinSetAt) return { ok: false };
  return { ok: true, account, sid: v.sid, factor };
}

export { pinFactorOf };

// ---------------------------------------------------------------------------
// PIN reset by the ID number on file
// ---------------------------------------------------------------------------

const normId = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * The typed ID or passport number against the one on file: the last three
 * characters first, then the whole number through a keyed digest compared in
 * constant time. Pure.
 */
export function idNumberMatches(typed, onFile) {
  const a = normId(typed);
  const b = normId(onFile);
  if (a.length < 6 || b.length < 6) return false;
  if (a.slice(-3) !== b.slice(-3)) return false;
  const k = crypto.createHash('sha256').update(`wapay-app-id-check:${appSessionSecret() || ''}`).digest();
  const da = crypto.createHmac('sha256', k).update(a).digest();
  const db = crypto.createHmac('sha256', k).update(b).digest();
  return crypto.timingSafeEqual(da, db);
}

/** Short-lived proof that the ID check passed, bound to the PIN as it was then (single use). */
export function mintResetToken({ accountId, pinSetAt, now = Date.now(), ttlMs = APP_RESET_TOKEN_TTL_MS } = {}) {
  if (!appSessionSecret()) throw new Error('app session secret not configured');
  if (!accountId || !Number.isFinite(pinSetAt)) throw new Error('accountId and pinSetAt are required');
  const exp = now + ttlMs;
  const subject = `${accountId}|${pinSetAt}|${crypto.randomBytes(9).toString('base64url')}`;
  return `${b64u(subject)}.${exp}.${mac(`appreset|${subject}|${exp}`)}`;
}

export function verifyResetToken(token, now = Date.now()) {
  try {
    if (!appSessionSecret()) return { ok: false };
    const [b64, expStr, sig] = String(token || '').split('.');
    if (!b64 || !expStr || !sig) return { ok: false };
    const subject = unb64u(b64);
    const [accountId, pinSetAtStr] = subject.split('|');
    const exp = Number(expStr);
    const pinSetAt = Number(pinSetAtStr);
    if (!accountId || !Number.isFinite(pinSetAt) || !Number.isFinite(exp) || exp < now) return { ok: false };
    if (!safeEqual(mac(`appreset|${subject}|${exp}`), sig)) return { ok: false };
    return { ok: true, accountId, pinSetAt };
  } catch {
    return { ok: false };
  }
}
