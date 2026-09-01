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

/**
 * Full E.164-ish normalisation to the 27-form (SA). "0731234567",
 * "+27 73 123 4567" and "27731234567" all normalise to "27731234567".
 * The FULL number is the identity — matching on a 9-digit tail let a
 * foreign number colliding in its last 9 digits impersonate an admin
 * (review 2026-08-28, CRITICAL).
 */
export function normSa(msisdn) {
  let d = String(msisdn || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '27' + d.slice(1);
  else if (d.length === 9) d = '27' + d; // bare "731234567"
  // 11-digit 27-form only; anything else is not a SA number we admit.
  return /^27\d{9}$/.test(d) ? d : null;
}

// Admin OTP rows are namespaced so they can never be confused with the
// customer money-flow OTPs that share the otp_codes table (review
// 2026-08-28): customer codes are 6-digit plaintext, admin codes are
// 'adm:' + a 64-hex hash. Admin queries filter on the prefix.
const ADMIN_OTP_PREFIX = 'adm:';
export const ADMIN_OTP_MAX_PER_DAY = 20;
export const ADMIN_OTP_LOCKOUT_BURNS = 5;
export const ADMIN_OTP_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export function adminAllowlist() {
  return String(process.env.WAPAY_ADMIN_MSISDNS || '')
    .split(',')
    .map((m) => normSa(m))
    .filter(Boolean);
}

export function isAdminMsisdn(msisdn) {
  const n = normSa(msisdn);
  return !!n && adminAllowlist().includes(n);
}

export function adminAuthConfigured() {
  return adminAllowlist().length > 0 && !!sessionSecret();
}

function hashOtp(code) {
  return ADMIN_OTP_PREFIX + crypto.createHash('sha256').update(`admin-otp:${code}`).digest('hex');
}

/** 27•••••1175 — enough to confirm the destination without printing it. */
function maskTail(msisdn) {
  const s = String(msisdn || '');
  return s.length > 6 ? `${s.slice(0, 2)}•••••${s.slice(-4)}` : '•••';
}

/**
 * Resolve the admin's account by EXACT full number. The account's waId or
 * msisdn must normalise to the same 27-form as an allowlisted number, and
 * exactly one account may match — otherwise fail closed. This closes the
 * tail-collision impersonation.
 */
async function adminAccount(prismaClient, msisdn) {
  const n = normSa(msisdn);
  if (!n) return null;
  const local = '0' + n.slice(2); // 27xxxxxxxxx → 0xxxxxxxxx
  const candidates = await prismaClient.account.findMany({
    where: { OR: [{ waId: n }, { msisdn: n }, { msisdn: local }, { waId: local }] },
    take: 3,
  });
  const exact = candidates.filter((a) => normSa(a.waId) === n || normSa(a.msisdn) === n);
  return exact.length === 1 ? exact[0] : null; // fail closed on 0 or >1
}

/**
 * Request a login code. ALWAYS resolves to a generic {ok:true} — the
 * response must never reveal whether a number is on the allowlist.
 *
 * DELIVERY (fixed 2026-08-28 after the founder's first login attempt got no
 * code): an admin logs in FROM A COMPUTER, so WhatsApp's 24-hour customer
 * service window is usually CLOSED and a free-form text is undeliverable.
 * We therefore send an APPROVED AUTHENTICATION TEMPLATE first (those deliver
 * outside the window — the same `otp_register_step_2` the onboarding flow
 * has used in production all along), and fall back to free-form text only
 * if the template send fails. If BOTH fail the code row is deleted so the
 * admin can retry immediately instead of waiting out the resend throttle.
 *
 * @param {object} args
 * @param {object} [args.prisma]
 * @param {string} args.msisdn
 * @param {(args: object) => Promise<{ok?: boolean}>} [args.sendTemplate]
 * @param {(args: {to: string, text: string}) => Promise<{ok?: boolean}>} args.send
 * @returns {Promise<{ok: true}>}
 */
export async function requestAdminOtp({ prisma: prismaClient = prisma, msisdn, send, sendTemplate }) {
  try {
    if (!adminAuthConfigured() || !isAdminMsisdn(msisdn)) return { ok: true };
    const account = await adminAccount(prismaClient, msisdn);
    if (!account) return { ok: true };

    // Resend throttle — ADMIN rows only (never counts a customer's OTP).
    const recent = await prismaClient.otpCode.findFirst({
      where: {
        accountId: account.id,
        code: { startsWith: ADMIN_OTP_PREFIX },
        createdAt: { gt: new Date(Date.now() - ADMIN_OTP_RESEND_MS) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) return { ok: true }; // throttled — silently

    // Daily issuance cap — bounds the slow-brute-force code supply.
    const today = await prismaClient.otpCode.count({
      where: {
        accountId: account.id,
        code: { startsWith: ADMIN_OTP_PREFIX },
        createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    if (today >= ADMIN_OTP_MAX_PER_DAY) {
      console.error(JSON.stringify({ type: 'admin_otp_daily_cap', accountId: account.id }));
      return { ok: true };
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const row = await prismaClient.otpCode.create({
      data: {
        accountId: account.id,
        code: hashOtp(code),
        expiresAt: new Date(Date.now() + ADMIN_OTP_TTL_MS),
      },
    });

    // 1) Authentication template — the only thing that crosses a CLOSED 24h
    // window. Templates are approved PER WABA, and our catalogue holds
    // approvals from more than one business account: `otp_register_step_2`
    // is approved on WABA 647978251504290 while we send from
    // 801970852418258, so it fails (#132001) no matter how valid it looks.
    // Rather than hard-code one guess, try each known-approved candidate and
    // keep the first that Meta accepts (2026-08-28, BUGLOG #33).
    const candidates = [
      process.env.WAPAY_TEMPLATE_ADMIN_OTP,
      'otp_register',
      'otp_register_step_2',
    ].filter(Boolean);
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
        diag.tried.push({
          templateName,
          ok: !!attempt?.ok,
          error: attempt?.ok ? undefined : String(attempt?.error || 'unknown').slice(0, 160),
        });
        if (attempt?.ok) {
          sent = attempt;
          diag.templateUsed = templateName;
          diag.templateMessageId = attempt?.data?.messages?.[0]?.id;
          break;
        }
      }
      diag.templateOk = !!sent?.ok;
    }
    // 2) Free-form fallback (works only if the window happens to be open).
    if (!sent?.ok && typeof send === 'function') {
      sent = await send({
        to: account.waId,
        text: `🔐 WaPay admin code: ${code}\n\nExpires in 10 minutes. One attempt only. Not you? Ignore this message.`,
      }).catch((e) => ({ ok: false, error: e?.message || 'threw' }));
      diag.textOk = !!sent?.ok;
      diag.textError = sent?.ok ? undefined : String(sent?.error || 'unknown').slice(0, 200);
      diag.textMessageId = sent?.data?.messages?.[0]?.id;
    }
    if (!sent?.ok) {
      // Undeliverable: drop the code so the admin can retry at once rather
      // than being throttled behind a code that never arrived.
      await prismaClient.otpCode.deleteMany({ where: { id: row.id } }).catch(() => {});
      console.error(JSON.stringify({ type: 'admin_otp_undeliverable', accountId: account.id, diag }));
    }
    // `diag` NEVER contains the code — it is returned only to internal-key
    // callers so a "no code arrived" report can be diagnosed without guessing.
    return { ok: true, diag };
  } catch (error) {
    console.error(JSON.stringify({ type: 'admin_otp_request_error', error: error?.message }));
    return { ok: true };
  }
}

/**
 * Issue an admin login code for delivery INSIDE an open WhatsApp session —
 * i.e. the admin messaged us asking for it, so a free-form reply is always
 * deliverable (2026-08-28, BUGLOG #33: pushing the code out of the blue
 * depends on a per-WABA approved template and silently failed).
 *
 * Returns the plaintext code ONLY to the caller that will immediately send
 * it back to that same admin's own chat. Same allowlist, throttle, daily cap
 * and hashed-at-rest storage as the push path.
 *
 * @returns {Promise<{ok: boolean, code?: string}>}
 */
export async function requestAdminOtpInSession({ prisma: prismaClient = prisma, msisdn }) {
  try {
    if (!adminAuthConfigured() || !isAdminMsisdn(msisdn)) return { ok: false };
    const account = await adminAccount(prismaClient, msisdn);
    if (!account) return { ok: false };

    const recent = await prismaClient.otpCode.findFirst({
      where: {
        accountId: account.id,
        code: { startsWith: ADMIN_OTP_PREFIX },
        createdAt: { gt: new Date(Date.now() - ADMIN_OTP_RESEND_MS) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) return { ok: false }; // throttled

    const today = await prismaClient.otpCode.count({
      where: {
        accountId: account.id,
        code: { startsWith: ADMIN_OTP_PREFIX },
        createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    if (today >= ADMIN_OTP_MAX_PER_DAY) return { ok: false };

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await prismaClient.otpCode.create({
      data: {
        accountId: account.id,
        code: hashOtp(code),
        expiresAt: new Date(Date.now() + ADMIN_OTP_TTL_MS),
      },
    });
    return { ok: true, code };
  } catch (error) {
    console.error(JSON.stringify({ type: 'admin_otp_in_session_error', error: error?.message }));
    return { ok: false };
  }
}

/**
 * PASSWORD sign-in (founder ask 2026-08-30: the WhatsApp code round-trip is
 * fragile — Meta silently drops free-form sends outside the 24h window — and
 * typing a number every time is friction).
 *
 * Model:
 * - The password is NEVER stored in the repo or the database. Vercel holds
 *   ONE argon2id hash in WAPAY_ADMIN_PASSWORD_HASH; this verifies against it.
 *   The hash is self-contained (its own salt, no pepper) so it can be
 *   generated on any machine and pasted straight into the environment.
 * - The number is still the identity: it must be on WAPAY_ADMIN_MSISDNS and
 *   resolve to exactly one account, so a leaked password alone is not enough
 *   to reach the console from an unknown number.
 * - Throttled + locked out per number using the same otp_codes ledger the OTP
 *   path uses (namespaced `pwf:`), so brute force burns into a 15-minute
 *   lockout after 5 failures.
 * - Fails closed: no hash env, no password login. The OTP path stays as the
 *   fallback, so losing the password never locks the founder out.
 *
 * Never log the password, the hash, or the session token.
 */
const ADMIN_PW_FAIL_PREFIX = 'pwf:';
export const ADMIN_PW_LOCKOUT_FAILS = 5;
export const ADMIN_PW_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export function adminPasswordConfigured() {
  return !!(process.env.WAPAY_ADMIN_PASSWORD_HASH || '').trim();
}

/**
 * Shape-check the stored hash WITHOUT revealing it. A pasted hash is easy to
 * mangle: a shell eats the `$` segments unless it is single-quoted, and a
 * truncated copy looks identical to a wrong password at the login screen
 * (both just say "that did not work"). This turns that guessing game into a
 * fact. Returns null when no hash is set. NEVER returns the hash itself.
 */
export function adminPasswordHashShape() {
  const raw = (process.env.WAPAY_ADMIN_PASSWORD_HASH || '').trim();
  if (!raw) return null;
  const m = raw.match(/^\$(argon2(?:id|i|d))\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/);
  return {
    looksValid: !!m,
    algorithm: m ? m[1] : null,
    length: raw.length,
    // The classic mangled-paste signature: an unquoted shell ate the $ parts.
    dollarSegments: (raw.match(/\$/g) || []).length,
  };
}

export async function verifyAdminPassword({ prisma: prismaClient = prisma, msisdn, password }) {
  try {
    if (!adminAuthConfigured() || !adminPasswordConfigured()) return { ok: false, error: 'NOT_CONFIGURED' };
    if (!isAdminMsisdn(msisdn)) return { ok: false, error: 'BAD_CREDENTIALS' };
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
      return { ok: false, error: 'BAD_CREDENTIALS' };
    }
    const account = await adminAccount(prismaClient, msisdn);
    if (!account) return { ok: false, error: 'BAD_CREDENTIALS' };

    // Lockout BEFORE any verification work (also blunts timing probes).
    const fails = await prismaClient.otpCode.count({
      where: {
        accountId: account.id,
        code: { startsWith: ADMIN_PW_FAIL_PREFIX },
        createdAt: { gt: new Date(Date.now() - ADMIN_PW_LOCKOUT_WINDOW_MS) },
      },
    });
    if (fails >= ADMIN_PW_LOCKOUT_FAILS) {
      console.log(JSON.stringify({ type: 'admin_password_locked_out', accountId: account.id }));
      return { ok: false, error: 'LOCKED_OUT' };
    }

    // NOTE: deliberately NOT peppered. An argon2id hash already carries its
    // own random salt, and binding this one to PIN_PEPPER made it
    // environment-coupled — a hash generated anywhere but production could
    // never verify (caught in production verification 2026-08-30). The hash
    // is a self-contained credential that travels with the env var.
    // A malformed hash env is an OPERATOR error, not a wrong password, and
    // the two are indistinguishable at the login screen. Say so loudly in
    // the logs (shape only, never the value) — pasting the password itself
    // into WAPAY_ADMIN_PASSWORD_HASH is the easy mistake to make.
    const shape = adminPasswordHashShape();
    if (!shape?.looksValid) {
      console.error(JSON.stringify({
        type: 'admin_password_hash_malformed',
        hint: 'WAPAY_ADMIN_PASSWORD_HASH must be the $argon2id$... line from scripts/hash-admin-password.mjs, not the password itself',
        looksValid: false,
        length: shape?.length ?? 0,
        dollarSegments: shape?.dollarSegments ?? 0,
      }));
      return { ok: false, error: 'HASH_MALFORMED' };
    }

    const argon2 = (await import('argon2')).default;
    let valid = false;
    try {
      valid = await argon2.verify(process.env.WAPAY_ADMIN_PASSWORD_HASH.trim(), password);
    } catch {
      valid = false; // refuse, never crash open
    }

    if (!valid) {
      // Record the failure (hashed marker only — never the attempt itself).
      await prismaClient.otpCode
        .create({
          data: {
            accountId: account.id,
            code: `${ADMIN_PW_FAIL_PREFIX}${crypto.randomBytes(8).toString('hex')}`,
            expiresAt: new Date(Date.now() + ADMIN_PW_LOCKOUT_WINDOW_MS),
          },
        })
        .catch(() => {});
      console.log(JSON.stringify({ type: 'admin_password_failed', accountId: account.id }));
      return { ok: false, error: 'BAD_CREDENTIALS' };
    }

    console.log(JSON.stringify({ type: 'admin_password_ok', accountId: account.id }));
    return { ok: true, token: mintAdminToken(normSa(msisdn)) };
  } catch (error) {
    console.error(JSON.stringify({ type: 'admin_password_error', error: error?.message }));
    return { ok: false, error: 'BAD_CREDENTIALS' };
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

    // Lockout: too many recently-burned admin codes = someone is guessing.
    const recentBurns = await prismaClient.otpCode.count({
      where: {
        accountId: account.id,
        code: { startsWith: ADMIN_OTP_PREFIX },
        consumedAt: { gt: new Date(Date.now() - ADMIN_OTP_LOCKOUT_WINDOW_MS) },
      },
    });
    if (recentBurns >= ADMIN_OTP_LOCKOUT_BURNS) {
      console.error(JSON.stringify({ type: 'admin_otp_lockout', accountId: account.id }));
      return { ok: false };
    }

    // ADMIN rows only — never consume a customer's live onboarding/PIN OTP.
    const row = await prismaClient.otpCode.findFirst({
      where: {
        accountId: account.id,
        code: { startsWith: ADMIN_OTP_PREFIX },
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
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
    return { ok: true, token: mintAdminToken(normSa(msisdn)) };
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
  // Constant-time compare (hash both sides so unequal lengths don't leak and
  // timingSafeEqual never throws) — matches the OTP/session compares.
  if (internalKey && typeof headerKey === 'string' && headerKey) {
    const a = crypto.createHash('sha256').update(headerKey).digest();
    const b = crypto.createHash('sha256').update(internalKey).digest();
    if (crypto.timingSafeEqual(a, b)) return { ok: true, via: 'internal-key' };
  }
  const token = readCookie(req, ADMIN_COOKIE);
  const session = verifyAdminToken(token);
  if (session.ok) return { ok: true, via: 'session', msisdn: session.msisdn };
  return { ok: false };
}
