/**
 * One-step sign-up (A, WAPAY_ONBOARDING_ONE_STEP; and C's payer reply,
 * WAPAY_PAYER_PREREGISTER; docs/ONBOARDING.md §5, 2026-10-22): the copy of the
 * one message that opens an account, and the order of that turn.
 *
 * The turn, in the processor (oneStepSignupTurn): build ONE message = an
 * optional lead (the ad answer, who invited them, the payer's receipt), then
 * the first-link question for an ad arrival or the home card for anyone else,
 * then the terms line; send it; only when WhatsApp accepted it, open the
 * account (@wapay/auth completeOneStepOnboarding: S5, consent IMPLIED_BY_USE with
 * the inbound message id, the profile stamp, the audit rows). No name step (the
 * WhatsApp profile name), no PIN (chosen when money first leaves), no "I
 * accept", no template, no model call.
 *
 * Pure: copy only. Customer copy: no em dashes, no promise of a date.
 */
import { rands } from './ad-flow.js';

export const TERMS_URL = 'https://wapay.co.za/legal/terms';
/** The consent notice, verbatim from the brief. It is never translated: the terms are in English. */
export const TERMS_LINE = `By using WaPay you agree to our Terms & Privacy Policy: ${TERMS_URL}`;

/** Any reply text with the terms line at its end, after a blank line. Pure. */
export function withTermsLine(text) {
  const body = String(text ?? '').trimEnd();
  return body ? `${body}\n\n${TERMS_LINE}` : TERMS_LINE;
}

/**
 * The one message that opens an account: the lead on top (who invited them, the
 * payer's receipt), the body (the ad answer and first-link question, or the home
 * card), the terms line last. `recordAs` is what conversation memory keeps when
 * the lead names someone (the inviter: memory keeps "A friend"). Pure.
 * @returns {{ text: string, recordAs: string|null }}
 */
export function composeOneStepMessage({ lead = null, body = '', recordLead = null } = {}) {
  const join = (top) => (top ? `${top}\n\n${body}` : body);
  return { text: withTermsLine(join(lead)), recordAs: recordLead ? withTermsLine(join(recordLead)) : null };
}

/** The home card's first line on the reply that opens the account. Pure. */
export function openedGreeting(displayName) {
  const name = String(displayName || '').trim();
  return name && name !== 'Friend' ? `🎉 *Welcome to WaPay, ${name}!* Your account is open.` : '🎉 *Welcome to WaPay!* Your account is open.';
}

/** The referral lead without "let's open your account": it is open by the end of the message. Pure. */
export function referredOpenedLead({ inviterFirstName = null } = {}) {
  return inviterFirstName ? `${inviterFirstName} invited you to WaPay 💚` : 'A friend invited you to WaPay 💚';
}

/** "22 Oct" in South African time. Pure. */
export function shortSastDate(at) {
  const d = at ? new Date(at) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', timeZone: 'Africa/Johannesburg' });
}

/**
 * The payer's receipt as the lead of the reply that opens their account (C):
 * "🧾 You paid R250 to Thandi on 22 Oct, reference PF 1234567 · PR7K2FQ4." Pure.
 */
export function payerReceiptLine({ amountCents, requesterLabel, paidAt = null, reference }) {
  const when = shortSastDate(paidAt);
  const who = String(requesterLabel || 'a WaPay user').trim() || 'a WaPay user';
  return `🧾 You paid ${rands(amountCents)} to ${who}${when ? ` on ${when}` : ''}, reference ${reference}.`;
}

/** A receipt asked for before the card payment was confirmed: said plainly, no time promise. Pure. */
export function payerPendingLine({ requesterLabel }) {
  const who = String(requesterLabel || 'a WaPay user').trim() || 'a WaPay user';
  return `⏳ Your payment to ${who} is not confirmed yet. Your receipt comes in this chat once it is.`;
}

/**
 * The payload WaPay puts on the v2 receipt template's "My receipt" quick-reply
 * button (docs/templates/wapay_payment_receipt_v2.md): it comes back with the
 * tap, so the reply knows which receipt to show. Never typed by a person.
 */
export const RECEIPT_BUTTON_PREFIX = 'WAPAY_RECEIPT:';
export const RECEIPT_BUTTON_PAYLOAD = /^WAPAY_RECEIPT:(PR[A-HJKMNP-Z]{6})$/;
export function receiptButtonPayload(code) {
  return `${RECEIPT_BUTTON_PREFIX}${String(code || '').toUpperCase()}`;
}
/** The request code a tapped "My receipt" button carries, or null. Pure. */
export function receiptCodeFromPayload(payload) {
  const m = String(payload || '').trim().match(RECEIPT_BUTTON_PAYLOAD);
  return m ? m[1] : null;
}
