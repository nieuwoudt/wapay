/**
 * WaPay gifting — "send R50 airtime to Mom".
 *
 * REGULATORY NOTE (important): gifting airtime/data is a SPEND — WaPay buys a
 * good and has the supplier deliver it to a third party's phone number. It is
 * NOT a wallet-to-wallet money transfer. The sender's SPEND balance is debited
 * via buildSpend (exactly like a self-purchase); no value ever lands in a
 * "recipient wallet". That keeps gifting inside the closed, spend-only box and
 * out of the money-transfer / e-money classification. WaPay V1 deliberately
 * does NOT move cash person-to-person.
 *
 * This module is pure (no DB, no network) so the rules are unit-testable. The
 * money is posted by the normal airtime/data spend path; the flow layer calls
 * resolveGift() to work out who gets what, then buildRecipientNotification()
 * to tell the recipient.
 */

import { normaliseMsisdn, isValidSaMsisdn } from './msisdn.js';

/** Only these can be gifted to a bare phone number in V1. */
export const GIFTABLE_PRODUCTS = new Set(['AIRTIME', 'DATA']);

/**
 * Work out whether a parsed request is a gift, a self-purchase, or blocked,
 * and normalise the pieces the flow needs to execute it.
 *
 * @param {object} args
 * @param {object} args.slots        - output of lib/slot-parser parseSlots()
 * @param {string} args.senderMsisdn - the sender's own number (to tell gift from self)
 * @param {string} [args.product]    - explicit product override (AIRTIME|DATA)
 * @returns {{kind: string, ok: boolean, recipientMsisdn?: string,
 *            amountCents?: number, product?: string, message?: string}}
 */
export function resolveGift({ slots = {}, senderMsisdn, product } = {}) {
  const prod = String(product || slots.productHint || '').toUpperCase();
  const amountCents = slots.amountCents ?? null;
  const recipientRaw = slots.msisdn ?? null;

  // Pure cash send is a money transfer — not offered in V1. Steer to a gift.
  if (prod === 'SEND_MONEY') {
    return {
      kind: 'CASH_SEND_UNSUPPORTED',
      ok: false,
      message:
        "WaPay can't send cash to a person yet. But you can send airtime, data " +
        'or electricity to any number — try "send R50 airtime to 082…".',
    };
  }

  if (!GIFTABLE_PRODUCTS.has(prod)) {
    return {
      kind: 'NOT_GIFTABLE',
      ok: false,
      message: 'You can gift airtime or data to a number. What would you like to send?',
    };
  }

  if (!amountCents || amountCents <= 0) {
    return { kind: 'NEEDS_AMOUNT', ok: false, product: prod, message: 'How much? For example "R50".' };
  }

  if (!recipientRaw) {
    return {
      kind: 'NEEDS_RECIPIENT',
      ok: false,
      product: prod,
      amountCents,
      message: "Which number should I send it to? Send the recipient's cellphone number.",
    };
  }

  if (!isValidSaMsisdn(recipientRaw)) {
    return {
      kind: 'INVALID_RECIPIENT',
      ok: false,
      product: prod,
      amountCents,
      message: "That doesn't look like a valid South African cellphone number. Please check and resend.",
    };
  }

  const recipientMsisdn = normaliseMsisdn(recipientRaw);
  const normalisedSender = senderMsisdn ? normaliseMsisdn(senderMsisdn) : null;

  // Buying for your own number is just a self top-up, not a gift.
  if (normalisedSender && recipientMsisdn === normalisedSender) {
    return { kind: 'SELF', ok: true, recipientMsisdn, amountCents, product: prod };
  }

  return { kind: 'GIFT', ok: true, recipientMsisdn, amountCents, product: prod };
}

/** Rand string for display, from integer cents. */
function rands(cents) {
  return `R${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
}

/**
 * Build the message that tells the RECIPIENT they've received a gift.
 *
 * WhatsApp constraint baked in: a recipient who has never messaged WaPay is
 * outside the 24-hour customer-service window, so the FIRST touch to a new
 * number MUST be an approved template — free text will be rejected by Meta.
 * We therefore return both: template params (for new/out-of-window recipients)
 * and a plain-text fallback (for recipients already in an open session).
 *
 * @returns {{templateName: string, languageCode: string, bodyParams: string[],
 *            fallbackText: string, requiresTemplate: true}}
 */
export function buildRecipientNotification({ senderName, senderMsisdn, product, amountCents }) {
  const who = (senderName && senderName.trim()) || maskMsisdn(senderMsisdn) || 'Someone';
  const what = product === 'DATA' ? `${rands(amountCents)} of data` : `${rands(amountCents)} airtime`;

  return {
    // Must be created + approved in the WhatsApp Business Manager before use.
    // Branded as a "WaPay voucher" — the product language for value arriving
    // on WhatsApp — rather than a generic gift.
    templateName: 'wapay_voucher_received',
    languageCode: 'en',
    // Template body e.g.:
    // "💸 {{1}} sent you {{2}} with WaPay — money on WhatsApp.
    //  It's already on your phone. Reply to get your own WaPay and send
    //  airtime, data or electricity to anyone."
    bodyParams: [who, what],
    fallbackText:
      `💸 ${who} sent you ${what} with WaPay — money on WhatsApp. It's already on your phone.\n\n` +
      `Reply here to get your own WaPay and send airtime, data or electricity to anyone.`,
    requiresTemplate: true,
  };
}

/** Show only the last 3 digits of a number in recipient-facing copy. */
export function maskMsisdn(raw = '') {
  const m = normaliseMsisdn(raw);
  if (!m || m.length < 4) return '';
  return `${m.slice(0, 3)}•••${m.slice(-3)}`;
}
