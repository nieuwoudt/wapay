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
 * Validate SA MSISDN, allowing Blu QA whitelisted numbers.
 */
export function isValidSaMsisdn(raw = '') {
  const msisdn = normaliseMsisdn(raw);

  if (!msisdn) return false;
  if (BLU_QA_TEST_NUMBERS.has(msisdn)) return true;

  return SA_MSISDN_REGEX.test(msisdn);
}

