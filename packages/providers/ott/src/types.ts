/**
 * OTT Mobile voucher ISSUING API types.
 *
 * Source of truth: "OTT_Issuing API Rest v6" (OTT Mobile Technologies).
 * All endpoints live under {base}/api/reseller/v1/ and are called with
 * HTTP POST + application/x-www-form-urlencoded (never JSON).
 *
 * All money in WaPay is integer cents. OTT speaks decimal rand STRINGS
 * ("996.70", "-3.30") or JSON numbers (10.0000) — this package converts at
 * the boundary via randToCents/centsToRand (exact string math, no floats).
 */

/** Constructor configuration. Every field falls back to its env var. */
export interface OttClientConfig {
  /** Overrides OTT_BASE_URL (test: https://test-api.ott-mobile.com). */
  baseUrl?: string;
  /** Overrides OTT_API_USERNAME (HTTP Basic auth user, required on every call). */
  username?: string;
  /** Overrides OTT_API_PASSWORD (HTTP Basic auth password). */
  password?: string;
  /** Overrides OTT_API_KEY (used ONLY to hash request params — never sent as a field). */
  apiKey?: string;
  /** Request timeout in ms for headers + body (default 30000). */
  timeoutMs?: number;
}

/**
 * Parameters for GetVoucher (/api/reseller/v1/GetVoucher).
 *
 * Per the spec, required form variables are: branch, cashier,
 * uniqueReference, value, vendorCode. Optional: mobileForSMS, till.
 *
 * uniqueReference uniqueness is the CALLER's responsibility — OTT does not
 * check it, and a non-unique reference can NOT be confirmed, rejected or
 * checked. Callers must derive it deterministically from their idemKey
 * (e.g. `ott-${idemKey}`) so a crashed flow can recover via checkVoucher.
 */
export interface OttGetVoucherParams {
  /** Branch code the voucher is sold from (varchar 50). */
  branch: string;
  /** Cashier name/code that sold the voucher (varchar 50). */
  cashier: string;
  /** Caller-unique reference (varchar 50). See uniqueness note above. */
  uniqueReference: string;
  /** Voucher value in integer CENTS (converted to a decimal rand string on the wire). */
  valueCents: number;
  /** Vendor code of the issuing entity (int; test env uses 11). */
  vendorCode: number;
  /** Optional cell phone number, may be used for SMS in future (varchar 20). */
  mobileForSMS?: string;
  /** Optional till point code dispensing the voucher (varchar 50). */
  till?: string;
}

/** Decoded voucher payload (GetVoucher/CheckVoucher `voucher` field, which arrives as a JSON string). */
export interface OttVoucher {
  voucherId: number;
  saleId: number;
  /** The voucher PIN the customer redeems. Treat as a secret; log masked only. */
  pin: string;
  serialNumber: string;
  batch: string;
  instructions: string;
  /** Voucher amount in integer CENTS (spec sends rand, e.g. 10.0000 => 1000). */
  amountCents: number;
  /** The uniqueReference this voucher was issued under (echo of our request). */
  uniqueReference: string;
}

/** GetBalance result, converted to integer cents. */
export interface OttBalance {
  balanceCents: number;
  availableBalanceCents: number;
}

/** Confirm/Reject result. */
export interface OttAckResult {
  /** OTT's human message, e.g. "Voucher Confirmed" / "Voucher Rejected". */
  message: string;
}

/**
 * Appendix A — GetVoucher error codes (body.errorCode on success:"false").
 * Attached to USER_INPUT errors as `.errorCode` so callers can branch.
 */
export const OTT_ERROR_CODES: Record<string, string> = {
  '1': 'An Error Occurred (System Error)',
  '2': 'Error Getting Voucher PIN Code',
  '3': 'Cannot Find a Matching Product for this value',
  '4': 'Cannot find the VAT chargeable',
  '5': 'Calculation Error',
  '6': 'You do not have sufficient funds',
  '7': 'Error Saving Data (Debit/Credit)',
  '8': 'An Error Occurred (System Error)',
  '9': 'An Error Occurred (System Error)',
};

/**
 * WaPay stringly error taxonomy used by OttClient (matches @wapay/providers-blu):
 * - 'AUTH'                   — HTTP 401 (bad Basic credentials). Not retryable.
 * - 'USER_INPUT'             — success !== 'true' or other 4xx. `.reason` carries
 *                              body.message, `.errorCode` the Appendix A code if present.
 * - 'RETRYABLE'              — HTTP 5xx or network failure. Safe to retry with backoff
 *                              (for GetVoucher, prefer a CheckVoucher probe first).
 * - 'TIMEOUT_CHECK_REQUIRED' — GetVoucher timed out. Do NOT retry GetVoucher (spec is
 *                              explicit); call checkVoucher with `.uniqueReference`
 *                              (attached to the error) to learn the outcome.
 */
export type OttErrorKind = 'AUTH' | 'USER_INPUT' | 'RETRYABLE' | 'TIMEOUT_CHECK_REQUIRED';
