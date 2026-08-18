import { createHash } from 'node:crypto';
import { maskVoucherPin, requireEnv } from '@wapay/utils';
import { request } from 'undici';
import {
  OTT_ERROR_CODES,
  type OttAckResult,
  type OttBalance,
  type OttClientConfig,
  type OttGetVoucherParams,
  type OttVoucher,
} from './types.js';

/**
 * OTT Mobile Voucher Client (ISSUING rail).
 *
 * Protocol (per "OTT_Issuing API Rest v6"):
 * - Every call is POST {base}/api/reseller/v1/{Endpoint} with
 *   application/x-www-form-urlencoded form variables (never JSON).
 * - Every call carries HTTP Basic auth (OTT_API_USERNAME:OTT_API_PASSWORD).
 * - Every call carries a 'hash' form field: SHA256 hex of the API key
 *   followed by each param VALUE concatenated in alphabetical order of the
 *   param NAME, with no separators (see hashParams).
 * - Success is HTTP 200/201 with body.success === 'true' (strings, not
 *   booleans). HTTP 201 with success 'false' is OTT's business-error shape.
 * - 401 = bad credentials (body may be empty). 500 = "try later".
 *
 * NOTE ON GetAPIKey: the spec also defines /api/reseller/v1/GetAPIKey.
 * This client deliberately implements and exports NOTHING for it — calling
 * GetAPIKey ROTATES the live API key server-side, which instantly
 * invalidates the stored OTT_API_KEY credential and breaks every
 * subsequent hashed call from production. Key management happens on the
 * OTT online portal by a human, never from code. Do not add it.
 *
 * Environment Variables:
 * - OTT_BASE_URL:     API base URL (test: https://test-api.ott-mobile.com)
 * - OTT_API_USERNAME: Basic auth username (issued by OTT)
 * - OTT_API_PASSWORD: Basic auth password
 * - OTT_API_KEY:      hashing key (generated on the OTT portal)
 */
export class OttClient {
  private base: string;
  private user: string;
  private pass: string;
  private apiKey: string;
  private timeoutMs: number;

  constructor(config: OttClientConfig = {}) {
    this.base = (config.baseUrl ?? requireEnv('OTT_BASE_URL')).replace(/\/+$/, '');
    this.user = config.username ?? requireEnv('OTT_API_USERNAME');
    this.pass = config.password ?? requireEnv('OTT_API_PASSWORD');
    this.apiKey = config.apiKey ?? requireEnv('OTT_API_KEY');
    this.timeoutMs = config.timeoutMs ?? 30000;

    console.log('[OTT] Initialized', {
      baseUrl: this.base,
      username: this.user,
      apiKey: this.apiKey ? `...${this.apiKey.slice(-4)}` : 'MISSING',
      timeoutMs: this.timeoutMs,
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * GetBalance — current balance and available balance, in integer cents.
   * @param uniqueReference Any valid string reference (varchar 50); defaults
   *   to a generated one since GetBalance has no idempotency semantics.
   */
  async getBalance(uniqueReference?: string): Promise<OttBalance> {
    const ref = uniqueReference ?? `bal-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const body = await this.post('GetBalance', { uniqueReference: ref });
    const balance: OttBalance = {
      balanceCents: randToCents(body.balance),
      availableBalanceCents: randToCents(body.availableBalance),
    };
    console.log('[OTT] GetBalance success', { uniqueReference: ref, ...balance });
    return balance;
  }

  /**
   * GetVoucher — issue a single voucher PIN for the given value.
   *
   * uniqueReference uniqueness is the CALLER's responsibility (OTT does not
   * check it; non-unique references cannot be confirmed/rejected/checked).
   * Derive it deterministically from your idemKey.
   *
   * ON TIMEOUT DO NOT RETRY: the spec is explicit. A timeout throws
   * Error('TIMEOUT_CHECK_REQUIRED') with `.uniqueReference` attached — call
   * checkVoucher(uniqueReference) to learn whether the voucher was issued.
   */
  async getVoucher(params: OttGetVoucherParams): Promise<OttVoucher> {
    const form: Record<string, string> = {
      branch: params.branch,
      cashier: params.cashier,
      uniqueReference: params.uniqueReference,
      value: centsToRand(params.valueCents),
      vendorCode: String(params.vendorCode),
    };
    if (params.mobileForSMS !== undefined) form.mobileForSMS = params.mobileForSMS;
    if (params.till !== undefined) form.till = params.till;

    console.log('[OTT] GetVoucher request', {
      uniqueReference: params.uniqueReference,
      valueCents: params.valueCents,
      branch: params.branch,
      cashier: params.cashier,
      vendorCode: params.vendorCode,
    });

    let body: any;
    try {
      body = await this.post('GetVoucher', form, { timeoutAsMarker: true });
    } catch (e: any) {
      if (e?.message === 'TIMEOUT') {
        // Spec: never retry GetVoucher after a timeout — the voucher may have
        // been issued and debited. Caller must probe with checkVoucher.
        const err = new Error('TIMEOUT_CHECK_REQUIRED');
        (err as any).uniqueReference = params.uniqueReference;
        console.error('[OTT] GetVoucher timeout — CheckVoucher required', {
          uniqueReference: params.uniqueReference,
        });
        throw err;
      }
      throw e;
    }

    let voucher: OttVoucher;
    try {
      voucher = this.parseVoucher(body, params.uniqueReference);
    } catch {
      // success === 'true' but an unreadable voucher payload: the voucher was
      // (probably) issued, so treat like a timeout — recover via checkVoucher.
      const err = new Error('TIMEOUT_CHECK_REQUIRED');
      (err as any).uniqueReference = params.uniqueReference;
      console.error('[OTT] GetVoucher unparseable success body — CheckVoucher required', {
        uniqueReference: params.uniqueReference,
      });
      throw err;
    }

    console.log('[OTT] GetVoucher success', {
      uniqueReference: params.uniqueReference,
      voucherId: voucher.voucherId,
      saleId: voucher.saleId,
      pin: maskVoucherPin(voucher.pin),
      serialNumber: voucher.serialNumber,
      amountCents: voucher.amountCents,
    });
    return voucher;
  }

  /**
   * CheckVoucher — fetch the voucher issued under a previous GetVoucher
   * uniqueReference. THE recovery path after a GetVoucher timeout.
   */
  async checkVoucher(uniqueReference: string): Promise<OttVoucher> {
    const body = await this.post('CheckVoucher', { uniqueReference });
    let voucher: OttVoucher;
    try {
      voucher = this.parseVoucher(body, uniqueReference);
    } catch {
      // Unlike getVoucher, a bad payload here is safely re-checkable.
      throw new Error('RETRYABLE');
    }
    console.log('[OTT] CheckVoucher success', {
      uniqueReference,
      voucherId: voucher.voucherId,
      pin: maskVoucherPin(voucher.pin),
      amountCents: voucher.amountCents,
    });
    return voucher;
  }

  /** ConfirmVoucher — acknowledge successful receipt of a GetVoucher result. */
  async confirmVoucher(uniqueReference: string): Promise<OttAckResult> {
    const body = await this.post('ConfirmVoucher', { uniqueReference });
    const result = { message: String(body.message ?? 'Voucher Confirmed') };
    console.log('[OTT] ConfirmVoucher success', { uniqueReference, ...result });
    return result;
  }

  /** RejectVoucher — reject a voucher received from GetVoucher (reverses the sale). */
  async rejectVoucher(uniqueReference: string): Promise<OttAckResult> {
    const body = await this.post('RejectVoucher', { uniqueReference });
    const result = { message: String(body.message ?? 'Voucher Rejected') };
    console.log('[OTT] RejectVoucher success', { uniqueReference, ...result });
    return result;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * POST a form-encoded call and return the parsed success body.
   * Throws the WaPay taxonomy: 'AUTH' (401), 'USER_INPUT' (success!=='true'
   * or 4xx, with .reason/.errorCode), 'RETRYABLE' (5xx/network/timeout).
   * With timeoutAsMarker (GetVoucher only), timeouts throw the internal
   * marker 'TIMEOUT' so the caller can remap to TIMEOUT_CHECK_REQUIRED.
   */
  private async post(
    endpoint: string,
    params: Record<string, string>,
    opts: { timeoutAsMarker?: boolean } = {},
  ): Promise<any> {
    const url = `${this.base}/api/reseller/v1/${endpoint}`;
    const form = new URLSearchParams(params);
    form.append('hash', hashParams(params, this.apiKey));
    const basic = Buffer.from(`${this.user}:${this.pass}`).toString('base64');

    let res;
    try {
      res = await request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basic}`,
        },
        body: form.toString(),
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
      });
    } catch (e: any) {
      if (isTimeoutError(e)) {
        console.error('[OTT] Request timeout', { endpoint, error: e?.message || e });
        throw new Error(opts.timeoutAsMarker ? 'TIMEOUT' : 'RETRYABLE');
      }
      console.error('[OTT] Network error', { endpoint, error: e?.message || e });
      throw new Error('RETRYABLE');
    }

    // 401 = bad Basic credentials; body is empty or plain "Authentication Failed".
    if (res.statusCode === 401) {
      await res.body.text().catch(() => '');
      console.error('[OTT] Auth failed (401)', { endpoint });
      throw new Error('AUTH');
    }

    let body: any;
    let rawText = '';
    try {
      rawText = await res.body.text();
      body = rawText ? JSON.parse(rawText) : undefined;
    } catch (e: any) {
      if (isTimeoutError(e)) {
        console.error('[OTT] Body timeout', { endpoint, error: e?.message || e });
        throw new Error(opts.timeoutAsMarker ? 'TIMEOUT' : 'RETRYABLE');
      }
      body = undefined;
    }

    if (res.statusCode >= 500) {
      console.error('[OTT] Server error', {
        endpoint,
        statusCode: res.statusCode,
        message: body?.message,
      });
      throw new Error('RETRYABLE');
    }

    // Success convention: HTTP 200/201 AND success === 'true' (string).
    if ((res.statusCode === 200 || res.statusCode === 201) && body?.success === 'true') {
      return body;
    }

    // Everything else (success:'false' business errors, other 4xx) is USER_INPUT.
    const errorCode = body?.errorCode !== undefined ? String(body.errorCode) : undefined;
    const reason =
      (typeof body?.message === 'string' && body.message.trim()) ||
      (errorCode && OTT_ERROR_CODES[errorCode]) ||
      (rawText && rawText.slice(0, 200)) ||
      `OTT returned HTTP ${res.statusCode}`;
    console.error('[OTT] Call rejected', {
      endpoint,
      statusCode: res.statusCode,
      errorCode,
      reason,
    });
    const err = new Error('USER_INPUT');
    (err as any).reason = reason;
    if (errorCode !== undefined) (err as any).errorCode = errorCode;
    throw err;
  }

  /** Decode the `voucher` field (a JSON-encoded string per the spec) into an OttVoucher. */
  private parseVoucher(body: any, uniqueReference: string): OttVoucher {
    const raw = typeof body?.voucher === 'string' ? JSON.parse(body.voucher) : body?.voucher;
    if (!raw || typeof raw !== 'object' || raw.pin === undefined) {
      throw new Error(`OTT voucher payload missing pin for ${uniqueReference}`);
    }
    return {
      voucherId: Number(raw.voucherID),
      saleId: Number(raw.saleID),
      pin: String(raw.pin),
      serialNumber: String(raw.serialNumber ?? ''),
      batch: String(raw.batch ?? ''),
      instructions: String(raw.instructions ?? ''),
      amountCents: randToCents(raw.amount),
      uniqueReference,
    };
  }
}

// -----------------------------------------------------------------------------
// Pure helpers (exported for tests and callers)
// -----------------------------------------------------------------------------

/**
 * Compute OTT's request hash for a set of form params.
 *
 * Per the spec: start with the API key, then concatenate each param VALUE
 * (values only — never the names) in alphabetical order of the param NAME,
 * with no separators, and take the SHA256 hex digest.
 *
 * Doc example: key ace4e782-e953-45d5-9f2a-aa1498c830ed + VendorID=11 +
 * VoucherPin=123456789012 hashes
 * 'ace4e782-e953-45d5-9f2a-aa1498c830ed11123456789012' to
 * c399a3964ec6d7e3e7804fa56d14c78e2a1a880c1a702127d96a790ec6332bf0.
 *
 * The 'hash' field itself is never included in the hash input.
 */
export function hashParams(params: Record<string, string>, apiKey: string): string {
  const concatenated = Object.keys(params)
    .sort()
    .map((name) => params[name])
    .join('');
  return createHash('sha256').update(apiKey + concatenated).digest('hex');
}

const TIMEOUT_ERROR_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** True when an undici/network error represents a timeout (request outcome unknown). */
function isTimeoutError(e: any): boolean {
  return (
    TIMEOUT_ERROR_CODES.has(e?.code) ||
    e?.name === 'HeadersTimeoutError' ||
    e?.name === 'BodyTimeoutError' ||
    e?.name === 'ConnectTimeoutError' ||
    e?.name === 'AbortError'
  );
}

/**
 * Parse an OTT decimal rand amount ('996.70', '-3.30', '1000', 10.0000) into
 * integer cents with EXACT string math — no float multiplication.
 * Throws on malformed input or sub-cent precision that isn't all zeros.
 */
export function randToCents(value: string | number): number {
  const s = String(value).trim();
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) {
    throw new Error(`Invalid rand amount from OTT: "${s}"`);
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

/** Format integer cents as OTT's decimal rand string (1000 -> '10.00'). */
export function centsToRand(cents: number): string {
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`centsToRand requires an integer cents value, got: ${cents}`);
  }
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
