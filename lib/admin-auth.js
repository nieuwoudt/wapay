/**
 * Admin console authentication — WhatsApp OTP + stateless HMAC sessions.
 *
 * Model (founder ask 2026-08-28: "just an OTP", made honest):
 * - Only msisdns in WAPAY_ADMIN_MSISDNS may log in, and each must already be
 *   an onboarded WaPay account (the OTP is delivered to their own WhatsApp).
 * - OTP: 6 digits, SHA-256 stored (reuses the existing otp_codes table),
 *   10-minute expiry, ONE VERIFY ATTEMPT PER CODE (the code is consumed
 *   before comparison, so a wrong guess burns it), one send per 60s.
 * - Session: stateless signed token `b64(msisdn).exp.hmac` — HMAC-SHA256
 *   with WAPAY_ADMIN_SESSION_SECRET, 12h expiry, delivered as an HttpOnly
 *   SameSite=Strict cookie. Nothing to store or revoke server-side; the
 *   allowlist is re-checked on every request, so removing a number from the
 *   env kills its sessions at the edge.
 * - FAIL CLOSED: no allowlist or no secret (>=16 chars) → every entry point
 *   refuses. The console simply cannot exist until both envs are set.
 *
 * Never log OTP codes or session tokens.
 */

import crypto from 'crypto';
import prisma from './prisma.js';

export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const ADMIN_OTP_TTL_MS = 10 * 60 * 1000;
export const ADMIN_OTP_RESEND_MS = 60 * 1000;
export const ADMIN_COOKIE = 'wapay_admin';

function sessionSecret() {
  const s = process.env.WAPAY_ADMIN_SESSION_SECRET || '';
  return s.length >= 16 ? s : null;
}

/** Last-9-digits normalisation so 27..., 0... and +27 forms all match. */
function tail9(msisdn) {
  const d = String(msisdn || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : null;
}

export function adminAllowlist() {
  return String(process.env.WAPAY_ADMIN_MSISDNS || '')
    .split(',')
    .map((m) => tail9(m))
    .filter(Boolean);
}

export function isAdminMsisdn(msisdn) {
  const t = tail9(msisdn);
  return !!t && adminAllowlist().includes(t);
}

export function adminAuthConfigured() {
  return adminAllowlist().length > 0 && !!sessionSecret();
}

function hashOtp(code) {
  return crypto.createHash('sha256').update(`admin-otp:${code}`).digest('hex');
}

async function adminAccount(prismaClient, msisdn) {
  const t = tail9(msisdn);
  if (!t) return null;
  // Accounts store msisdn in local form and waId in 27-form; match on tail.
  const candidates = await prismaClient.account.findMany({
    where: { OR: [{ msisdn: { endsWith: t } }, { waId: { endsWith: t } }] },
    take: 2,
  });
  return candidates.find((a) => tail9(a.msisdn) === t || tail9(a.waId) === t) || null;
}

/**
 * Request a login code. ALWAYS resolves to a generic {ok:true} — the
 * response must never reveal whether a number is on the allowlist.
 *
 * @param {object} args
 * @param {object} [args.prisma]
 * @param {string} args.msisdn
 * @param {(args: {to: string, text: string}) => Promise<{ok?: boolean}>} args.send
 * @returns {Promise<{ok: true}>}
 */
export async function requestAdminOtp({ prisma: prismaClient = prisma, msisdn, send }) {
  try {
    if (!adminAuthConfigured() || !isAdminMsisdn(msisdn)) return { ok: true };
    const account = await adminAccount(prismaClient, msisdn);
    if (!account) return { ok: true };

    const recent = await prismaClient.otpCode.findFirst({
      where: { accountId: account.id, createdAt: { gt: new Date(Date.now() - ADMIN_OTP_RESEND_MS) } },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) return { ok: true }; // throttled — silently

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await prismaClient.otpCode.create({
      data: {
        accountId: account.id,
        code: hashOtp(code),
        expiresAt: new Date(Date.now() + ADMIN_OTP_TTL_MS),
      },
    });
    await send({
      to: account.waId,
      text: `🔐 WaPay admin code: ${code}\n\nExpires in 10 minutes. One attempt only. Not you? Ignore this message.`,
    });
    return { ok: true };
  } catch (error) {
    console.error(JSON.stringify({ type: 'admin_otp_request_error', error: error?.message }));
    return { ok: true };
  }
}

/**
 * Verify a code and mint a session token. ONE attempt per code: the newest
 * live code is consumed BEFORE comparison, so a wrong guess burns it and the
 * admin must request a fresh one (which is itself throttled to 1/minute).
 *
 * @returns {Promise<{ok: boolean, token?: string}>}
 */
export async function verifyAdminOtp({ prisma: prismaClient = prisma, msisdn, code }) {
  try {
    if (!adminAuthConfigured() || !isAdminMsisdn(msisdn)) return { ok: false };
    if (!/^\d{6}$/.test(String(code || ''))) return { ok: false };
    const account = await adminAccount(prismaClient, msisdn);
    if (!account) return { ok: false };

    const row = await prismaClient.otpCode.findFirst({
      where: { accountId: account.id, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return { ok: false };

    // Consume FIRST — win-the-row semantics also kills concurrent guesses.
    const consumed = await prismaClient.otpCode.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) return { ok: false };

    const expected = Buffer.from(row.code, 'utf8');
    const got = Buffer.from(hashOtp(code), 'utf8');
    if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
      return { ok: false };
    }
    return { ok: true, token: mintAdminToken(tail9(msisdn)) };
  } catch (error) {
    console.error(JSON.stringify({ type: 'admin_otp_verify_error', error: error?.message }));
    return { ok: false };
  }
}

export function mintAdminToken(msisdnTail, ttlMs = ADMIN_SESSION_TTL_MS) {
  const secret = sessionSecret();
  if (!secret) throw new Error('admin session secret not configured');
  const exp = Date.now() + ttlMs;
  const payload = `${msisdnTail}|${exp}`;
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${Buffer.from(msisdnTail).toString('base64url')}.${exp}.${mac}`;
}

export function verifyAdminToken(token) {
  try {
    const secret = sessionSecret();
    if (!secret) return { ok: false };
    const [b64, expStr, mac] = String(token || '').split('.');
    if (!b64 || !expStr || !mac) return { ok: false };
    const msisdnTail = Buffer.from(b64, 'base64url').toString('utf8');
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp < Date.now()) return { ok: false };
    const expect = crypto.createHmac('sha256', secret).update(`${msisdnTail}|${exp}`).digest('hex');
    const a = Buffer.from(expect, 'utf8');
    const b = Buffer.from(String(mac), 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false };
    // Re-check the allowlist on EVERY request: removing a number from the
    // env revokes its live sessions immediately.
    if (!adminAllowlist().includes(msisdnTail)) return { ok: false };
    return { ok: true, msisdn: msisdnTail };
  } catch {
    return { ok: false };
  }
}

export function adminCookie(token) {
  return `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`;
}

export function clearAdminCookie() {
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
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
 * Gate for admin APIs: a valid session cookie OR the internal API key
 * header (the same secret the existing admin repair routes trust).
 * Fails closed on every misconfiguration.
 */
export function requireAdmin(req) {
  const internalKey = process.env.WAPAY_INTERNAL_API_KEY || '';
  const headerKey = req.headers?.['x-internal-api-key'];
  if (internalKey && headerKey && headerKey === internalKey) {
    return { ok: true, via: 'internal-key' };
  }
  const token = readCookie(req, ADMIN_COOKIE);
  const session = verifyAdminToken(token);
  if (session.ok) return { ok: true, via: 'session', msisdn: session.msisdn };
  return { ok: false };
}
