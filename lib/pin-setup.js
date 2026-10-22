/**
 * The PIN chosen on demand (B, WAPAY_PIN_ON_DEMAND; docs/ONBOARDING.md §5,
 * golden thread 2.14; 2026-10-22). An account that opened without a PIN chooses
 * one the moment money is about to leave: at the PIN step of a pay-out, of a
 * send to another person or of paying a link from the balance (or any other
 * wallet-PIN step reached without one), or when the customer says *PIN* (the
 * web portal sends people here: "Set your WaPay PIN in the WhatsApp chat first").
 * Getting paid, making links, the balance and the transactions never ask.
 *
 *   gate      the flow was about to say "enter your PIN"; instead PIN_SETUP_NEW
 *             parks the interrupted step's data at the TOP level of the state
 *             data (so the sealed paths, an account or ID number typed for a
 *             pay-out, stay sealed: lib/flow-seal.js) with `pinSetup.resume`
 *   choose    4 digits (validatePINFormat: 4 to 6, no easy patterns)
 *   confirm   the same again; only a keyed HMAC of the first sits in the state
 *   set       setPIN, the auth package's own store (handleS3OtpVerified's), and
 *             only for an account that still has none: this flow creates a PIN,
 *             it never replaces one (that is the reset's job, with its checks)
 *   continue  the interrupted step runs in the same turn with the PIN the
 *             customer just typed; its own verifyPIN issues the proof as always,
 *             so nothing here moves money and there is no second verifier.
 *
 * Asked once: the gate opens only while the account has no PIN.
 */
import crypto from 'node:crypto';
import { pinOnDemandFor } from './onboarding-flags.js';

export const PIN_SETUP_STATES = Object.freeze(['PIN_SETUP_NEW', 'PIN_SETUP_CONFIRM']);
export const isPinSetupState = (s) => PIN_SETUP_STATES.includes(String(s || ''));

export const CHOOSE_PROMPT = '🔐 Choose a 4-digit PIN to protect your pay-outs. You type it to approve every pay-out and every send, so keep it to yourself. Avoid easy ones like 1234 or 0000.';
export const NO_PIN_YET = 'You have not chosen a WaPay PIN yet.';
export const CONFIRM_PROMPT = 'Type the same PIN once more to confirm it.';
export const PIN_SET_LINE = '✅ Your WaPay PIN is set. WaPay only asks for it to approve a payment.';
const TYPE_IT = 'Type the 4-digit PIN you want, or say *cancel*.';
const MISMATCH = 'Those two did not match, so no PIN is set yet. Type a new 4-digit PIN.';
const WEAK = 'That PIN is too easy to guess. Please choose 4 digits without a simple pattern like 1234, 1111 or 0000.';
const SHAPE = 'A PIN is 4 digits (up to 6 if you like). Type just the PIN you want.';
const CANCELLED = '👍 Cancelled. No PIN was set.';
const CANCELLED_RESUME = '👍 Cancelled. No PIN was set and nothing left your balance.';
const ALREADY = 'Your WaPay PIN is already set, so nothing changed. Say *forgot PIN* if you want a new one.';
const NOT_SAVED = 'I could not save the PIN just now, so no PIN is set. Please try again in a minute.';
const UNAVAILABLE = 'Choosing a PIN is not available right now. Please try again a little later.';

const CANCEL = /^\W*(?:cancel|stop|no|exit|quit|never ?mind|not now|later)\W*$/i;

/** "PIN", "set my PIN", "create a PIN", "set up my wapay pin", "my pin": the ask to choose one. Pure. */
export function matchPinSetupAsk(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 60) return false;
  return /^\W*(?:(?:i\s+(?:want|need)\s+(?:to\s+)?)?(?:set|create|choose|make|add|get|set ?up|setup)\s+(?:up\s+)?(?:a\s+|my\s+|the\s+)?)?(?:new\s+)?(?:wapay\s+)?pin(?:\s+(?:code|number))?(?:\s+now|\s+please)?\W*$/i.test(t)
    || /^\W*my\s+(?:wapay\s+)?pin\W*$/i.test(t);
}

/** The key for the pending PIN's HMAC: a deployment secret, never a constant (the PIN-reset recipe). */
const setupKey = (env = process.env) => env.WAPAY_PII_KEY || env.WAPAY_INTERNAL_API_KEY || env.PIN_PEPPER || '';
const pinHmac = (accountId, pin, env) => crypto.createHmac('sha256', setupKey(env)).update(`setup:${accountId}:${pin}`).digest('hex');
/** One 4-6 digit run in the message ("my pin is 2580"), or null when there is none or more than one. */
const onePinRun = (t) => {
  const r = String(t || '').match(/(?<!\d)\d{4,6}(?!\d)/g);
  return r && r.length === 1 ? r[0] : null;
};

/** The step that was waiting, without this flow's own key. Pure. */
export function resumeOf(data) {
  const setup = data && typeof data === 'object' ? data.pinSetup : null;
  if (!setup?.resume) return null;
  const { pinSetup, stateSetAt, ...rest } = data;
  return { state: setup.resume, data: rest };
}

/** Park the setup in front of `resumeState` (null: the PIN alone, as asked for). Pure. */
export function startPinSetup({ resumeState = null, resumeData = null, notYet = false } = {}) {
  const base = resumeData && typeof resumeData === 'object' ? { ...resumeData } : {};
  delete base.pinSetup;
  return {
    state: 'PIN_SETUP_NEW',
    data: { ...base, pinSetup: { resume: resumeState || null } },
    text: notYet ? `${NO_PIN_YET} ${CHOOSE_PROMPT}` : CHOOSE_PROMPT,
  };
}

/**
 * The gate, at the moment a flow would ask for the PIN: the setup step when this
 * account has no PIN and the deferred PIN covers it, else null (the flow asks for
 * the PIN as it always did). `hasPin(accountId)` is the auth package's hasPIN; a
 * failure to read it counts as "has a PIN" so the old path runs.
 */
export async function pinSetupGateStep({ account, waId = null, nextState = null, nextData = null, notYet = false, hasPin, env = process.env } = {}) {
  if (!account?.id || !pinOnDemandFor({ waId: waId || account.waId, account }, env)) return null;
  const has = await Promise.resolve(hasPin ? hasPin(account.id) : true).catch(() => true);
  if (has) return null;
  return startPinSetup({ resumeState: nextState, resumeData: nextData, notYet });
}

async function auth(deps) {
  if (deps.auth) return deps.auth;
  return import('@wapay/auth');
}

/**
 * One reply inside the setup. Returns a step:
 *   { state, data, text }                  ask again / the next question
 *   { state: null, passthrough: true }     a sentence about something else: answer it as new
 *   { done: true, text, resume?, pin? }    the PIN is set; with resume, the interrupted step
 *                                          carries on in this turn with `pin` (never stored)
 */
export async function handlePinSetupReply({ account, state, data = {}, text, deps = {}, env = process.env } = {}) {
  const t = String(text || '').trim();
  const setup = data && typeof data === 'object' && data.pinSetup ? data.pinSetup : {};
  if (CANCEL.test(t)) return { state: null, text: setup.resume ? CANCELLED_RESUME : CANCELLED };
  if (!/\d/.test(t)) {
    if (/[a-z]{3,}/i.test(t) && !/\bpin\b/i.test(t)) return { state: null, passthrough: true };
    return { state, data, text: state === 'PIN_SETUP_CONFIRM' ? CONFIRM_PROMPT : TYPE_IT };
  }
  const pin = onePinRun(t);
  if (!pin) return { state, data, text: SHAPE };
  if (!setupKey(env)) return { state: null, text: UNAVAILABLE };
  const a = await auth(deps);

  if (state !== 'PIN_SETUP_CONFIRM') {
    const v = a.validatePINFormat(pin);
    if (!v?.valid) return { state: 'PIN_SETUP_NEW', data, text: /weak/i.test(v?.error || '') ? WEAK : SHAPE };
    return { state: 'PIN_SETUP_CONFIRM', data: { ...data, pinSetup: { ...setup, pinHmac: pinHmac(account.id, pin, env) } }, text: CONFIRM_PROMPT };
  }

  if (!setup.pinHmac || pinHmac(account.id, pin, env) !== setup.pinHmac) {
    return { state: 'PIN_SETUP_NEW', data: { ...data, pinSetup: { resume: setup.resume || null } }, text: setup.pinHmac ? MISMATCH : CHOOSE_PROMPT };
  }
  // Create, never replace: a PIN set meanwhile (the reset, the web) wins and this one is not written.
  const already = await Promise.resolve((deps.hasPin || a.hasPIN)(account.id)).catch(() => null);
  if (already !== false) return { state: null, text: already ? ALREADY : NOT_SAVED };
  const saved = await a.setPIN({ accountId: account.id, pin }).catch((e) => ({ ok: false, error: e?.message }));
  if (!saved?.ok) return { state: null, text: NOT_SAVED };
  const resume = resumeOf(data);
  return resume ? { done: true, state: null, text: PIN_SET_LINE, resume, pin } : { done: true, state: null, text: PIN_SET_LINE };
}
