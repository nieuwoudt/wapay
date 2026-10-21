/**
 * The personal portal's sign-in and PIN reset (2026-10-21). Primitives live
 * in lib/app-auth.js; this file is the order of the checks.
 *
 * Sign-in: the number's shape and the PIN's shape (a malformed PIN never
 * reaches the verifier, constitution #9) → this number's and this IP's
 * failures in the last 15 minutes (5 each, then locked) → the account, by
 * the exact full number → the web ceiling on the shared PIN counter → verifyPIN.
 * A number that is not a WaPay account answers exactly like a wrong PIN, after
 * the same argon2 work, so the form cannot be used to find out who is on WaPay.
 *
 * Reset (no WhatsApp: the chat's code cannot be delivered while the number is
 * restricted): the ID or passport number given for withdrawals, held encrypted
 * in the vault, compared on its last characters and then in full through a
 * keyed digest; three wrong numbers in 24 hours pause resets (the count is
 * shared with the chat's PIN_RESET_ID_FAILED rows). A number with no ID on
 * file, an unknown number and a wrong ID number all get the same answer, which
 * names the support e-mail. The KYC record keeps only a masked number by
 * design (POPIA), so it cannot prove an ID and is not used here.
 * After the reset the chat's cool-off applies (lib/pin-reset.js
 * pinResetCoolOff): the web reset proves the ID but not the phone, so for
 * WAPAY_PIN_RESET_COOLOFF_HOURS pay-outs go only to saved destinations, and on
 * the web sends to another person wait as well.
 */
import crypto from 'node:crypto';
import {
  findAppAccount, pinFactorOf, pinSetAtOf, webPinGate, pinShaped, normCell, keyOf, idNumberMatches, mintAppToken, mintResetToken,
  verifyResetToken, APP_LOGIN_MAX_FAILS, APP_LOCKOUT_WINDOW_MS, APP_RESET_MAX_FAILS, APP_RESET_WINDOW_MS, appEligible,
} from './app-auth.js';
import { supportEmail } from './app-portal.js';
import { COOLOFF_HOURS } from './pin-reset.js';

const log = (type, data = {}) => console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));

let dummyHashPromise = null;
/** A real argon2id hash of a random secret, made once: the work an unknown number costs, so timing tells nothing. */
function dummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = import('argon2').then(({ default: argon2 }) => argon2.hash(crypto.randomBytes(24).toString('hex'), { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 }));
  }
  return dummyHashPromise;
}
async function spendLikeAVerify(pin) {
  try {
    const argon2 = (await import('argon2')).default;
    await argon2.verify(await dummyHash(), String(pin));
  } catch {
    /* timing only */
  }
}

export const LOGIN_FAILED_LINE = 'That cell number and PIN do not match a WaPay account. Check both and try again, or reset your PIN with your ID number.';
export const LOGIN_LOCKED_LINE = 'Too many tries. For your safety, logging in is paused for 15 minutes. You can reset your PIN with your ID number instead of waiting.';

/**
 * @returns {Promise<{ ok: boolean, status: number, error?: string, line?: string, token?: string, sid?: string, account?: object }>}
 */
export async function appLogin(deps, { msisdn, pin, ip, slowWork = deps.slowWork || spendLikeAVerify }) {
  const n = normCell(msisdn);
  if (!n) return { ok: false, status: 400, error: 'BAD_NUMBER', line: 'Type your WaPay cell number, like 083 123 4567.' };
  if (!pinShaped(pin)) return { ok: false, status: 400, error: 'BAD_PIN', line: 'Your WaPay PIN is 4 to 6 digits.' };
  const numKey = `lf:n:${keyOf('cell', n)}`;
  const ipKey = `lf:ip:${keyOf('ip', ip)}`;
  const [byNumber, byIp] = await Promise.all([deps.limiter.count(numKey, APP_LOCKOUT_WINDOW_MS), deps.limiter.count(ipKey, APP_LOCKOUT_WINDOW_MS)]);
  if (byNumber >= APP_LOGIN_MAX_FAILS || byIp >= APP_LOGIN_MAX_FAILS) return { ok: false, status: 429, error: 'LOCKED', line: LOGIN_LOCKED_LINE };
  const failed = async (account = null, reason = 'WRONG') => {
    await Promise.all([deps.limiter.hit(numKey, { accountId: account?.id || null }), deps.limiter.hit(ipKey)]);
    if (account) await deps.prisma.auditLog.create({ data: { accountId: account.id, event: 'APP_LOGIN', metadata: { ok: false, reason } } }).catch(() => {});
    return { ok: false, status: 401, error: 'BAD_CREDENTIALS', line: LOGIN_FAILED_LINE };
  };
  const account = await findAppAccount(deps.prisma, n);
  const factor = pinFactorOf(account);
  if (!account || !factor) {
    await slowWork(pin);
    return failed(account, account ? 'NO_PIN' : 'UNKNOWN');
  }
  const gate = webPinGate(factor, deps.now());
  if (!gate.ok) {
    return gate.error === 'PIN_LOCKED'
      ? { ok: false, status: 423, error: 'PIN_LOCKED', lockedUntil: gate.lockedUntil, line: 'Your PIN is locked for 15 minutes after 5 wrong tries. Reset it with your ID number now instead of waiting.' }
      : { ok: false, status: 423, error: 'PIN_RESET_NEEDED', line: 'Your PIN is locked after too many wrong tries. Reset it with your ID number to log in.' };
  }
  const out = await deps.verifyPIN({ accountId: account.id, pin });
  if (!out?.ok) {
    if (out?.error === 'SOFT_LOCKOUT') return { ok: false, status: 423, error: 'PIN_LOCKED', line: 'Your PIN is locked for 15 minutes after 5 wrong tries. Reset it with your ID number now instead of waiting.' };
    if (out?.error === 'HARD_LOCKOUT') return { ok: false, status: 423, error: 'PIN_RESET_NEEDED', line: 'Your PIN is locked after too many wrong tries. Reset it with your ID number to log in.' };
    if (out?.error === 'INVALID_PIN') return failed(account, 'WRONG_PIN');
    log('app_login_verify_error', { accountId: account.id });
    return { ok: false, status: 503, error: 'TRY_AGAIN', line: 'Logging in is not working right now. Please try again in a minute.' };
  }
  // verifyPIN's success path does not change setAt, so the factor read above still binds the session.
  const { token, sid } = mintAppToken({ accountId: account.id, pinSetAt: pinSetAtOf(factor), now: deps.now() });
  await deps.prisma.auditLog.create({ data: { accountId: account.id, event: 'APP_LOGIN', metadata: { ok: true, ipKey: keyOf('ip', ip) } } }).catch(() => {});
  return { ok: true, status: 200, token, sid, account };
}

const resetPausedLine = () => `For your safety, PIN reset is paused for 24 hours after too many wrong ID numbers, so your PIN is unchanged. If you need it sooner, e-mail ${supportEmail()}.`;
const noMatchLine = () => `We could not match that ID number to this cell number, so your PIN is unchanged. Type the whole ID or passport number you gave WaPay for pay-outs. If you never gave one, the PIN cannot be reset here: e-mail ${supportEmail()} from any address with your cell number.`;

async function idFailures(deps, accountId) {
  return deps.prisma.auditLog.count({ where: { accountId, event: 'PIN_RESET_ID_FAILED', timestamp: { gte: new Date(deps.now() - APP_RESET_WINDOW_MS) } } });
}

/**
 * Step 1 of the reset: the cell number and the ID number on file. On a match,
 * a 10-minute token bound to the PIN as it is now (so it works once).
 */
export async function forgotCheck(deps, { msisdn, idNumber, ip }) {
  const n = normCell(msisdn);
  if (!n) return { ok: false, status: 400, error: 'BAD_NUMBER', line: 'Type your WaPay cell number, like 083 123 4567.' };
  const typed = String(idNumber || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (typed.length < 6 || typed.length > 20) return { ok: false, status: 400, error: 'BAD_ID', line: 'Type the whole ID or passport number.' };
  const numKey = `rf:n:${keyOf('cell', n)}`;
  const ipKey = `rf:ip:${keyOf('ip', ip)}`;
  const [byNumber, byIp] = await Promise.all([deps.limiter.count(numKey, APP_RESET_WINDOW_MS), deps.limiter.count(ipKey, APP_RESET_WINDOW_MS)]);
  if (byNumber >= APP_RESET_MAX_FAILS || byIp >= APP_RESET_MAX_FAILS * 3) return { ok: false, status: 429, error: 'PAUSED', line: resetPausedLine() };
  const miss = async (account = null) => {
    await Promise.all([deps.limiter.hit(numKey, { accountId: account?.id || null }), deps.limiter.hit(ipKey)]);
    // The chat's own counter, so three wrong numbers across the chat and the web pause both.
    if (account) await deps.prisma.auditLog.create({ data: { id: `audit_pr_${crypto.randomBytes(8).toString('hex')}`, accountId: account.id, event: 'PIN_RESET_ID_FAILED', metadata: { via: 'app' } } }).catch(() => {});
    return { ok: false, status: 401, error: 'NO_MATCH', line: noMatchLine() };
  };
  const account = await findAppAccount(deps.prisma, n);
  if (!account) return miss(null);
  const failures = await idFailures(deps, account.id).catch(() => null);
  if (failures == null) return { ok: false, status: 503, error: 'TRY_AGAIN', line: 'The safety check could not finish just now, so your PIN is unchanged. Please try again in a minute.' };
  if (failures >= APP_RESET_MAX_FAILS) return { ok: false, status: 429, error: 'PAUSED', line: resetPausedLine() };
  let identity;
  try {
    identity = await deps.loadPayoutIdentitySecretStrict({ prisma: deps.prisma, accountId: account.id });
  } catch {
    // Fail closed: a vault that cannot be read never skips the check (the chat's rule).
    return { ok: false, status: 503, error: 'TRY_AGAIN', line: 'The safety check could not finish just now, so your PIN is unchanged. Please try again in a minute.' };
  }
  if (!identity?.idNumber) return miss(account);
  if (!idNumberMatches(typed, identity.idNumber)) return miss(account);
  const factor = pinFactorOf(account);
  const pinSetAt = pinSetAtOf(factor) ?? 0;
  return { ok: true, status: 200, resetToken: mintResetToken({ accountId: account.id, pinSetAt, now: deps.now() }) };
}

/** Step 2: the new PIN twice. Single use: the token dies the moment the PIN changes. */
export async function forgotReset(deps, { resetToken, pin, pinAgain }) {
  const v = verifyResetToken(resetToken, deps.now());
  if (!v.ok) return { ok: false, status: 401, error: 'START_AGAIN', line: 'That reset has timed out. Please start again with your cell number and ID number.' };
  if (!pinShaped(pin)) return { ok: false, status: 400, error: 'BAD_PIN', line: 'A PIN is 4 to 6 digits.' };
  if (pin !== pinAgain) return { ok: false, status: 400, error: 'PIN_MISMATCH', line: 'Those two did not match, so your PIN is unchanged. Type your new PIN twice.' };
  const valid = deps.validatePINFormat(pin);
  if (!valid?.valid) return { ok: false, status: 400, error: 'WEAK_PIN', line: 'That PIN is too easy to guess. Please choose 4 to 6 digits without a simple pattern like 1234, 1111 or 0000.' };
  const account = await deps.prisma.account.findUnique({ where: { id: v.accountId }, include: { authFactors: { where: { type: 'PIN' } } } });
  if (!appEligible(account)) return { ok: false, status: 401, error: 'START_AGAIN', line: 'Please start again with your cell number and ID number.' };
  const before = pinFactorOf(account);
  if ((pinSetAtOf(before) ?? 0) !== v.pinSetAt) return { ok: false, status: 401, error: 'START_AGAIN', line: 'Your PIN changed since this reset began. Please start again.' };
  // The ID check above stands in for the WhatsApp code the chat sends, which cannot be delivered
  // while the number is restricted; resetPIN refuses unless its caller says the check passed.
  const done = await deps.resetPIN({ accountId: account.id, newPin: pin, otpVerified: true });
  if (!done?.ok) return { ok: false, status: 500, error: 'PIN_NOT_SAVED', line: 'The new PIN could not be saved just now, so your PIN is unchanged. Please try again in a minute.' };
  const nowIso = new Date(deps.now()).toISOString();
  // The chat's cool-off (lib/pin-reset.js): idChecked there means a check beyond the code to the phone.
  // This reset had the ID and not the phone, one factor, so the cool-off applies as for a code-only reset.
  await deps.mergeProfileSubkey({ accountId: account.id, key: 'pinReset', patch: { at: nowIso, idChecked: false, via: 'app' } }).catch(() => {});
  await deps.prisma.auditLog.create({ data: { accountId: account.id, event: 'APP_PIN_RESET', metadata: { via: 'ID_ON_FILE', coolOffHours: COOLOFF_HOURS() } } }).catch(() => {});
  const after = await deps.prisma.account.findUnique({ where: { id: account.id }, include: { authFactors: { where: { type: 'PIN' } } } });
  const setAt = pinSetAtOf(pinFactorOf(after));
  const session = setAt != null ? mintAppToken({ accountId: account.id, pinSetAt: setAt, now: deps.now() }) : null;
  const hours = COOLOFF_HOURS();
  return {
    ok: true,
    status: 200,
    token: session?.token || null,
    sid: session?.sid || null,
    line: hours > 0
      ? `Your new PIN is set and your PIN is unlocked. For your safety, for the next ${hours} hours a pay-out can only go to an account or number you saved before today, and sending to other people waits too; everything else works now.`
      : 'Your new PIN is set and your PIN is unlocked.',
  };
}
