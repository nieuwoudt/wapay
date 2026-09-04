/**
 * WaPay for Business — portal authentication (2026-09-04).
 *
 * The same honest model as the admin console (lib/admin-auth.js), keyed on
 * the OWNER's WaPay account instead of an env allowlist:
 * - The owner's WhatsApp number must already be an onboarded WaPay account:
 *   the business's money lands in that account's SPEND wallet, so the wallet
 *   IS the business identity. No wallet, no business.
 * - OTP: 6 digits, SHA-256 at rest in the shared otp_codes table, namespaced
 *   `biz:` so it can never collide with a customer's onboarding/PIN code or
 *   an admin `adm:` code. 10-minute expiry, ONE verify attempt per code,
 *   1 send / 60s, 20 / day, lockout after 5 burns in 15 minutes.
 *   Delivery: approved AUTHENTICATION template first (crosses the 24h
 *   window), free-form fallback; or issued IN-SESSION when the owner types
 *   "business login" to WaPay from their phone (BUGLOG #33 lesson).
 * - Password (optional, per business): self-contained argon2id hash in
 *   businesses.passwordHash — the number stays the identity, 5 failures =
 *   15-minute lockout, wrong-number and wrong-password answer identically.
 * - Session: stateless `b64(businessId|accountId).exp.hmac`, HMAC-SHA256 with
 *   WAPAY_BUSINESS_SESSION_SECRET (falls back to WAPAY_ADMIN_SESSION_SECRET;
 *   payload is domain-separated with a `biz|` prefix so a token from one
 *   console can never open the other), 24h, HttpOnly/Secure/SameSite=Strict.
 * - Registration: passing the OTP for a number WITHOUT a business yields a
 *   short-lived REGISTRATION token (15 min) that the register action must
 *   present — the business name is never accepted on an unverified number.
 *   WAPAY_BUSINESS_MSISDNS (optional) restricts who may REGISTER during the
 *   pilot; existing businesses always keep signing in.
 * - FAIL CLOSED: no session secret → nothing works.
 *
 * Never log OTP codes, passwords, hashes or session tokens.
 */

import crypto from 'crypto';
import prisma from './prisma.js';
import { normSa } from './admin-auth.js';

export const BUSINESS_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const BUSINESS_OTP_TTL_MS = 10 * 60 * 1000;
export const BUSINESS_OTP_RESEND_MS = 60 * 1000;
export const BUSINESS_OTP_MAX_PER_DAY = 20;
export const BUSINESS_OTP_LOCKOUT_BURNS = 5;
export const BUSINESS_OTP_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const BUSINESS_PW_LOCKOUT_FAILS = 5;
export const BUSINESS_PW_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const BUSINESS_REGISTRATION_TTL_MS = 15 * 60 * 1000;
export const BUSINESS_COOKIE = 'wapay_biz';
export const BUSINESS_PASSWORD_MIN = 10;

const OTP_PREFIX = 'biz:';
const PW_FAIL_PREFIX = 'bpf:';

function sessionSecret() {
  const s = process.env.WAPAY_BUSINESS_SESSION_SECRET || process.env.WAPAY_ADMIN_SESSION_SECRET || '';
  return s.length >= 16 ? s : null;
}

export function businessAuthConfigured() {
  return !!sessionSecret();
}

/** Optional pilot allowlist for REGISTRATION only (27-form). Empty = open. */
export function businessSignupAllowlist() {
  return String(process.env.WAPAY_BUSINESS_MSISDNS || '')
    .split(',')
    .map((m) => normSa(m))
    .filter(Boolean);
}

export function mayRegister(msisdn) {
  const list = businessSignupAllowlist();
  if (!list.length) return true;
  const n = normSa(msisdn);
  return !!n && list.includes(n);
}

function hashOtp(code) {
  return OTP_PREFIX + crypto.createHash('sha256').update(`business-otp:${code}`).digest('hex');
}

function maskTail(msisdn) {
  const s = String(msisdn || '');
  return s.length > 6 ? `${s.slice(0, 2)}•••••${s.slice(-4)}` : '•••';
}

/**
 * Resolve the owner's account by EXACT full number (0 or >1 matches = null).
 * Same closure of the tail-collision hole as the admin console.
 */
export async function ownerAccount(prismaClient, msisdn) {
  const n = normSa(msisdn);
  if (!n) return null;
  const local = '0' + n.slice(2);
  const candidates = await prismaClient.account.findMany({
    where: { OR: [{ waId: n }, { msisdn: n }, { msisdn: local }, { waId: local }] },
    take: 3,
  });
  const exact = candidates.filter((a) => normSa(a.waId) === n || normSa(a.msisdn) === n);
  return exact.length === 1 ? exact[0] : null;
}

async function throttledOrCapped(prismaClient, accountId) {
  const recent = await prismaClient.otpCode.findFirst({
    where: {
      accountId,
      code: { startsWith: OTP_PREFIX },
      createdAt: { gt: new Date(Date.now() - BUSINESS_OTP_RESEND_MS) },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (recent) return 'THROTTLED';
  const today = await prismaClient.otpCode.count({
    where: {
      accountId,
      code: { startsWith: OTP_PREFIX },
      createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  });
  if (today >= BUSINESS_OTP_MAX_PER_DAY) return 'CAPPED';
  return null;
}

/**
 * Request a sign-in / registration code. ALWAYS resolves to a generic
 * {ok:true}: the response must never reveal whether a number has a WaPay
 * wallet or a business (membership-neutral — the enumeration rule).
 *
 * @param {object} args
 * @param {object} [args.prisma]
 * @param {string} args.msisdn
 * @param {(a: object) => Promise<{ok?: boolean}>} [args.sendTemplate]
 * @param {(a: {to: string, text: string}) => Promise<{ok?: boolean}>} [args.send]
 */
export async function requestBusinessOtp({ prisma: prismaClient = prisma, msisdn, send, sendTemplate }) {
  try {
    if (!businessAuthConfigured()) return { ok: true };
    const account = await ownerAccount(prismaClient, msisdn);
    if (!account) return { ok: true };
    const blocked = await throttledOrCapped(prismaClient, account.id);
    if (blocked) return { ok: true };

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const row = await prismaClient.otpCode.create({
      data: { accountId: account.id, code: hashOtp(code), expiresAt: new Date(Date.now() + BUSINESS_OTP_TTL_MS) },
    });

    // Authentication template first — the only thing that crosses a closed
    // 24h window (the owner signs in from a computer). Same candidate list
    // as the admin console: approvals are per-WABA (BUGLOG #33).
    const candidates = [process.env.WAPAY_TEMPLATE_BUSINESS_OTP, process.env.WAPAY_TEMPLATE_ADMIN_OTP, 'otp_register', 'otp_register_step_2'].filter(Boolean);
    const diag = { to: maskTail(account.waId), tried: [] };
    let sent = null;
    if (typeof sendTemplate === 'function') {
      for (const templateName of candidates) {
        // eslint-disable-next-line no-await-in-loop
        const attempt = await sendTemplate({
          to: account.waId,
          templateName,
          language: 'en',
          components: [{ type: 'body', parameters: [{ type: 'text', text: code }] }],
        }).catch((e) => ({ ok: false, error: e?.message || 'threw' }));
        diag.tried.push({ templateName, ok: !!attempt?.ok, error: attempt?.ok ? undefined : String(attempt?.error || 'unknown').slice(0, 160) });
        if (attempt?.ok) { sent = attempt; diag.templateUsed = templateName; break; }
      }
      diag.templateOk = !!sent?.ok;
    }
    if (!sent?.ok && typeof send === 'function') {
      sent = await send({
        to: account.waId,
        text: `🔐 WaPay for Business code: ${code}\n\nExpires in 10 minutes. One attempt only. Not you? Ignore this message.`,
      }).catch((e) => ({ ok: false, error: e?.message || 'threw' }));
      diag.textOk = !!sent?.ok;
      diag.textError = sent?.ok ? undefined : String(sent?.error || 'unknown').slice(0, 200);
    }
    if (!sent?.ok) {
      await prismaClient.otpCode.deleteMany({ where: { id: row.id } }).catch(() => {});
      console.error(JSON.stringify({ type: 'business_otp_undeliverable', accountId: account.id, diag }));
    }
    return { ok: true, diag };
  } catch (error) {
    console.error(JSON.stringify({ type: 'business_otp_request_error', error: error?.message }));
    return { ok: true };
  }
}

/**
 * Issue a code for delivery INSIDE an open WhatsApp session — the owner
 * typed "business login" to WaPay, so a free-form reply always delivers.
 * Returns the plaintext code ONLY to the caller that sends it straight back
 * to that same owner's chat. Refuses (silently) for numbers that are not a
 * business AND may not register, so the command's existence leaks nothing.
 *
 * @returns {Promise<{ok: boolean, code?: string, hasBusiness?: boolean}>}
 */
export async function requestBusinessOtpInSession({ prisma: prismaClient = prisma, msisdn }) {
  try {
    if (!businessAuthConfigured()) return { ok: false };
    const account = await ownerAccount(prismaClient, msisdn);
    if (!account) return { ok: false };
    const business = await prismaClient.business.findUnique({ where: { accountId: account.id } });
    if (!business && !mayRegister(msisdn)) return { ok: false };
    const blocked = await throttledOrCapped(prismaClient, account.id);
    if (blocked) return { ok: false };
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await prismaClient.otpCode.create({
      data: { accountId: account.id, code: hashOtp(code), expiresAt: new Date(Date.now() + BUSINESS_OTP_TTL_MS) },
    });
    return { ok: true, code, hasBusiness: !!business };
  } catch (error) {
    console.error(JSON.stringify({ type: 'business_otp_in_session_error', error: error?.message }));
    return { ok: false };
  }
}

/**
 * Verify a code. ONE attempt per code (consumed before comparison).
 * Success yields EITHER a session token (the number already owns a business)
 * OR a registration token (it may create one).
 *
 * @returns {Promise<{ok: boolean, token?: string, registrationToken?: string, business?: object}>}
 */
export async function verifyBusinessOtp({ prisma: prismaClient = prisma, msisdn, code }) {
  try {
    if (!businessAuthConfigured()) return { ok: false };
    if (!/^\d{6}$/.test(String(code || ''))) return { ok: false };
    const account = await ownerAccount(prismaClient, msisdn);
    if (!account) return { ok: false };

    const recentBurns = await prismaClient.otpCode.count({
      where: { accountId: account.id, code: { startsWith: OTP_PREFIX }, consumedAt: { gt: new Date(Date.now() - BUSINESS_OTP_LOCKOUT_WINDOW_MS) } },
    });
    if (recentBurns >= BUSINESS_OTP_LOCKOUT_BURNS) {
      console.error(JSON.stringify({ type: 'business_otp_lockout', accountId: account.id }));
      return { ok: false };
    }

    const row = await prismaClient.otpCode.findFirst({
      where: { accountId: account.id, code: { startsWith: OTP_PREFIX }, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return { ok: false };
    const consumed = await prismaClient.otpCode.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (consumed.count !== 1) return { ok: false };

    const expected = Buffer.from(row.code, 'utf8');
    const got = Buffer.from(hashOtp(code), 'utf8');
    if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return { ok: false };

    const business = await prismaClient.business.findUnique({ where: { accountId: account.id } });
    if (business) {
      if (business.status !== 'ACTIVE') return { ok: false };
      return { ok: true, token: mintBusinessToken({ businessId: business.id, accountId: account.id }), business };
    }
    if (!mayRegister(msisdn)) return { ok: false };
    return { ok: true, registrationToken: mintRegistrationToken(account.id) };
  } catch (error) {
    console.error(JSON.stringify({ type: 'business_otp_verify_error', error: error?.message }));
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

export function passwordAcceptable(password) {
  return typeof password === 'string' && password.length >= BUSINESS_PASSWORD_MIN && password.length <= 200;
}

/** Self-contained argon2id hash (no pepper — see the admin-console lesson). */
export async function hashBusinessPassword(password) {
  if (!passwordAcceptable(password)) throw new Error(`password must be ${BUSINESS_PASSWORD_MIN}-200 characters`);
  const argon2 = (await import('argon2')).default;
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
}

export async function verifyBusinessPassword({ prisma: prismaClient = prisma, msisdn, password }) {
  try {
    if (!businessAuthConfigured()) return { ok: false, error: 'NOT_CONFIGURED' };
    if (!passwordAcceptable(password)) return { ok: false, error: 'BAD_CREDENTIALS' };
    const account = await ownerAccount(prismaClient, msisdn);
    if (!account) return { ok: false, error: 'BAD_CREDENTIALS' };

    const fails = await prismaClient.otpCode.count({
      where: { accountId: account.id, code: { startsWith: PW_FAIL_PREFIX }, createdAt: { gt: new Date(Date.now() - BUSINESS_PW_LOCKOUT_WINDOW_MS) } },
    });
    if (fails >= BUSINESS_PW_LOCKOUT_FAILS) return { ok: false, error: 'LOCKED_OUT' };

    const business = await prismaClient.business.findUnique({ where: { accountId: account.id } });
    let valid = false;
    if (business?.passwordHash && business.status === 'ACTIVE') {
      try {
        const argon2 = (await import('argon2')).default;
        valid = await argon2.verify(business.passwordHash, password);
      } catch {
        valid = false;
      }
    }
    if (!valid) {
      await prismaClient.otpCode
        .create({
          data: {
            accountId: account.id,
            code: `${PW_FAIL_PREFIX}${crypto.randomBytes(8).toString('hex')}`,
            expiresAt: new Date(Date.now() + BUSINESS_PW_LOCKOUT_WINDOW_MS),
          },
        })
        .catch(() => {});
      return { ok: false, error: 'BAD_CREDENTIALS' };
    }
    return { ok: true, token: mintBusinessToken({ businessId: business.id, accountId: account.id }), business };
  } catch (error) {
    console.error(JSON.stringify({ type: 'business_password_error', error: error?.message }));
    return { ok: false, error: 'BAD_CREDENTIALS' };
  }
}

// ---------------------------------------------------------------------------
// Tokens & cookie
// ---------------------------------------------------------------------------

function mac(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function mintBusinessToken({ businessId, accountId }, ttlMs = BUSINESS_SESSION_TTL_MS) {
  if (!sessionSecret()) throw new Error('business session secret not configured');
  if (!businessId || !accountId) throw new Error('businessId and accountId are required');
  const exp = Date.now() + ttlMs;
  const subject = `${businessId}|${accountId}`;
  return `${Buffer.from(subject).toString('base64url')}.${exp}.${mac(`biz|${subject}|${exp}`)}`;
}

export function verifyBusinessToken(token) {
  try {
    if (!sessionSecret()) return { ok: false };
    const [b64, expStr, sig] = String(token || '').split('.');
    if (!b64 || !expStr || !sig) return { ok: false };
    const subject = Buffer.from(b64, 'base64url').toString('utf8');
    const [businessId, accountId] = subject.split('|');
    if (!businessId || !accountId) return { ok: false };
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp < Date.now()) return { ok: false };
    if (!safeEqualHex(mac(`biz|${subject}|${exp}`), sig)) return { ok: false };
    return { ok: true, businessId, accountId };
  } catch {
    return { ok: false };
  }
}

export function mintRegistrationToken(accountId, ttlMs = BUSINESS_REGISTRATION_TTL_MS) {
  if (!sessionSecret()) throw new Error('business session secret not configured');
  const exp = Date.now() + ttlMs;
  return `${Buffer.from(accountId).toString('base64url')}.${exp}.${mac(`bizreg|${accountId}|${exp}`)}`;
}

export function verifyRegistrationToken(token) {
  try {
    if (!sessionSecret()) return { ok: false };
    const [b64, expStr, sig] = String(token || '').split('.');
    if (!b64 || !expStr || !sig) return { ok: false };
    const accountId = Buffer.from(b64, 'base64url').toString('utf8');
    const exp = Number(expStr);
    if (!accountId || !Number.isFinite(exp) || exp < Date.now()) return { ok: false };
    if (!safeEqualHex(mac(`bizreg|${accountId}|${exp}`), sig)) return { ok: false };
    return { ok: true, accountId };
  } catch {
    return { ok: false };
  }
}

export function businessCookie(token) {
  return `${BUSINESS_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(BUSINESS_SESSION_TTL_MS / 1000)}`;
}

export function clearBusinessCookie() {
  return `${BUSINESS_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function readCookie(req, name) {
  const raw = req.headers?.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/**
 * Gate for business APIs: a valid session cookie, OR the internal API key
 * together with an explicit `x-wapay-business-id` header (scripts, repair).
 * Pure/sync — the route then loads the business row (see requireBusinessContext).
 */
export function requireBusiness(req) {
  const internalKey = process.env.WAPAY_INTERNAL_API_KEY || '';
  const headerKey = req.headers?.['x-internal-api-key'];
  const headerBiz = req.headers?.['x-wapay-business-id'];
  if (internalKey && typeof headerKey === 'string' && headerKey && typeof headerBiz === 'string' && headerBiz) {
    const a = crypto.createHash('sha256').update(headerKey).digest();
    const b = crypto.createHash('sha256').update(internalKey).digest();
    if (crypto.timingSafeEqual(a, b)) return { ok: true, via: 'internal-key', businessId: headerBiz, accountId: null };
  }
  const session = verifyBusinessToken(readCookie(req, BUSINESS_COOKIE));
  if (session.ok) return { ok: true, via: 'session', businessId: session.businessId, accountId: session.accountId };
  return { ok: false };
}

/**
 * requireBusiness + the live business row. A suspended or deleted business
 * fails closed even with a valid cookie. Use this in every business route
 * BEFORE any other DB access.
 */
export async function requireBusinessContext(req, prismaClient = prisma) {
  const gate = requireBusiness(req);
  if (!gate.ok) return { ok: false };
  const business = await prismaClient.business.findUnique({ where: { id: gate.businessId } });
  if (!business || business.status !== 'ACTIVE') return { ok: false };
  if (gate.accountId && business.accountId !== gate.accountId) return { ok: false };
  return { ok: true, via: gate.via, business };
}
