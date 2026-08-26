/**
 * OTT Payout API client — the money-OUT rail (PayShap / RTC / CashSend /
 * OTT-Voucher payout). Spec: docs/OTT_PAYOUT_API.md (received 2026-08-26).
 *
 * This is a SEPARATE product from OTT voucher ISSUING (lib is @wapay/
 * providers-ott): different base URL, different auth. Payout authenticates
 * with HTTP Basic (API username : API password) PLUS a SHA-256 request hash
 * over an ordered list of parameter VALUES with the API key appended.
 *
 * SECURITY:
 * - Credentials come from env only, never logged.
 * - A PerformPayout for the OTT-VOUCHER provider returns a bearer PIN in
 *   voucherdata.pin — that is a secret; it is NEVER logged here.
 * - Recipient PII (account number, id number, mobile) is never logged in full.
 *
 * MONEY-SAFETY (the caller's contract — see classifyPayoutStatus):
 *   settlement 'SETTLE'  → final success; settle the reserved hold.
 *   settlement 'PENDING' → INDETERMINATE or async; LEAVE the hold reserved and
 *                          reconcile via the webhook or getPaymentStatus().
 *   settlement 'RELEASE' → definitively nothing was paid; release the hold.
 * NEVER release a hold on PENDING. Two cases are deliberately PENDING even
 * though they look like failures, because the payout may already have gone
 * through (review 2026-08-26):
 *   - transport failure/timeout → performPayout RETURNS outcome
 *     'TRANSPORT_INDETERMINATE' with reconcileRequired (it does not throw);
 *   - status 3 (duplicate reference) → an earlier attempt reached OTT.
 * After any reconcileRequired outcome, call getPaymentStatus(reference) —
 * never re-issue performPayout.
 *
 * ⚠️ TWO THINGS TO CONFIRM IN SANDBOX before production (the doc is
 * internally inconsistent and we cannot test until credentials + IP-allowlist
 * land):
 *   1. BODY ENCODING. "Request Requirements" says
 *      application/x-www-form-urlencoded, but every sample body is nested
 *      JSON (recipient.*, provider.*) and the webhook is JSON. We default to
 *      JSON (the only faithful encoding of the nested samples); flip
 *      OTT_PAYOUT_BODY_ENCODING=form to switch. The HASH is unaffected either
 *      way — it is over ordered values, not the body.
 *   2. AMOUNT + EMPTY-OPTIONAL FORMATTING IN THE HASH. We format amount as
 *      "0.00" (2dp) and coerce absent optionals to "" in the hash string.
 *      Confirm OTT computes the hash the same way (a mismatch → status 2
 *      "Invalid Hash"); the ordered value list itself is taken verbatim from
 *      the spec.
 */

import crypto from 'crypto';

const DEFAULT_TIMEOUT_MS = 20000;

function log(type, data) {
  console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));
}

/** Absent/null → '' so the hash matches a server that concatenates blanks. */
function h(v) {
  if (v === undefined || v === null) return '';
  return String(v);
}

/** Integer cents → the 2dp amount string used on the wire and in the hash. */
export function centsToAmountString(cents) {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`amount must be a non-negative integer number of cents, got ${cents}`);
  }
  return (cents / 100).toFixed(2);
}

/** '400,00' | '400.00' | '50.99' → integer cents, string-parsed (no float math). */
export function payoutAmountToCents(raw) {
  const s = String(raw ?? '').trim().replace(/\s/g, '');
  // OTT balances can be grouped ("100,000.00") or comma-decimal ("400,00").
  let normalized = s;
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) {
    normalized = s.replace(/,/g, ''); // thousands grouping with '.' decimal
  } else if (/^\d+,\d{1,2}$/.test(s)) {
    normalized = s.replace(',', '.'); // comma decimal
  } else if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    return null;
  }
  const [intPart, decPart = ''] = normalized.split('.');
  const cents = Number(intPart) * 100 + Number((decPart + '00').slice(0, 2));
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

/**
 * SHA-256 of the ordered parameter VALUES concatenated with no separators,
 * with the API key appended last. Lowercase hex. This is the documented
 * scheme; the golden vector in docs/OTT_PAYOUT_API.md is a test.
 *
 * @param {Array<string|number|null|undefined>} values - in the endpoint's hash order
 * @param {string} apiKey
 * @returns {string} lowercase hex sha-256
 */
export function payoutHash(values, apiKey) {
  const s = values.map(h).join('') + h(apiKey);
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/** HTTP Basic auth header for API username : API password. */
export function basicAuthHeader(username, password) {
  return 'Basic ' + Buffer.from(`${h(username)}:${h(password)}`, 'utf8').toString('base64');
}

/** Constant-time hex compare (hash verification). */
function hexEqual(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verify an inbound Payout webhook. The hash is over
 *   merchantUniqueReference + message + status + transactionId + utctimestamp + apiKey
 * (spec "Webhook Authentication"). Returns true iff hashcheck matches.
 *
 * @param {object} payload - parsed JSON webhook body
 * @param {string} apiKey
 * @returns {boolean}
 */
export function verifyPayoutWebhook(payload, apiKey) {
  if (!payload || typeof payload !== 'object') return false;
  const expected = payoutHash(
    [
      payload.merchantUniqueReference,
      payload.message,
      payload.status,
      payload.transactionId,
      payload.utctimestamp,
    ],
    apiKey
  );
  return hexEqual(expected, payload.hashcheck);
}

/**
 * Normalise a PerformPayout / status code into a money-safe outcome class.
 * The CALLER uses `settlement` to drive the ledger:
 *   - 'SETTLE'  : final success — settle the reserved hold.
 *   - 'PENDING' : async — keep the hold reserved; reconcile on webhook/status.
 *   - 'RELEASE' : definitive failure — release the reserved hold.
 *
 * @param {string|number} status
 * @returns {{ outcome: string, settlement: 'SETTLE'|'PENDING'|'RELEASE', retriable: boolean }}
 */
export function classifyPayoutStatus(status) {
  const s = String(status);
  switch (s) {
    case '100':
      return { outcome: 'SUCCESS', settlement: 'SETTLE', retriable: false };
    case '99':
      return { outcome: 'PENDING_FINALISATION', settlement: 'PENDING', retriable: false };
    case '98':
      return { outcome: 'PENDING', settlement: 'PENDING', retriable: false };
    case '-1':
      return { outcome: 'AUTH_ERROR', settlement: 'RELEASE', retriable: false };
    case '1':
      return { outcome: 'INVALID_LOGON', settlement: 'RELEASE', retriable: false };
    case '2':
      return { outcome: 'INVALID_HASH', settlement: 'RELEASE', retriable: false };
    case '0':
      // Provider inactive / insufficient float / limit breach — no payout made.
      return { outcome: 'PAYOUT_REJECTED', settlement: 'RELEASE', retriable: false };
    case '3':
      // "Your Reference is not unique" OR "Error Adding Client" — the API
      // conflates them. With our deterministic epoch-free reference, a
      // duplicate means an EARLIER attempt already reached OTT and may have
      // SUCCEEDED. Releasing here would double-spend, so reconcile instead
      // (review 2026-08-26).
      return {
        outcome: 'DUPLICATE_OR_CLIENT_ERROR',
        settlement: 'PENDING',
        retriable: false,
        reconcileRequired: true,
      };
    case '4':
      return { outcome: 'INVALID_MOBILE', settlement: 'RELEASE', retriable: false };
    case '9':
      return { outcome: 'DATA_VALIDATION', settlement: 'RELEASE', retriable: false };
    case '10':
    case '11':
      return { outcome: 'ID_VALIDATION', settlement: 'RELEASE', retriable: false };
    case '12':
      return { outcome: 'LIMIT_ERROR', settlement: 'RELEASE', retriable: false };
    case '97':
      return { outcome: 'PROVIDER_FAILURE', settlement: 'RELEASE', retriable: false };
    default:
      // Unknown code: the SAFE default is to NOT release (we may have paid).
      return { outcome: 'UNKNOWN', settlement: 'PENDING', retriable: false };
  }
}

/**
 * The exact ordered value list for the PerformPayout hash (spec
 * "Hash Calculation Order"). optionalData is excluded. Absent optionals hash
 * as '' (see the sandbox caveat at the top of this file).
 */
function performPayoutHashValues({ amount, provider, recipient, yourUniqueReference }) {
  const r = recipient || {};
  const p = provider || {};
  return [
    r.account_name,
    r.account_number,
    amount, // already the 2dp string
    r.bank_id,
    r.branch_name,
    r.branch_code,
    r.country_of_issue,
    r.date_of_birth,
    r.email,
    r.firstname,
    r.id_number,
    r.id_type,
    r.middle_name,
    r.mobile,
    r.nationality,
    p.providerCode,
    p.providerName,
    r.surname,
    r.swift_code,
    r.title,
    yourUniqueReference,
  ];
}

/** Mask an account/id/mobile for logs: keep last 3 digits only. */
function mask(v) {
  const s = String(v ?? '');
  return s.length <= 3 ? '***' : `***${s.slice(-3)}`;
}

export class OttPayoutClient {
  /**
   * @param {object} [config]
   * @param {string} [config.baseUrl]  - overrides OTT_PAYOUT_BASE_URL
   * @param {string} [config.username] - overrides OTT_PAYOUT_USERNAME
   * @param {string} [config.password] - overrides OTT_PAYOUT_PASSWORD
   * @param {string} [config.apiKey]   - overrides OTT_PAYOUT_API_KEY
   * @param {number} [config.timeoutMs]
   * @param {'json'|'form'} [config.bodyEncoding]
   */
  constructor(config = {}) {
    const req = (name, val) => {
      const v = val ?? process.env[name];
      if (!v) throw new Error(`Missing env ${name} (OTT Payout)`);
      return v;
    };
    this.base = (config.baseUrl ?? req('OTT_PAYOUT_BASE_URL')).replace(/\/+$/, '');
    this.username = req('OTT_PAYOUT_USERNAME', config.username);
    this.password = req('OTT_PAYOUT_PASSWORD', config.password);
    this.apiKey = req('OTT_PAYOUT_API_KEY', config.apiKey);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.bodyEncoding =
      config.bodyEncoding ?? (process.env.OTT_PAYOUT_BODY_ENCODING === 'form' ? 'form' : 'json');
  }

  /** UTC "yyyy-MM-dd HH:mm:ss" — the requestdate format the balance/status calls use. */
  static requestDate(d = new Date()) {
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }

  async _post(path, body, { hashValues }) {
    const url = `${this.base}${path}`;
    const withHash = { ...body, hashcheck: payoutHash(hashValues, this.apiKey) };
    const headers = { Authorization: basicAuthHeader(this.username, this.password) };
    let payload;
    if (this.bodyEncoding === 'form') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(flattenForForm(withHash)).toString();
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(withHash);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(url, { method: 'POST', headers, body: payload, signal: controller.signal });
      const text = await resp.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { _raw: text };
      }
      return { httpStatus: resp.status, body: json };
    } catch (error) {
      // Transport failure (timeout, abort, DNS, reset). This is INDETERMINATE,
      // NOT a failure: the request may have reached OTT and be in flight.
      // Surfaced as a typed error so a caller can never mistake it for
      // "didn't happen" and release a hold we may have already paid.
      const e = new Error(`OTT payout transport failure: ${error?.message || error}`);
      e.code = 'TRANSPORT_INDETERMINATE';
      e.settlement = 'PENDING';
      e.indeterminate = true;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Current float balance of our payout account. */
  async getBalance({ requestdate = OttPayoutClient.requestDate(), yourUniqueReference } = {}) {
    if (!yourUniqueReference) throw new Error('yourUniqueReference required');
    const { body } = await this._post('/api/purchase/v1/GetBalance', { requestdate, yourUniqueReference }, {
      hashValues: [requestdate, yourUniqueReference],
    });
    log('ott_payout_get_balance', { ref: yourUniqueReference, status: body?.status });
    return body;
  }

  /** All active payout providers (PayShap, RTC, FNB, OTT Voucher, …). */
  async getActiveProviders({ requestdate = OttPayoutClient.requestDate(), yourUniqueReference } = {}) {
    if (!yourUniqueReference) throw new Error('yourUniqueReference required');
    const { body } = await this._post(
      '/api/purchase/v1/GetActiveProviders',
      { requestdate, yourUniqueReference },
      { hashValues: [requestdate, yourUniqueReference] }
    );
    return body;
  }

  /** Provider limits + which recipient fields each provider requires. */
  async getActiveProviderLimits({ requestdate = OttPayoutClient.requestDate(), yourUniqueReference } = {}) {
    if (!yourUniqueReference) throw new Error('yourUniqueReference required');
    const { body } = await this._post(
      '/api/purchase/v1/GetActiveProvidersLimits',
      { requestdate, yourUniqueReference },
      { hashValues: [requestdate, yourUniqueReference] }
    );
    return body;
  }

  /** Universal branch codes — required for PayShap/RTC (branch_code + branch_name). */
  async getBranchCodes({ requestdate = OttPayoutClient.requestDate(), yourUniqueReference } = {}) {
    if (!yourUniqueReference) throw new Error('yourUniqueReference required');
    const { body } = await this._post(
      '/api/purchase/v1/GetBranchCodes',
      { requestdate, yourUniqueReference },
      { hashValues: [requestdate, yourUniqueReference] }
    );
    return body;
  }

  /** Country codes — used by passport-type payouts (e.g. FNB). */
  async getCountryCodes({ requestdate = OttPayoutClient.requestDate(), yourUniqueReference } = {}) {
    if (!yourUniqueReference) throw new Error('yourUniqueReference required');
    const { body } = await this._post(
      '/api/purchase/v1/GetCountryCodes',
      { requestdate, yourUniqueReference },
      { hashValues: [requestdate, yourUniqueReference] }
    );
    return body;
  }

  /**
   * Initiate a payout. The reserved hold is settled/held/released per
   * classifyPayoutStatus(result.body.status) — never release on PENDING.
   *
   * @param {object} args
   * @param {number} args.amountCents - integer cents, > 0
   * @param {number} args.providerCode
   * @param {string} [args.providerName]
   * @param {object} args.recipient - firstname/surname required; provider-specific fields per getActiveProviderLimits
   * @param {string} args.yourUniqueReference - deterministic, epoch-free, unique
   * @param {object} [args.optionalData]
   */
  async performPayout({ amountCents, providerCode, providerName = '', recipient, yourUniqueReference, optionalData }) {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new Error(`amountCents must be a positive integer, got ${amountCents}`);
    }
    if (!yourUniqueReference) throw new Error('yourUniqueReference required');
    if (!recipient?.firstname || !recipient?.surname) {
      throw new Error('recipient.firstname and recipient.surname are required');
    }
    const amount = centsToAmountString(amountCents);
    const provider = { providerCode, providerName };
    const body = {
      yourUniqueReference,
      // MUST be the SAME 2dp string we hash — sending Number("50.00") → 50
      // means OTT recomputes its hash over "50" and every round-rand payout
      // fails with status 2 Invalid Hash (review 2026-08-26).
      amount,
      provider,
      recipient,
      ...(optionalData ? { optionalData } : {}),
    };
    const hashValues = performPayoutHashValues({ amount, provider, recipient, yourUniqueReference });

    let httpStatus;
    let respBody;
    try {
      ({ httpStatus, body: respBody } = await this._post('/api/purchase/v1/PerformPayout', body, { hashValues }));
    } catch (error) {
      if (error?.indeterminate) {
        // NEVER release a hold here — reconcile with getPaymentStatus() or
        // wait for the webhook. Returning (not throwing) makes the safe
        // settlement explicit to the caller.
        log('ott_payout_indeterminate', {
          ref: yourUniqueReference,
          providerCode,
          amountCents,
          reason: error.code,
        });
        return {
          httpStatus: null,
          status: null,
          outcome: 'TRANSPORT_INDETERMINATE',
          settlement: 'PENDING',
          retriable: false,
          reconcileRequired: true,
          paymentReference: null,
          body: null,
        };
      }
      throw error;
    }
    const status = respBody?.status;
    const klass = classifyPayoutStatus(status);
    // Log WITHOUT the pin, account number, or id number.
    log('ott_payout_perform', {
      ref: yourUniqueReference,
      providerCode,
      amountCents,
      httpStatus,
      status,
      outcome: klass.outcome,
      settlement: klass.settlement,
      mobile: mask(recipient?.mobile),
      account: mask(recipient?.account_number),
      paymentReference: respBody?.paymentReference || null,
    });
    return { httpStatus, status, ...klass, paymentReference: respBody?.paymentReference || null, body: respBody };
  }

  /** Final status of a prior payout (poll fallback to the webhook). */
  async getPaymentStatus({ requestdate = OttPayoutClient.requestDate(), yourUniqueReference }) {
    if (!yourUniqueReference) throw new Error('yourUniqueReference required');
    const { body } = await this._post(
      '/api/purchase/v1/GetPaymentStatus',
      { requestdate, yourUniqueReference },
      { hashValues: [requestdate, yourUniqueReference] }
    );
    const klass = classifyPayoutStatus(body?.status);
    return { status: body?.status, ...klass, body };
  }

  /** Resend the transaction SMS (providers that support it; rate-limited by OTT). */
  async resendSms({ requestdate = OttPayoutClient.requestDate(), yourUniqueReference }) {
    if (!yourUniqueReference) throw new Error('yourUniqueReference required');
    const { body } = await this._post(
      '/api/purchase/v1/ResendSMS',
      { requestdate, yourUniqueReference },
      { hashValues: [requestdate, yourUniqueReference] }
    );
    return body;
  }

  /** VerifyWH — server-side webhook verification helper. */
  async verifyWH({ requestdate = OttPayoutClient.requestDate(), yourUniqueReference, whSecret }) {
    if (!yourUniqueReference || !whSecret) throw new Error('yourUniqueReference and whSecret required');
    const { body } = await this._post(
      '/api/purchase/v1/VerifyWH',
      { requestdate, yourUniqueReference, whSecret },
      { hashValues: [requestdate, yourUniqueReference, whSecret] }
    );
    return body;
  }
}

/** Flatten nested {recipient:{firstname}} → {'recipient.firstname': v} for form encoding. */
function flattenForForm(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenForForm(v, key, out);
    else if (v !== undefined && v !== null) out[key] = String(v);
  }
  return out;
}
