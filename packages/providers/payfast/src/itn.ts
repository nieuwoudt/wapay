/**
 * PayFast ITN (Instant Transaction Notification) verification — ported from
 * UniFuel's live src/lib/payfast/itn.ts with WaPay hardening:
 * - source-IP allowlist REJECTS by default (UniFuel only warned; here it is
 *   a config flag `enforceSourceIp` defaulting to true)
 * - no process.env reads; passphrase/sandbox/amount are explicit params
 * - injectable fetch for tests (no live network calls in tests)
 * - amount check is an exact rand-STRING compare via centsToRand (no floats)
 *
 * INBOUND signing rule (UniFuel docs/known-issues.md §1): the ITN signature
 * is computed over ALL received params INCLUDING empty-valued ones, in
 * received order, excluding only 'signature'. Filtering empties broke every
 * payment for 2 days in March 2026. See signature.ts.
 *
 * Idempotency note: PayFast redelivers ITNs. verifyItn() is pure
 * verification — replay safety belongs to the caller posting to the ledger
 * with a deterministic idemKey (lib/ledger-post.js postEntry).
 */
import { verifySignature } from './signature.js';
import { centsToRand } from './checkout.js';

/** PayFast server IP ranges for ITN source verification. */
export const PAYFAST_ITN_CIDRS: readonly string[] = [
  '197.97.145.144/28',
  '41.74.179.192/27',
];

/** PayFast server-side validation endpoints (step 5 POST-back). */
export const PAYFAST_VALIDATE_URLS = {
  live: 'https://www.payfast.co.za/eng/query/validate',
  sandbox: 'https://sandbox.payfast.co.za/eng/query/validate',
} as const;

/**
 * Minimal structural fetch type so tests can stub the POST-back without
 * depending on DOM lib typings. Compatible with global fetch (Node >= 18).
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  }
) => Promise<{ text(): Promise<string> }>;

/** Machine-readable failure reasons, in pipeline order. */
export type ItnFailureReason =
  | 'INVALID_SIGNATURE'
  | 'SOURCE_IP_REJECTED'
  | 'AMOUNT_MISMATCH'
  | 'PAYMENT_NOT_COMPLETE'
  | 'SERVER_VALIDATION_FAILED';

/** Result of verifyItn: ok, or a stable reason for the first failing step. */
export interface ItnVerdict {
  ok: boolean;
  reason?: ItnFailureReason;
}

/** Input for verifyItn. */
export interface VerifyItnParams {
  /** ITN params in received wire order, empty values intact (use parseItnBody). */
  params: Record<string, string>;
  /** Requesting IP (x-forwarded-for first hop / socket address). */
  sourceIp: string;
  /** Merchant passphrase; must match the checkout-side configuration. */
  passphrase?: string;
  /** true -> validate against sandbox.payfast.co.za, false -> live. */
  sandbox: boolean;
  /** The amount we expect for this payment, in integer CENTS. */
  expectedAmountCents: number;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /**
   * Reject ITNs from IPs outside PayFast's published ranges. Defaults to
   * TRUE (enforce) — UniFuel's warn-only stance was a deliberate soft-launch
   * choice, not a best practice. Set false only for local tunnel debugging.
   */
  enforceSourceIp?: boolean;
}

/**
 * Parse the raw ITN request body (application/x-www-form-urlencoded) into an
 * ordered param record. Preserves received order and empty values — both are
 * REQUIRED for signature verification.
 * @param {string} body Raw request body text.
 * @returns {Record<string,string>} Params in wire order.
 */
export function parseItnBody(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const data: Record<string, string> = {};
  params.forEach((value, key) => {
    data[key] = value;
  });
  return data;
}

/**
 * Parse a dotted-quad IPv4 address into a uint32, or null when malformed.
 */
function ipv4ToUint32(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  let out = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    out = (out << 8) | octet;
  }
  return out >>> 0;
}

/**
 * True when `ip` (dotted-quad IPv4) falls inside `cidr` ('a.b.c.d/prefix').
 * Pure mask math — no expanded IP tables to drift out of sync.
 * @param {string} ip Candidate IPv4 address.
 * @param {string} cidr CIDR block.
 * @returns {boolean} Membership.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  const ipN = ipv4ToUint32(ip);
  const baseN = ipv4ToUint32(base ?? '');
  if (ipN === null || baseN === null) return false;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
  return ((ipN & mask) >>> 0) === ((baseN & mask) >>> 0);
}

/**
 * Check whether an IP is inside PayFast's published ITN ranges.
 * Strips the IPv6-mapped prefix ('::ffff:1.2.3.4') Node sockets produce.
 * @param {string} ip Source IP as observed by the webhook.
 * @returns {boolean} true when the IP is a known PayFast server.
 */
export function isPayfastIp(ip: string): boolean {
  const cleanIp = (ip ?? '').replace('::ffff:', '').trim();
  return PAYFAST_ITN_CIDRS.some((cidr) => ipInCidr(cleanIp, cidr));
}

/**
 * Full ITN verification pipeline (UniFuel's 5 steps, hardened):
 * 1. Signature check — empty fields INCLUDED (known-issues §1)
 * 2. Source-IP allowlist — REJECT on miss (flag-controlled, default enforce)
 * 3. amount_gross === expected amount (exact rand-string compare)
 * 4. payment_status === 'COMPLETE'
 * 5. Server POST-back of all non-signature fields to /eng/query/validate,
 *    expecting the literal body 'VALID'
 *
 * Steps run in order; the verdict carries the FIRST failure's reason.
 * @param {VerifyItnParams} input Verification input.
 * @returns {Promise<ItnVerdict>} {ok:true} or {ok:false, reason}.
 */
export async function verifyItn(input: VerifyItnParams): Promise<ItnVerdict> {
  const {
    params,
    sourceIp,
    passphrase,
    sandbox,
    expectedAmountCents,
    fetchImpl,
    enforceSourceIp = true,
  } = input;

  const logCtx = {
    m_payment_id: params.m_payment_id,
    pf_payment_id: params.pf_payment_id,
    sandbox,
  };

  // 1. Verify signature (empty-valued fields INCLUDED — see signature.ts)
  if (!verifySignature(params, passphrase || undefined)) {
    console.error('[PayFast] ITN rejected: invalid signature', logCtx);
    return { ok: false, reason: 'INVALID_SIGNATURE' };
  }

  // 2. Verify source IP against PayFast's published ranges
  if (!isPayfastIp(sourceIp)) {
    if (enforceSourceIp) {
      console.error('[PayFast] ITN rejected: source IP outside PayFast ranges', {
        ...logCtx,
        source_ip: sourceIp,
        allowed_cidrs: PAYFAST_ITN_CIDRS,
      });
      return { ok: false, reason: 'SOURCE_IP_REJECTED' };
    }
    console.warn('[PayFast] ITN from unexpected IP (enforcement disabled)', {
      ...logCtx,
      source_ip: sourceIp,
    });
  }

  // 3. Verify amount — exact rand-string compare, no float math
  const expectedAmountRands = centsToRand(expectedAmountCents);
  if (params.amount_gross !== expectedAmountRands) {
    console.error('[PayFast] ITN rejected: amount mismatch', {
      ...logCtx,
      expected: expectedAmountRands,
      received: params.amount_gross,
    });
    return { ok: false, reason: 'AMOUNT_MISMATCH' };
  }

  // 4. Verify payment status
  if (params.payment_status !== 'COMPLETE') {
    console.error('[PayFast] ITN rejected: payment not complete', {
      ...logCtx,
      payment_status: params.payment_status,
    });
    return { ok: false, reason: 'PAYMENT_NOT_COMPLETE' };
  }

  // 5. Server confirmation (POST all non-signature fields back to PayFast)
  const serverValid = await confirmWithPayfast(params, sandbox, fetchImpl);
  if (!serverValid) {
    console.error('[PayFast] ITN rejected: server validation failed', logCtx);
    return { ok: false, reason: 'SERVER_VALIDATION_FAILED' };
  }

  console.log('[PayFast] ITN verified', {
    ...logCtx,
    amount_gross: params.amount_gross,
    source_ip: sourceIp,
  });
  return { ok: true };
}

/**
 * POST the ITN data (minus 'signature') back to PayFast for server-side
 * confirmation. Returns true only for the literal response body 'VALID'.
 */
async function confirmWithPayfast(
  data: Record<string, string>,
  sandbox: boolean,
  fetchImpl?: FetchLike
): Promise<boolean> {
  const validateUrl = sandbox ? PAYFAST_VALIDATE_URLS.sandbox : PAYFAST_VALIDATE_URLS.live;
  const doFetch: FetchLike = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  try {
    const params = new URLSearchParams();
    Object.entries(data).forEach(([key, value]) => {
      if (key !== 'signature') {
        params.append(key, value);
      }
    });

    const response = await doFetch(validateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const responseText = await response.text();
    return responseText.trim() === 'VALID';
  } catch (error) {
    console.error('[PayFast] server confirmation failed', {
      validate_url: validateUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
