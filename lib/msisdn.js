/**
 * MSISDN utilities for South African mobile numbers.
 * Centralises Blu QA allow-list, normalisation, and validation logic.
 */

// South African mobile number: 10 digits, starts with 0 then 6/7/8
export const SA_MSISDN_REGEX = /^0(6\d|7\d|8\d)\d{7}$/;

// Blu QA whitelisted MSISDNs provided by Blu support
export const BLU_QA_TEST_NUMBERS = new Set([
  '0840012300', // Cell C
  '0720012345', // Vodacom
  '0830012300', // MTN
  '0850012345', // Telkom
]);

/**
 * Normalise user-provided MSISDN.
 * - Strip non-digits
 * - Convert +27/27 prefixes to 0 while preserving leading zero for test numbers
 */
export function normaliseMsisdn(raw = '') {
  const input = typeof raw === 'string' ? raw : String(raw ?? '');
  const digits = input.replace(/\D/g, '');

  if (digits.startsWith('27') && digits.length === 11) {
    return `0${digits.slice(2)}`;
  }

  return digits;
}

/**
 * The WhatsApp identity form of a number: the 27-form Meta sends as `wa_id`
 * and the form `Account.waId` is stored in. `normaliseMsisdn` canonicalises
 * to the 0-form that the VAS rails want, so anything looking an account up
 * from a human-typed number needs this one line, and should not write its
 * own (2026-09-18).
 */
export function toWaId(raw = '') {
  const msisdn = normaliseMsisdn(raw);
  if (!msisdn) return '';
  return msisdn.startsWith('0') ? `27${msisdn.slice(1)}` : msisdn;
}

/**
 * Are we pointed at Blu's QA environment? On QA the rails only vend to the
 * four whitelisted numbers above; every other number comes back as a provider
 * rejection whose message blames the CUSTOMER'S number ("the network is
 * rejecting this phone number").
 *
 * The production evidence for this is unambiguous: the only airtime purchase
 * that has ever succeeded, on 2 January 2026, was to 0840012300. Every attempt
 * to a real number has failed, in January and again on 19 September 2026.
 * Knowing this lets us tell the customer the truth BEFORE we take their PIN
 * for something that cannot possibly complete.
 */
export function bluIsQa() {
  return /(^|\.)qa\./i.test(String(process.env.BLU_BASE_URL || ''));
}

/** Can this number actually be vended to on the credentials we hold right now? */
export function bluCanVendTo(raw = '') {
  if (!bluIsQa()) return true;
  return BLU_QA_TEST_NUMBERS.has(normaliseMsisdn(raw));
}

/**
 * Validate SA MSISDN, allowing Blu QA whitelisted numbers.
 */
export function isValidSaMsisdn(raw = '') {
  const msisdn = normaliseMsisdn(raw);

  if (!msisdn) return false;
  if (BLU_QA_TEST_NUMBERS.has(msisdn)) return true;

  return SA_MSISDN_REGEX.test(msisdn);
}

