/**
 * @wapay/providers-payfast — PayFast card/EFT CHECKOUT + ITN rail.
 *
 * Ported near-verbatim from UniFuel.co's live PayFast integration
 * (src/lib/payfast/{signature,checkout,itn}.ts), including the hard-won
 * lesson from its docs/known-issues.md §1:
 *
 *   INBOUND ITN signature verification MUST include empty-valued fields
 *   (custom_str2, name_last, ... arrive as `key=` and are part of the hash);
 *   OUTBOUND checkout signing strips empty fields BEFORE signing.
 *   Getting that asymmetry backwards broke every real payment for 2 days.
 *
 * WaPay deltas from UniFuel:
 * - explicit config params instead of process.env reads
 * - integer-cents money with exact string conversion (randToCents/centsToRand)
 * - ITN source-IP allowlist REJECTS by default (flag `enforceSourceIp`)
 * - injectable fetch for the /eng/query/validate POST-back (testable offline)
 * - buildCheckoutUrl(): signed GET URL for WhatsApp (same signing algorithm
 *   as the POST form; the query string is emitted byte-identical to the
 *   signed base string)
 */
export {
  pfEncode,
  buildParamString,
  generateSignature,
  verifySignature,
} from './signature.js';
export {
  PAYFAST_PROCESS_URLS,
  buildCheckout,
  buildCheckoutUrl,
  centsToRand,
  randToCents,
  type PayfastCheckoutParams,
  type PayfastCheckoutForm,
} from './checkout.js';
export {
  PAYFAST_ITN_CIDRS,
  PAYFAST_VALIDATE_URLS,
  parseItnBody,
  ipInCidr,
  isPayfastIp,
  verifyItn,
  type FetchLike,
  type ItnFailureReason,
  type ItnVerdict,
  type VerifyItnParams,
} from './itn.js';
