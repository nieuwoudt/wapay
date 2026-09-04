/**
 * OTT Voucher REDEMPTION rail (spec: "OTT_Redemption API Rest v6", received
 * from Keamo 2026-09-04, summarised in docs/OTT_REDEMPTION_API.md).
 *
 * This is the CASH-IN counterpart to the issuing client: a customer holding
 * an OTT voucher PIN loads its value into their WaPay wallet. Redemption
 * today runs on Blu only; this adds the much larger OTT voucher network.
 *
 * Protocol (identical shape to the issuing rail, different path prefix):
 * - POST {base}/api/v1/{Endpoint}, application/x-www-form-urlencoded.
 * - HTTP Basic auth with the MERCHANT api credentials (distinct from the
 *   issuing credentials — different portal, different key).
 * - Every call carries `hash`: SHA256 hex of apiKey + each param VALUE
 *   concatenated in alphabetical order of param NAME (the issuing rule).
 * - Success is HTTP 200/201 AND body.success === 'true' (strings).
 *
 * ⚠️ GetAPIKey is DELIBERATELY NOT IMPLEMENTED. The redemption spec defines
 * /api/v1/GetAPIKey, and calling it ROTATES the live key server-side —
 * instantly breaking every deployed hash. Same trap as the issuing rail
 * (BUGLOG #8). Keys are managed by a human on the portal. Do not add it.
 *
 * MONEY SAFETY — the spec is explicit (page 13):
 *   "When a timeout occurs ... please do not retry the RemitVoucher, you
 *    must call the CheckRemitVoucher API using the unique reference"
 * So a timeout NEVER means failure. remitVoucher() surfaces
 * TIMEOUT_CHECK_REQUIRED and the caller must resolve it with
 * checkRemitVoucher() before crediting or refusing. Crediting a wallet on
 * an assumption is how customers get paid twice.
 *
 * PARTIAL REDEMPTION: RemitVoucher takes an `amount` (<= voucher value) and
 * returns voucherAmount (taken) + voucherBalance (left). OTT SMSes the
 * customer a link to re-vault any balance — that residual is OTT's to
 * handle, never a WaPay liability.
 *
 * BEARER SECRET: the voucher PIN is money. It is never logged (masked only),
 * never stored on a request row, and never returned to a caller.
 *
 * Env:
 *   OTT_MERCHANT_BASE_URL   (defaults to OTT_BASE_URL; live = same URL
 *                            without the "test-" prefix, per spec point 7)
 *   OTT_MERCHANT_API_USERNAME / _PASSWORD / _API_KEY
 *   OTT_VENDOR_CODE         (OTT-assigned vendor id; WaPay = 11)
 */

import { createHash } from 'crypto';

const DEFAULT_TIMEOUT_MS = 30000;

/** Mask a voucher PIN for logs: first 4, then the length. Never the value. */
export function maskPin(pin) {
  const s = String(pin || '');
  if (s.length <= 4) return '****';
  return `${s.slice(0, 4)}…[${s.length}-digits]`;
}

function log(type, data) {
  console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));
}

/**
 * OTT's request hash: apiKey followed by every param VALUE concatenated in
 * alphabetical order of the param NAME, SHA256 hex. The `hash` field itself
 * is never part of the input. (Same rule as the issuing rail — proven
 * against OTT's published golden vector.)
 */
export function hashParams(params, apiKey) {
  const concatenated = Object.keys(params)
    .sort()
    .map((name) => params[name])
    .join('');
  return createHash('sha256').update(apiKey + concatenated).digest('hex');
}

/**
 * Parse an OTT decimal rand amount into integer cents with EXACT string
 * math — no float multiplication on the money path. Mirrors randToCents in
 * the issuing client, including OTT's comma thousands grouping.
 */
export function randToCents(value) {
  let s = String(value).trim();
  if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/.test(s)) s = s.replace(/,/g, '');
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new Error(`Invalid rand amount from OTT: "${s}"`);
  const sign = m[1] === '-' ? -1 : 1;
  const decPart = m[3] ?? '';
  if (decPart.length > 2 && /[1-9]/.test(decPart.slice(2))) {
    throw new Error(`Sub-cent rand amount not representable: "${s}"`);
  }
  const cents = Number(m[2]) * 100 + Number((decPart + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) throw new Error(`Rand amount out of safe range: "${s}"`);
  return sign * cents;
}

/** Format integer cents as OTT's decimal rand string (1000 -> '10.00'). */
export function centsToRand(cents) {
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`centsToRand requires integer cents, got: ${cents}`);
  }
  return `${Math.trunc(cents / 100)}.${String(Math.abs(cents % 100)).padStart(2, '0')}`;
}

const TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function isTimeoutError(e) {
  return (
    TIMEOUT_CODES.has(e?.code) ||
    e?.name === 'HeadersTimeoutError' ||
    e?.name === 'BodyTimeoutError' ||
    e?.name === 'ConnectTimeoutError' ||
    e?.name === 'AbortError' ||
    e?.name === 'TimeoutError'
  );
}

export class OttRedemptionClient {
  /**
   * @param {object} [config]
   * @param {string} [config.baseUrl]  - defaults to OTT_MERCHANT_BASE_URL, then OTT_BASE_URL
   * @param {string} [config.username] @param {string} [config.password]
   * @param {string} [config.apiKey]   @param {number} [config.vendorId]
   * @param {number} [config.timeoutMs]
   */
  constructor(config = {}) {
    const req = (name, val) => {
      const v = val ?? process.env[name];
      if (!v) throw new Error(`Missing env ${name} (OTT Redemption)`);
      return v;
    };
    const base =
      config.baseUrl ?? process.env.OTT_MERCHANT_BASE_URL ?? process.env.OTT_BASE_URL;
    if (!base) throw new Error('Missing env OTT_MERCHANT_BASE_URL (OTT Redemption)');
    this.base = String(base).replace(/\/+$/, '');
    this.user = req('OTT_MERCHANT_API_USERNAME', config.username);
    this.pass = req('OTT_MERCHANT_API_PASSWORD', config.password);
    this.apiKey = req('OTT_MERCHANT_API_KEY', config.apiKey);
    this.vendorId = Number(config.vendorId ?? process.env.OTT_VENDOR_CODE ?? 11);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Identify the environment in logs without ever printing a credential.
    this.isLive = !/(^|\/\/)test-/.test(this.base);
  }

  /**
   * @param {string} endpoint
   * @param {Record<string,string>} params
   * @param {{timeoutAsMarker?: boolean}} [opts]
   */
  async post(endpoint, params, opts = {}) {
    const url = `${this.base}/api/v1/${endpoint}`;
    const form = new URLSearchParams(params);
    form.append('hash', hashParams(params, this.apiKey));
    const basic = Buffer.from(`${this.user}:${this.pass}`).toString('base64');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let resp;
    let rawText = '';
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basic}`,
        },
        body: form.toString(),
        signal: controller.signal,
      });
      rawText = await resp.text();
    } catch (e) {
      if (isTimeoutError(e)) {
        log('ott_redemption_timeout', { endpoint, live: this.isLive });
        throw new Error(opts.timeoutAsMarker ? 'TIMEOUT' : 'RETRYABLE');
      }
      log('ott_redemption_network_error', { endpoint, error: String(e?.message || e).slice(0, 120) });
      throw new Error('RETRYABLE');
    } finally {
      clearTimeout(timer);
    }

    if (resp.status === 401) {
      log('ott_redemption_auth_failed', { endpoint });
      throw new Error('AUTH');
    }

    let body;
    try {
      body = rawText ? JSON.parse(rawText) : undefined;
    } catch {
      body = undefined;
    }

    if (resp.status >= 500) {
      log('ott_redemption_server_error', { endpoint, status: resp.status });
      throw new Error('RETRYABLE');
    }

    if ((resp.status === 200 || resp.status === 201) && body?.success === 'true') {
      return body;
    }

    const errorCode = body?.errorCode !== undefined ? String(body.errorCode) : undefined;
    const reason =
      (typeof body?.message === 'string' && body.message.trim()) ||
      (rawText && rawText.slice(0, 200)) ||
      `OTT returned HTTP ${resp.status}`;
    log('ott_redemption_rejected', { endpoint, status: resp.status, errorCode, reason });
    const err = new Error('USER_INPUT');
    err.reason = reason;
    if (errorCode !== undefined) err.errorCode = errorCode;
    throw err;
  }

  /**
   * Validate a voucher PIN before touching money — cheap, read-only, and
   * the right thing to call at preview time so the customer learns the
   * value before confirming.
   *
   * @param {string} voucherPin
   * @returns {Promise<{valid: true, serial: string, valueCents: number}>}
   */
  async checkVoucher(voucherPin) {
    const body = await this.post('CheckVoucher', {
      vendorID: String(this.vendorId),
      voucherPIN: String(voucherPin),
    });
    const out = {
      valid: true,
      serial: String(body.serial ?? ''),
      valueCents: randToCents(body.value),
    };
    log('ott_redemption_check', { pinMasked: maskPin(voucherPin), valueCents: out.valueCents });
    return out;
  }

  /**
   * Redeem (remit) a voucher into our merchant account.
   *
   * OUTCOME CONTRACT (money-safety, per spec page 13):
   * - resolves  -> REDEEMED. voucherAmountCents was taken; voucherBalanceCents
   *                remains with the CUSTOMER via OTT's re-vault SMS.
   * - 'TIMEOUT_CHECK_REQUIRED' -> INDETERMINATE. Do NOT retry remitVoucher and
   *                do NOT refuse the customer. Call checkRemitVoucher() with
   *                the SAME uniqueReference to learn the truth.
   * - 'USER_INPUT' -> definitively rejected (bad/used PIN, etc.); `reason`
   *                and `errorCode` carry OTT's explanation.
   * - 'AUTH' / 'RETRYABLE' -> our problem, nothing moved.
   *
   * @param {object} args
   * @param {string} args.voucherPin        bearer secret, never logged in full
   * @param {number} args.amountCents       must be <= voucher value
   * @param {string} args.uniqueReference   deterministic + epoch-free (ledger rule)
   * @param {string} args.mobile            the customer's msisdn
   * @param {string} args.clientId          our identifier for the customer
   * @param {string} [args.account]         our account reference
   */
  async remitVoucher({ voucherPin, amountCents, uniqueReference, mobile, clientId, account }) {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new Error('remitVoucher requires positive integer amountCents');
    }
    if (!uniqueReference) throw new Error('remitVoucher requires a uniqueReference');
    // The ledger's epoch-free rule applies to anything that becomes an
    // idemKey; a timestamped reference would be rejected at settle time.
    if (/1\d{12}|1[6-9]\d{8}/.test(String(uniqueReference))) {
      throw new Error('uniqueReference must be deterministic and epoch-free');
    }

    let body;
    try {
      body = await this.post(
        'RemitVoucher',
        {
          account: String(account ?? clientId ?? ''),
          amount: centsToRand(amountCents),
          clientID: String(clientId ?? ''),
          mobile: String(mobile ?? ''),
          pin: String(voucherPin),
          uniqueReference: String(uniqueReference),
          vendorID: String(this.vendorId),
        },
        { timeoutAsMarker: true }
      );
    } catch (error) {
      if (error.message === 'TIMEOUT') {
        // NEVER retry the remit. The caller must resolve with checkRemitVoucher.
        log('ott_redemption_timeout_check_required', { uniqueReference });
        const e = new Error('TIMEOUT_CHECK_REQUIRED');
        e.uniqueReference = uniqueReference;
        throw e;
      }
      throw error;
    }

    const out = {
      voucherId: body.voucherID != null ? String(body.voucherID) : null,
      voucherAmountCents: randToCents(body.voucherAmount),
      voucherBalanceCents: body.voucherBalance != null ? randToCents(body.voucherBalance) : 0,
      uniqueReference,
    };
    log('ott_redemption_remitted', {
      uniqueReference,
      pinMasked: maskPin(voucherPin),
      voucherAmountCents: out.voucherAmountCents,
      voucherBalanceCents: out.voucherBalanceCents,
      live: this.isLive,
    });
    return out;
  }

  /**
   * Resolve an indeterminate remit. The ONLY correct follow-up to a
   * TIMEOUT_CHECK_REQUIRED — never a second remitVoucher.
   *
   * @param {string} uniqueReference the reference used in the remit
   * @returns {Promise<{redeemed: true, voucherAmountCents, voucherBalanceCents}>}
   *          Throws USER_INPUT when OTT has no successful remit for it
   *          (i.e. nothing was taken and the customer can safely retry).
   */
  async checkRemitVoucher(uniqueReference) {
    if (!uniqueReference) throw new Error('checkRemitVoucher requires a uniqueReference');
    const body = await this.post('CheckRemitVoucher', {
      uniqueReference: String(uniqueReference),
    });
    const out = {
      redeemed: true,
      voucherAmountCents: randToCents(body.voucherAmount),
      voucherBalanceCents: body.voucherBalance != null ? randToCents(body.voucherBalance) : 0,
      uniqueReference,
    };
    log('ott_redemption_check_remit', { uniqueReference, voucherAmountCents: out.voucherAmountCents });
    return out;
  }
}
