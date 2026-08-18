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
 * A bare "send R50 to 084..." (no product word) is likewise a SPEND: the
 * sender buys a WaPay GOODS voucher (OTT-issued) which the recipient can
 * spend online or cash out via OTT's own rails — never a cash transfer.
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

  // Bare "send R50 to 084..." — WaPay sells a GOODS voucher, never a money
  // transfer: the sender buys a WaPay voucher (OTT-issued behind the scenes)
  // and the recipient can spend it online or cash it out via OTT's own rails.
  if (prod === 'SEND_MONEY') {
    if (!amountCents || amountCents <= 0) {
      return {
        kind: 'NEEDS_AMOUNT',
        ok: false,
        product: 'VOUCHER',
        message:
          'How much would you like to send? For example "R50".\n\n' +
          "I'll send them a WaPay voucher they can spend online or take to their bank.",
      };
    }

    if (!recipientRaw) {
      return {
        kind: 'NEEDS_RECIPIENT',
        ok: false,
        product: 'VOUCHER',
        amountCents,
        message:
          "Which number should I send it to? Send the recipient's cellphone number.\n\n" +
          "I'll send them a WaPay voucher they can spend online or take to their bank.",
      };
    }

    if (!isValidSaMsisdn(recipientRaw)) {
      return {
        kind: 'INVALID_RECIPIENT',
        ok: false,
        product: 'VOUCHER',
        amountCents,
        message: "That doesn't look like a valid South African cellphone number. Please check and resend.",
      };
    }

    return {
      kind: 'VOUCHER_GIFT',
      ok: true,
      recipientMsisdn: normaliseMsisdn(recipientRaw),
      amountCents,
      product: 'VOUCHER',
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
  const what =
    product === 'DATA' ? `${rands(amountCents)} of data`
    : product === 'VOUCHER' ? `a ${rands(amountCents)} WaPay voucher`
    : `${rands(amountCents)} airtime`;

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

/**
 * Build the in-session message that hands a claimed voucher gift to its
 * recipient. This is the ONE user-facing message that carries the FULL
 * voucher PIN — by design: the PIN is the gift. The caller must send it via
 * WhatsApp only and must never log it or store it in conversation history.
 *
 * @param {object} args
 * @param {string} [args.senderName]  - display name of the sender, if known
 * @param {number} args.amountCents   - voucher face value, integer cents
 * @param {string} args.pin           - the FULL voucher PIN (bearer secret)
 * @param {string} [args.serial]      - voucher serial number, if known
 * @returns {string} WhatsApp-ready text
 */
export function buildVoucherClaimMessage({ senderName, amountCents, pin, serial } = {}) {
  const who = (senderName && senderName.trim()) || 'Someone';
  const lines = [
    `🎁 ${who} sent you a ${rands(amountCents)} WaPay voucher!`,
    '',
    `Your voucher PIN: ${pin}`,
  ];
  if (serial) lines.push(`Serial: ${serial}`);
  lines.push(
    '',
    'How to use it:',
    '• Spend it online at any store that accepts OTT vouchers',
    '• Or cash it out at an OTT partner point (take it to your bank)',
    '',
    'Or reply BALANCE to open your own WaPay and use it right here.'
  );
  return lines.join('\n');
}

/** Show only the last 3 digits of a number in recipient-facing copy. */
export function maskMsisdn(raw = '') {
  const m = normaliseMsisdn(raw);
  if (!m || m.length < 4) return '';
  return `${m.slice(0, 3)}•••${m.slice(-3)}`;
}
