/**
 * The sign-up switches of 2026-10-22 (docs/briefs/ONE_STEP_ONBOARDING_BRIEF.md,
 * docs/ONBOARDING.md §5). Each one reads "on" (also true, 1, yes, all) for
 * everyone, or a comma-separated list of numbers for those numbers only, in any
 * spelling (27…, 0…, +27 82 …: the pilot-list lesson of 2026-09-18, matched on
 * normaliseMsisdn). Unset, empty, "off" or anything else is nobody, so with every
 * switch unset the chat behaves exactly as it did before they existed. Read at
 * call time (a change in Vercel takes effect with the next deployment).
 *
 *   WAPAY_ONBOARDING_ONE_STEP          A  the first message opens the account: terms
 *                                         accepted by continuing, no PIN, no consent step
 *   WAPAY_PIN_ON_DEMAND                B  no PIN at sign-up; it is chosen the first time
 *                                         money leaves (pay-out, send, paying a link)
 *   WAPAY_PAYER_PREREGISTER            C  a card payer's number gets an S0 account at the
 *                                         receipt; their reply opens it with the receipt
 *   WAPAY_TEMPLATE_PAYMENT_RECEIPT_V2  C  the approved v2 receipt template's name; used
 *                                         only for payers C covers (unset: the current one)
 *
 * Pure: nothing here reads a database or sends anything.
 */
import { normaliseMsisdn } from './msisdn.js';

export const FLAGS = Object.freeze({
  ONE_STEP: 'WAPAY_ONBOARDING_ONE_STEP',
  PIN_ON_DEMAND: 'WAPAY_PIN_ON_DEMAND',
  PAYER_PREREGISTER: 'WAPAY_PAYER_PREREGISTER',
});
export const RECEIPT_V2_ENV = 'WAPAY_TEMPLATE_PAYMENT_RECEIPT_V2';

const EVERYONE = /^(on|true|1|yes|all)$/i;
const NOBODY = /^(off|false|0|no|none)?$/i;

/** { everyone, numbers } for one switch value; numbers are canonical 0-form SA numbers. Pure. */
export function parseFlag(raw) {
  const v = String(raw ?? '').trim();
  if (EVERYONE.test(v)) return { everyone: true, numbers: [] };
  if (NOBODY.test(v)) return { everyone: false, numbers: [] };
  const numbers = v
    .split(/[,;]/)
    .map((entry) => normaliseMsisdn(entry.trim()))
    .filter((n) => /^0\d{9}$/.test(n));
  return { everyone: false, numbers: [...new Set(numbers)] };
}

/** Is this switch on for this number? An unset switch is nobody, never everybody. */
export function flagOnFor(name, waId, env = process.env) {
  const f = parseFlag(env?.[name]);
  if (f.everyone) return true;
  if (!f.numbers.length) return false;
  const n = normaliseMsisdn(waId);
  return !!n && f.numbers.includes(n);
}

/** A: the first message from this number opens the account in one step. */
export function oneStepFor(waId, env = process.env) {
  return flagOnFor(FLAGS.ONE_STEP, waId, env);
}

/** C: a payer's number gets an account at the receipt, and their reply opens it. */
export function payerPreregisterFor(waId, env = process.env) {
  return flagOnFor(FLAGS.PAYER_PREREGISTER, waId, env);
}

/** A pre-registered payer (C): the account was made at a receipt, before they ever wrote. Pure. */
export function isPayerOrigin(account) {
  const p = account?.profile && typeof account.profile === 'object' ? account.profile : null;
  return p?.origin?.kind === 'PAYER';
}

/**
 * The one-step sign-up applies to this account's next message: A covers the
 * number, or it is a payer C pre-registered and C still covers it.
 */
export function oneStepSignupFor({ waId = null, account = null } = {}, env = process.env) {
  const id = waId || account?.waId || null;
  if (oneStepFor(id, env)) return true;
  return isPayerOrigin(account) && payerPreregisterFor(id, env);
}

/** B at sign-up: the classic flow skips its PIN step for this number. */
export function pinDeferredAtSignupFor(waId, env = process.env) {
  return flagOnFor(FLAGS.PIN_ON_DEMAND, waId, env);
}

/**
 * B in the money flows: an account without a PIN chooses one when money is
 * about to leave. On when B covers the number, or when the account finished
 * sign-up without a PIN (profile.onboarding.pinDeferred, stamped by the one-step
 * sign-up of A and C and by the classic sign-up under B): such an account keeps
 * the way to choose a PIN whatever the switches say later, so turning a switch
 * off can never strand it at a PIN prompt it cannot answer. A or C alone never
 * change anything for an account they did not open.
 */
export function pinOnDemandFor({ waId = null, account = null } = {}, env = process.env) {
  const id = waId || account?.waId || null;
  if (flagOnFor(FLAGS.PIN_ON_DEMAND, id, env)) return true;
  const p = account?.profile && typeof account.profile === 'object' ? account.profile : null;
  return p?.onboarding?.pinDeferred === true;
}

/**
 * The web portal's "set your PIN in WhatsApp first" line. Decided by the typed
 * number alone, never by the account behind it, so the login answer still never
 * tells whether a number is on WaPay or has a PIN.
 */
export function portalNoPinLineFor(msisdn, env = process.env) {
  return flagOnFor(FLAGS.PIN_ON_DEMAND, msisdn, env) || flagOnFor(FLAGS.ONE_STEP, msisdn, env) || flagOnFor(FLAGS.PAYER_PREREGISTER, msisdn, env);
}

/**
 * The v2 receipt template for this payer, or null (the current template goes).
 * Only when the v2 template's name is set AND C covers the payer: the template's
 * "reply to this message" promise is kept by C's reply path.
 */
export function receiptV2TemplateFor(payerWaId, env = process.env) {
  const name = String(env?.[RECEIPT_V2_ENV] || '').trim();
  if (!name || NOBODY.test(name)) return null;
  return payerPreregisterFor(payerWaId, env) ? name : null;
}

/** D: the path a new account is stamped with when it is created. */
export function signupPathFor(waId, env = process.env) {
  return oneStepFor(waId, env) ? 'ONE_STEP' : 'CLASSIC';
}

/** What /api/internal/flags shows: booleans and counts, never a number. */
export function onboardingFlagsReadout(env = process.env) {
  const one = (name) => {
    const f = parseFlag(env?.[name]);
    return { everyone: f.everyone, listed: f.numbers.length };
  };
  return {
    oneStep: one(FLAGS.ONE_STEP),
    pinOnDemand: one(FLAGS.PIN_ON_DEMAND),
    payerPreregister: one(FLAGS.PAYER_PREREGISTER),
    receiptV2Template: !!String(env?.[RECEIPT_V2_ENV] || '').trim() && !NOBODY.test(String(env?.[RECEIPT_V2_ENV] || '').trim()),
  };
}
