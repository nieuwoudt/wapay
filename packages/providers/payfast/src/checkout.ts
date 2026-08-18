/**
 * PayFast hosted-checkout builder — ported from UniFuel's live
 * src/lib/payfast/checkout.ts, reshaped for WaPay:
 * - config is passed in explicitly (no process.env reads in the package)
 * - amounts are integer CENTS, converted to rand strings with exact string
 *   math (never float division/multiplication)
 * - adds buildCheckoutUrl() — a signed GET URL for WhatsApp, where we can't
 *   render an auto-submitting <form>.
 *
 * OUTBOUND signing rule (the other half of the known-issues §1 asymmetry):
 * strip empty-valued fields BEFORE signing, then sign the survivors in wire
 * order. PayFast verifies the signature over exactly the fields it receives,
 * so the signed set and the posted set must be identical. INBOUND ITN
 * verification is the opposite — empty fields are INCLUDED (see itn.ts).
 *
 * GET-URL signing note: PayFast accepts a signed GET to /eng/process with
 * the same parameters as the POST form — the signing algorithm is IDENTICAL
 * (same field order, same %20->+ encoding, same passphrase append). The only
 * extra requirement is that the query string on the wire must decode to
 * exactly the values that were signed. We guarantee that by serialising the
 * query with the very same encoder used for the signature base string
 * (pfEncode), NOT URLSearchParams (whose encoding of ! ' ( ) * ~ differs and
 * would still decode identically, but byte-identical wire==signed is the
 * conservative, debuggable choice). '+' in a query string decodes as a space
 * under form-encoding rules, matching what was signed.
 */
import { buildParamString, generateSignature } from './signature.js';

/** PayFast hosted process endpoints (POST form action / GET URL base). */
export const PAYFAST_PROCESS_URLS = {
  live: 'https://www.payfast.co.za/eng/process',
  sandbox: 'https://sandbox.payfast.co.za/eng/process',
} as const;

/** Input for buildCheckout / buildCheckoutUrl. All money in integer cents. */
export interface PayfastCheckoutParams {
  /** PayFast merchant_id (e.g. sandbox '10000100'). */
  merchantId: string;
  /** PayFast merchant_key. */
  merchantKey: string;
  /** Merchant passphrase; MUST match the PayFast dashboard setting (or be unset in both). */
  passphrase?: string;
  /** true -> sandbox.payfast.co.za, false -> www.payfast.co.za. */
  sandbox: boolean;
  /** Amount to charge in integer CENTS (5000 -> '50.00' on the wire). */
  amountCents: number;
  /** Our payment reference, echoed back in the ITN as m_payment_id. */
  mPaymentId: string;
  /** Item name shown on the PayFast payment page. */
  itemName: string;
  /** Browser return URL after successful payment. */
  returnUrl: string;
  /** Browser return URL after cancelled payment. */
  cancelUrl: string;
  /** Server-to-server ITN webhook URL. */
  notifyUrl: string;
  /** Optional pass-through (UniFuel used it for the order id); echoed in the ITN. */
  customStr1?: string;
}

/** Hosted-form output: POST `fields` to `url` (auto-submitting form). */
export interface PayfastCheckoutForm {
  /** The form action (process endpoint for the chosen environment). */
  url: string;
  /** All form fields including the computed 'signature'. */
  fields: Record<string, string>;
}

/**
 * Format integer cents as PayFast's decimal rand string (5000 -> '50.00').
 * Exact string math — no float division.
 * @param {number} cents Integer cents (may be negative for fee fields).
 * @returns {string} Rand string with exactly 2 decimals.
 */
export function centsToRand(cents: number): string {
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`centsToRand requires an integer cents value, got: ${cents}`);
  }
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Parse a PayFast decimal rand amount ('50.00', '-2.30', '1000') into
 * integer cents with EXACT string math — no float multiplication.
 * Throws on malformed input or non-zero sub-cent precision.
 * @param {string|number} value Rand amount as PayFast sends it.
 * @returns {number} Integer cents.
 */
export function randToCents(value: string | number): number {
  const s = String(value).trim();
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) {
    throw new Error(`Invalid rand amount from PayFast: "${s}"`);
  }
  const sign = m[1] === '-' ? -1 : 1;
  const intPart = m[2];
  const decPart = m[3] ?? '';
  if (decPart.length > 2 && /[1-9]/.test(decPart.slice(2))) {
    throw new Error(`Sub-cent rand amount not representable: "${s}"`);
  }
  const centsPart = (decPart + '00').slice(0, 2);
  const cents = Number(intPart) * 100 + Number(centsPart);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`Rand amount out of safe range: "${s}"`);
  }
  return sign * cents;
}

/**
 * Build the signed field set shared by the POST-form and GET-URL flavours.
 * Fields are assembled in PayFast's documented attribute order (merchant
 * block, URLs, transaction block, custom block — same order UniFuel uses),
 * empty values are stripped BEFORE signing, and the signature is computed
 * over the survivors in that order.
 */
function buildSignedFields(params: PayfastCheckoutParams): {
  action: string;
  cleanFields: Record<string, string>;
  signature: string;
} {
  if (!Number.isSafeInteger(params.amountCents) || params.amountCents <= 0) {
    throw new Error(`buildCheckout requires positive integer amountCents, got: ${params.amountCents}`);
  }

  const action = params.sandbox ? PAYFAST_PROCESS_URLS.sandbox : PAYFAST_PROCESS_URLS.live;
  const amountInRands = centsToRand(params.amountCents);

  // Build fields in the exact order PayFast expects (UniFuel's proven order,
  // minus the buyer-detail fields WaPay doesn't collect)
  const fields: Record<string, string> = {
    merchant_id: params.merchantId,
    merchant_key: params.merchantKey,
    return_url: params.returnUrl,
    cancel_url: params.cancelUrl,
    notify_url: params.notifyUrl,
    m_payment_id: params.mPaymentId,
    amount: amountInRands,
    item_name: params.itemName,
    custom_str1: params.customStr1 ?? '',
  };

  // Remove empty values before signing — OUTBOUND ONLY (see module doc)
  const cleanFields = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== '')
  );

  const signature = generateSignature(cleanFields, params.passphrase || undefined);

  console.log('[PayFast] checkout built', {
    sandbox: params.sandbox,
    m_payment_id: params.mPaymentId,
    amount: amountInRands,
    field_keys: Object.keys(cleanFields),
    passphrase_set: !!params.passphrase,
  });

  return { action, cleanFields, signature };
}

/**
 * Generate PayFast hosted-form data for redirect checkout (auto-submitting
 * POST form). Amount is converted from integer cents to a rand string.
 * @param {PayfastCheckoutParams} params Checkout parameters.
 * @returns {PayfastCheckoutForm} {url, fields} — POST fields to url.
 */
export function buildCheckout(params: PayfastCheckoutParams): PayfastCheckoutForm {
  const { action, cleanFields, signature } = buildSignedFields(params);
  return {
    url: action,
    fields: { ...cleanFields, signature },
  };
}

/**
 * Generate a signed, GET-able PayFast checkout URL — for WhatsApp, where we
 * send a tappable link instead of rendering a form. PayFast accepts signed
 * GET requests to /eng/process with the same parameters and the SAME signing
 * algorithm as the POST form (no algorithm difference found deriving from
 * UniFuel's form flow; see module doc for the wire-encoding guarantee).
 * @param {PayfastCheckoutParams} params Checkout parameters.
 * @returns {string} Fully signed URL suitable for a chat message.
 */
export function buildCheckoutUrl(params: PayfastCheckoutParams): string {
  const { action, cleanFields, signature } = buildSignedFields(params);
  // Serialise with the SAME encoder used for the signature base string so the
  // query string on the wire is byte-identical to what was signed.
  const query = buildParamString(cleanFields);
  return `${action}?${query}&signature=${signature}`;
}
