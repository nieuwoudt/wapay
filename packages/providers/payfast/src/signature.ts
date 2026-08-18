/**
 * PayFast MD5 signing — ported near-verbatim from UniFuel's battle-tested
 * src/lib/payfast/signature.ts (live since March 2026).
 *
 * THE hard-won lesson (UniFuel docs/known-issues.md §1, 15-17 Mar 2026):
 * PayFast INCLUDES empty parameter values in its INBOUND ITN signature
 * computation. Filtering them out with `value !== ''` broke every real
 * payment for 2 days — ITN fields like custom_str2, custom_int1, name_last,
 * item_description arrive as empty strings and MUST appear as `key=` in the
 * signature string. Only exclude the 'signature' key itself.
 *
 * The asymmetry: OUTBOUND checkout signing strips empty fields BEFORE
 * signing (see checkout.ts) — the stripping there means the signed set and
 * the posted set are identical, which is what PayFast verifies. Never move
 * that strip into this function.
 */
import crypto from 'node:crypto';

/**
 * URL-encode a single value exactly the way PayFast expects in signature
 * base strings: trim, encodeURIComponent, then spaces as '+' (form-encoding
 * semantics, `%20` -> `+`). This is the exact encoding UniFuel verified
 * against real ITN traffic ("Approach 5" in the incident write-up).
 * @param {string} value Raw value (null/undefined coerced to '').
 * @returns {string} PayFast-encoded value.
 */
export function pfEncode(value: string | null | undefined): string {
  return encodeURIComponent((value ?? '').trim()).replace(/%20/g, '+');
}

/**
 * Build the `key=value&...` parameter string PayFast signs, from ALL entries
 * (INCLUDING empty values) in the object's insertion order, excluding only
 * the 'signature' key. Exported so checkout.ts can emit a GET query string
 * that is byte-identical to the string that was signed.
 * @param {Record<string,string>} data Parameters in wire order.
 * @returns {string} The signature base string (without passphrase).
 */
export function buildParamString(data: Record<string, string>): string {
  return Object.entries(data)
    .filter(([key]) => key !== 'signature')
    .map(([key, value]) => `${key}=${pfEncode(value)}`)
    .join('&');
}

/**
 * Generate a PayFast MD5 signature from payment parameters.
 *
 * Steps per PayFast docs (and verified against real ITN traffic):
 * 1. Collect all parameters (excluding 'signature'), INCLUDING empty values
 * 2. URL-encode the values (%20 -> +)
 * 3. Concatenate as key=value pairs joined by & in the order given
 * 4. Append passphrase if non-empty (also PayFast-encoded)
 * 5. MD5 hash the result
 *
 * @param {Record<string,string>} data Parameters in wire order.
 * @param {string} [passphrase] Merchant passphrase; appended when non-empty.
 * @returns {string} Lowercase hex MD5 signature.
 */
export function generateSignature(
  data: Record<string, string>,
  passphrase?: string
): string {
  // Build parameter string from ALL values (including empty), excluding 'signature'.
  // PayFast includes empty fields in the signature computation — see module doc.
  const paramString = buildParamString(data);

  // Append passphrase if provided and non-empty
  const stringToHash = passphrase
    ? `${paramString}&passphrase=${pfEncode(passphrase)}`
    : paramString;

  return crypto.createHash('md5').update(stringToHash).digest('hex');
}

/**
 * Verify a PayFast ITN signature against the received data.
 * Params MUST be passed in received (wire) order with empty values intact —
 * use parseItnBody() from ./itn.js on the raw form body.
 * @param {Record<string,string>} receivedData ITN params including 'signature'.
 * @param {string} [passphrase] Merchant passphrase.
 * @returns {boolean} true when the signature matches.
 */
export function verifySignature(
  receivedData: Record<string, string>,
  passphrase?: string
): boolean {
  const receivedSignature = receivedData.signature;
  if (!receivedSignature) return false;

  // Standard — params in received order, URL-encoded, including empty values
  const expectedSignature = generateSignature(receivedData, passphrase);
  if (receivedSignature === expectedSignature) return true;

  // Structured debug log for investigation (never log the passphrase itself)
  console.error('[PayFast] signature mismatch', {
    received: receivedSignature,
    computed: expectedSignature,
    passphrase_set: !!passphrase,
    passphrase_length: passphrase?.length ?? 0,
    param_keys: Object.keys(receivedData).filter((k) => k !== 'signature'),
  });

  return false;
}
