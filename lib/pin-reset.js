/**
 * Forgot / reset / change the WaPay PIN, in the chat, from anywhere (founder
 * 2026-10-14, after Lisa got stuck on 2026-10-12: one wrong PIN on a R342
 * withdrawal, then "Me for my password what to reset", "Reset pin", "Reset
 * pin", "Reset pin" over six minutes, and every answer was the model's
 * invented "Type reset PIN and I'll help you reset it". No reset existed in
 * the live flow: the auth package's forgot-PIN functions were never wired,
 * and a hard lock after ten wrong PINs lasted a year with no way out.)
 *
 * The flow: any way of saying it (here, mid-flow, at the PIN prompt) →
 *   a 6-digit code sent to this WhatsApp number (the onboarding OTP, 5
 *   minutes, 3 tries, "resend") →
 *   the full ID or passport number, when one is on file for withdrawals,
 *   checked against the encrypted value (never its displayed last digits; an
 *   SA ID's tail is guessable); failures counted per account across resets →
 *   the new PIN, twice →
 *   PIN set, the lock cleared, and whatever was waiting for the PIN (a
 *   withdrawal, a purchase) is waiting again: "enter your new PIN".
 * Cancel, home or another request at any step leaves the PIN unchanged.
 *
 * The code goes to the same WhatsApp that asked, so on its own it proves
 * little (adversarial review 2026-10-14): after a reset WITHOUT an ID check,
 * withdrawals to a destination not saved before the reset wait
 * WAPAY_PIN_RESET_COOLOFF_HOURS (default 24; 0 switches it off). A phone
 * thief cannot reset and pay himself out in the same minute.
 *
 * Secrets: the new PIN is never stored in the conversation data in clear
 * (an HMAC under PIN_PEPPER until it is confirmed); the code is sent by the
 * auth package's sendOTP, outside the conversation memory; inbound digits in
 * these states are hidden by the processor (state names start PIN_RESET_).
 */
import crypto from 'node:crypto';

export const PIN_RESET_STATES = Object.freeze(['PIN_RESET_CODE', 'PIN_RESET_ID', 'PIN_RESET_NEW', 'PIN_RESET_CONFIRM']);

const PIN_WORD = /\b(?:pin|pins|pin ?code|pin number|password|pass ?word|passcode|iphasiwedi|wagwoord)\b/i;
const TROUBLE = /\b(?:forgot|forgotten|forget|forgetting|reset|re-?set|change|changed|new|lost|recover|unlock|locked|blocked|wrong|incorrect|not working|doesn'?t work|does not work|isn'?t working|can'?t remember|cannot remember|don'?t remember|do not remember|don'?t know|do not know|help|what to reset|vergeet|khohlwe|lebetse)\b/i;
const NOT_WALLET_PIN = /\b(?:voucher|vouchers|token|meter|ott|blu|electricity|sim|bank card|card pin|atm pin|wifi)\b/i;

/**
 * "I forgot my PIN", "Reset pin", "Reset pin 2006", "Me for my password what to
 * reset", "ek het my pin vergeet". At a wallet-PIN prompt (atPinPrompt) the
 * PIN in question can only be the wallet PIN: "I forgot it", "I don't remember"
 * and "I forgot my pin for the voucher" count there. Pure.
 */
const BARE_FORGOT = /^\W*(?:i\s+)?(?:forgot|forgotten|forget|can'?t remember|cannot remember|don'?t remember|do not remember|don'?t know|do not know|vergeet|khohlwe|lebetse)(?:\s+(?:it|my\s+\w+|the\s+\w+|this|that))?\W*$/i;
export function matchPinResetAsk(text, { atPinPrompt = false } = {}) {
  const t = String(text || '').trim();
  if (!t || t.length > 160) return false;
  if (atPinPrompt && (BARE_FORGOT.test(t) || (PIN_WORD.test(t) && TROUBLE.test(t)))) return true;
  if (NOT_WALLET_PIN.test(t)) return false;
  return PIN_WORD.test(t) && TROUBLE.test(t);
}

const FORGOT_HINT = 'Forgot it? Say *forgot PIN* and I will help you set a new one.';
/** The reply to a wrong PIN at any PIN prompt: try again, or the way out. Never "try again later". */
export function wrongPinText() {
  return `❌ That PIN is not right. Try again, or reply "cancel". ${FORGOT_HINT}`;
}
/** The reply when the PIN is locked (5 wrong: 15 minutes; 10 wrong: until reset). The way out is always named. */
export function lockedPinText({ lockedUntil = null, now = new Date() } = {}) {
  const until = lockedUntil ? new Date(lockedUntil) : null;
  const longLock = !until || until.getTime() - new Date(now).getTime() > 60 * 60 * 1000;
  return longLock
    ? '🔒 Your PIN is locked after too many wrong tries. Say *forgot PIN* to set a new one now; it takes a minute.'
    : '🔒 Your PIN is locked for 15 minutes after 5 wrong tries. Say *forgot PIN* to set a new one now instead of waiting.';
}

const R = (c) => `R${(c / 100).toFixed(2).replace(/\.00$/, '')}`;
/** The key for the pending new PIN's HMAC: a real deployment secret, never a constant in the source. */
const resetKey = () => process.env.WAPAY_PII_KEY || process.env.WAPAY_INTERNAL_API_KEY || process.env.PIN_PEPPER || '';
const pinHmac = (accountId, pin) => crypto.createHmac('sha256', resetKey()).update(`${accountId}:${pin}`).digest('hex');
/** One 4-6 digit run in a sentence ("my new pin is 2580"), or null when there is none or more than one. */
const onePinRun = (t) => { const r = String(t || '').match(/(?<!\d)\d{4,6}(?!\d)/g); return r && r.length === 1 ? r[0] : null; };
const oneCodeRun = (t) => { const r = String(t || '').replace(/(\d)[\s-](?=\d)/g, '$1').match(/(?<!\d)\d{6}(?!\d)/g); return r && r.length === 1 ? r[0] : null; };
const normId = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const COOLOFF_HOURS = () => Math.max(0, Number(process.env.WAPAY_PIN_RESET_COOLOFF_HOURS ?? 24));
const ID_FAILURE_LIMIT = 3;
const CANCEL = /^\W*(?:cancel|stop|no|exit|quit|never ?mind|keep (?:it|my pin)|don'?t)\W*$/i;
const RESEND = /\b(?:resend|send (?:it )?again|new code|another code|didn'?t (?:get|receive)|did not (?:get|receive)|no code|not (?:get|got|received) (?:a|the|any) code)\b/i;
const CANCELLED = '👍 PIN reset cancelled. Your PIN is unchanged.';

/** What was waiting for a PIN when the reset began, in words for the resume line. */
function resumeWhat(state, data = {}) {
  const amt = Number.isInteger(data?.amountCents) ? R(data.amountCents) : null;
  if (state === 'PAYOUT_PIN') return amt ? `Your withdrawal of ${amt} is still waiting` : 'Your withdrawal is still waiting';
  if (state === 'AIRTIME_PIN') return amt ? `Your ${amt} airtime is still waiting` : 'Your airtime purchase is still waiting';
  if (state === 'DATA_PIN') return 'Your data bundle is still waiting';
  if (state === 'ELECTRICITY_PIN') return amt ? `Your ${amt} electricity is still waiting` : 'Your electricity purchase is still waiting';
  if (state === 'FUEL_PIN') return 'Your fuel voucher is still waiting';
  if (state === 'VOUCHER_GIFT_PIN') return amt ? `Your ${amt} voucher is still waiting` : 'Your voucher is still waiting';
  if (state === 'PAYREQ_PIN') return 'Your payment is still waiting';
  return 'What you started is still waiting';
}
/** Flows whose PIN step can wait through a reset: their data does not expire in minutes. */
const RESUMABLE = new Set(['PAYOUT_PIN', 'PAYREQ_PIN']);
const PURCHASE_AGAIN = { AIRTIME_PIN: 'your airtime', DATA_PIN: 'your data bundle', ELECTRICITY_PIN: 'your electricity', FUEL_PIN: 'your fuel voucher', VOUCHER_GIFT_PIN: 'your voucher' };
/** A state that was asking for the wallet PIN (never a voucher code, never the reset itself). */
export const isWalletPinState = (s) => /_PIN$/.test(String(s || '')) && !/^(?:VOUCHER_PIN|AWAITING_VOUCHER_PIN)$/.test(String(s)) && !String(s).startsWith('PIN_RESET_');

async function auth(deps) {
  if (deps.auth) return deps.auth;
  return import('@wapay/auth');
}

/**
 * Start a reset: send the code, park PIN_RESET_CODE. fromState/fromData: the
 * flow that was waiting for a PIN, resumed after the new PIN is set.
 * @returns {Promise<{ state: string|null, data?: object, text: string }>}
 */
export async function startPinReset({ account, fromState = null, fromData = null, deps = {} } = {}) {
  if (!resetKey()) return { state: null, text: 'PIN reset is not available right now, so your PIN is unchanged. Please try again later today.' };
  const a = await auth(deps);
  const resume = isWalletPinState(fromState) ? { state: fromState, data: RESUMABLE.has(fromState) ? (fromData || {}) : {} } : null;
  const sent = await a.sendOTP({ accountId: account.id, msisdn: account.waId || account.msisdn, displayName: account.displayName || '' }).catch((e) => ({ ok: false, error: e?.message || 'SEND_FAILED' }));
  const data = { resume, tries: 0 };
  if (sent?.ok) {
    return { state: 'PIN_RESET_CODE', data, text: '🔐 Let\'s set a new PIN. I have just sent you a 6-digit code in a separate message. Type the code here. (Say *cancel* to keep your current PIN.)' };
  }
  if (sent?.error === 'TOO_MANY_REQUESTS') {
    return { state: 'PIN_RESET_CODE', data, text: '🔐 A code was already sent a few minutes ago. Type that 6-digit code here, or say *resend* in 5 minutes for a new one. (Say *cancel* to keep your current PIN.)' };
  }
  return { state: null, text: 'I could not send the code just now, so your PIN is unchanged. Please say *forgot PIN* again in a minute.' };
}

/**
 * One reply inside the reset. Returns a step; passthrough: true when the
 * message belongs to something else (the processor answers it as new).
 */
// "Let's set a new PIN" while a reset is running is this reset, not a new one
// (Lisa 2026-10-15: the sentence left the step, started a second reset and a second code).
const STEP_AGAIN = Object.freeze({
  PIN_RESET_CODE: 'We are already resetting your PIN. Type the 6-digit code I sent you in a separate message, or say *resend* for a new one. (Say *cancel* to keep your current PIN.)',
  PIN_RESET_ID: 'We are already resetting your PIN. Type the ID or passport number you gave for withdrawals (the whole number), or say *cancel*.',
  PIN_RESET_NEW: 'We are already resetting your PIN. Type your new PIN: 4 to 6 digits.',
  PIN_RESET_CONFIRM: 'We are already resetting your PIN. Type the same new PIN once more to confirm it.',
});

export async function handlePinResetReply({ account, state, data = {}, text, deps = {} } = {}) {
  const t = String(text || '').trim();
  if (CANCEL.test(t)) return { state: null, text: CANCELLED };
  if (STEP_AGAIN[state] && !/\d/.test(t) && matchPinResetAsk(t)) return { state, data, text: STEP_AGAIN[state] };
  const a = await auth(deps);

  if (state === 'PIN_RESET_CODE') {
    if (RESEND.test(t)) return startPinReset({ account, fromState: data.resume?.state || null, fromData: data.resume?.data || null, deps });
    const code = oneCodeRun(t);
    if (!code) {
      if (!/\d/.test(t) && /[a-z]{3,}/i.test(t)) return { state: null, passthrough: true };
      return { state, data, text: 'Please type the 6-digit code from the message I just sent, or say *resend* for a new one.' };
    }
    const ok = await a.verifyOTP({ accountId: account.id, code }).catch(() => ({ ok: false }));
    if (!ok?.ok) return { state, data, text: 'That code is not right or has expired. Type the 6-digit code from the message I sent, or say *resend* for a new one.' };
    // The ID on file (fail closed: a read error stops the reset, it never skips the check).
    let identity;
    try {
      identity = deps.loadIdentity ? await deps.loadIdentity() : await (await import('./payout-beneficiaries.js')).loadPayoutIdentitySecretStrict({ accountId: account.id });
    } catch {
      return { state: null, text: 'I could not finish the safety check just now, so your PIN is unchanged. Please say *forgot PIN* again in a minute.' };
    }
    if (identity?.idNumber) {
      const failures = await (deps.idFailures || recentIdFailures)({ accountId: account.id }).catch(() => null);
      if (failures == null) return { state: null, text: 'I could not finish the safety check just now, so your PIN is unchanged. Please say *forgot PIN* again in a minute.' };
      if (failures >= ID_FAILURE_LIMIT) return { state: null, text: 'For your safety, PIN reset is paused for 24 hours after too many wrong ID numbers, so your PIN is unchanged. Please contact the WaPay team if you need it sooner.' };
      return { state: 'PIN_RESET_ID', data: { ...data, codeOk: true }, text: '✅ Code confirmed. One safety check: type the ID or passport number you gave for withdrawals (the whole number).' };
    }
    return { state: 'PIN_RESET_NEW', data: { ...data, codeOk: true, idChecked: false }, text: '✅ Code confirmed. Now type your new PIN: 4 to 6 digits. Avoid easy ones like 1234 or 0000.' };
  }

  if (state === 'PIN_RESET_ID') {
    if (!data.codeOk) return { state: null, text: CANCELLED };
    if (!/\d/.test(t) && /[a-z]{3,}/i.test(t) && t.split(/\s+/).length > 2) return { state: null, passthrough: true };
    let identity;
    try {
      identity = deps.loadIdentity ? await deps.loadIdentity() : await (await import('./payout-beneficiaries.js')).loadPayoutIdentitySecretStrict({ accountId: account.id });
    } catch {
      return { state: null, text: 'I could not finish the safety check just now, so your PIN is unchanged. Please say *forgot PIN* again in a minute.' };
    }
    const typed = normId(t);
    if (identity?.idNumber && typed && typed === normId(identity.idNumber)) {
      return { state: 'PIN_RESET_NEW', data: { ...data, idChecked: true }, text: '✅ Thank you. Now type your new PIN: 4 to 6 digits. Avoid easy ones like 1234 or 0000.' };
    }
    await (deps.recordIdFailure || recordIdFailure)({ accountId: account.id }).catch(() => {});
    const failures = await (deps.idFailures || recentIdFailures)({ accountId: account.id }).catch(() => null);
    if (failures == null) return { state: null, text: 'That number does not match, and I could not finish the safety check just now, so your PIN is unchanged. Please say *forgot PIN* again in a minute.' };
    if (failures >= ID_FAILURE_LIMIT) {
      // A person, said only when the alert actually went (the same rule as the withdraw gate).
      const tail = String(account.waId || account.msisdn || '').replace(/\D/g, '').slice(-4);
      const sendAlert = deps.sendOpsAlert || (await import('./email.js')).sendOpsAlert;
      const sent = await sendAlert({ subject: 'PIN reset paused: the ID number did not match three times', detailsHtml: `<p>Account <code>${account.id}</code>, WhatsApp •••${tail}: the code was confirmed but the withdrawal ID number typed did not match three times in 24 hours. The PIN is unchanged and resets are paused for 24 hours.</p>` }).catch(() => ({ success: false }));
      return { state: null, text: sent?.success
        ? 'That number does not match what is on file, so your PIN is unchanged and PIN reset is paused for 24 hours. I have asked a person from the WaPay team to help you; they will message you here.'
        : 'That number does not match what is on file, so your PIN is unchanged and PIN reset is paused for 24 hours. Please contact the WaPay team to reset it.' };
    }
    return { state, data, text: 'That number does not match the ID or passport number on file. Please type the whole number you gave for withdrawals.' };
  }

  if (state === 'PIN_RESET_NEW') {
    if (!data.codeOk) return { state: null, text: CANCELLED };
    if (!/\d/.test(t)) return { state: null, passthrough: true };
    const pin = onePinRun(t) || t.replace(/\s/g, '');
    const v = a.validatePINFormat(pin);
    if (!v?.valid) return { state, data, text: /weak/i.test(v?.error || '') ? 'That PIN is too easy to guess. Please choose 4 to 6 digits without a simple pattern like 1234, 1111 or 0000.' : 'A PIN is 4 to 6 digits. Please type your new PIN.' };
    return { state: 'PIN_RESET_CONFIRM', data: { ...data, pinHmac: pinHmac(account.id, pin) }, text: 'Type the same PIN once more to confirm it.' };
  }

  if (state === 'PIN_RESET_CONFIRM') {
    if (!data.codeOk || !data.pinHmac) return { state: null, text: CANCELLED };
    if (!/\d/.test(t)) return { state: null, passthrough: true };
    const pin = onePinRun(t) || t.replace(/\s/g, '');
    if (pinHmac(account.id, pin) !== data.pinHmac) return { state: 'PIN_RESET_NEW', data: { ...data, pinHmac: null }, text: 'Those two did not match, so your PIN is unchanged. Type your new PIN again: 4 to 6 digits.' };
    const done = await a.resetPIN({ accountId: account.id, newPin: pin, otpVerified: true }).catch((e) => ({ ok: false, error: e?.message }));
    if (!done?.ok) return { state: null, text: 'I could not save the new PIN just now, so your PIN is unchanged. Please say *forgot PIN* again in a minute.' };
    await (deps.recordReset || recordReset)({ accountId: account.id, idChecked: !!data.idChecked }).catch(() => {});
    const set = '✅ Your new PIN is set and your PIN is unlocked. Keep it to yourself: WaPay only asks for it to approve a payment.';
    const hours = COOLOFF_HOURS();
    const coolOff = !data.idChecked && hours > 0 ? `\n\nFor your safety, for the next ${hours} hours a withdrawal can only go to an account or number you saved before today; everything else works now.` : '';
    const st = data.resume?.state;
    if (st && RESUMABLE.has(st)) {
      const toUnsaved = st === 'PAYOUT_PIN' && !data.resume.data?.recipient?.savedId;
      if (toUnsaved && coolOff) return { state: null, text: `${set}${coolOff} Your withdrawal is cancelled for now and nothing left your balance.` };
      return { state: st, data: data.resume.data || {}, text: `${set}\n\n🔐 ${resumeWhat(st, data.resume.data)}. Enter your new PIN to finish it, or reply "cancel".${coolOff}`, resumed: st };
    }
    if (st && PURCHASE_AGAIN[st]) return { state: null, text: `${set}\n\nAsk for ${PURCHASE_AGAIN[st]} again and use your new PIN at the end.${coolOff}` };
    return { state: null, text: `${set}${coolOff}` };
  }
  return { state: null, text: CANCELLED };
}

// ------------------------------------------------------------------ audit-backed counters

async function db(deps = {}) {
  return deps.prisma || (await import('./prisma.js')).default;
}
const auditId = () => `audit_pr_${crypto.randomBytes(8).toString('hex')}`;
async function recordIdFailure({ accountId, deps } = {}) {
  const p = await db(deps);
  await p.auditLog.create({ data: { id: auditId(), accountId, event: 'PIN_RESET_ID_FAILED', metadata: {} } });
}
async function recentIdFailures({ accountId, deps, now = new Date() } = {}) {
  const p = await db(deps);
  return p.auditLog.count({ where: { accountId, event: 'PIN_RESET_ID_FAILED', timestamp: { gte: new Date(new Date(now).getTime() - 24 * 3600 * 1000) } } });
}
async function recordReset({ accountId, idChecked, deps, now = new Date() } = {}) {
  const p = await db(deps);
  await p.auditLog.create({ data: { id: auditId(), accountId, event: 'PIN_RESET_VIA_CHAT', metadata: { idChecked: !!idChecked } } });
  // The cool-off reads the account's own profile, loaded with every message: no extra read to fail.
  const { updateProfile } = await import('./user-profile.js');
  await updateProfile({ prisma: p, accountId, patch: { pinReset: { at: new Date(now).toISOString(), idChecked: !!idChecked } } });
}

/**
 * The withdrawal cool-off after a PIN reset that had no ID check: { until }
 * while withdrawals may only go to destinations saved before the reset, else
 * null. Pure: it reads account.profile.pinReset, written by the reset.
 */
export function pinResetCoolOff({ account, now = new Date() } = {}) {
  const hours = COOLOFF_HOURS();
  const r = account?.profile && typeof account.profile === 'object' ? account.profile.pinReset : null;
  if (!hours || !r?.at || r.idChecked === true) return null;
  const until = new Date(new Date(r.at).getTime() + hours * 3600 * 1000);
  return until.getTime() > new Date(now).getTime() ? { until } : null;
}
