/**
 * PayCentral platform API client: prepaid Mastercard cards on the PayCentral rail
 * (DigiCentral virtual, CashCentral physical, FuelCentral). Spec: "PayCentral Staging
 * Platform API Specification v2.1.5", summarised in docs/CARDS.md sections 0.9 to 0.11.
 *
 * This module is the wire only. It moves no WaPay money: the ledger flow (reserveHold, load,
 * settleHold or releaseHold) belongs to the caller and is not built yet.
 *
 * ONE WHITELISTED ADDRESS (2026-11-16). PayCentral whitelists one IP (155.121.235.0), but
 * Vercel's Static IPs are a pair and Vercel cannot pin one of them. The rules:
 *   - A call is "refused at the door" only when its connection never connected (the socket
 *     or the TLS handshake failed, counted by our own connector), or when a READ gets a 403
 *     without PayCentral's JSON. Such a call never reached PayCentral, so it is retried on a
 *     fresh connection, which may leave from the other address.
 *   - A money or state call (load, allocation, freeze) is sent once per connection, and only
 *     after a harmless read on that same connection got through (the door check). Anything
 *     unclear after it was sent (a reset, a timeout, a redirect, a 5xx, a body we cannot read)
 *     is never retried: it raises TRANSPORT_INDETERMINATE or returns outcome 'unknown', and the
 *     caller checks the reference (checkReference) before releasing any hold. A money call is
 *     retried only when its own reconnect failed before connecting.
 *   - Redirects are never followed (a followed redirect could re-send a processed call).
 *   - Production: PAYCENTRAL_EGRESS_PROXY sends every call through one HTTP proxy with one
 *     address of our own; that is the address PayCentral whitelists for production.
 *   GET /api/internal/paycentral-probe measures how often the door refuses us, and how.
 *
 * CARD DATA (golden thread 3.5). virtualAllocate answers with the full card number and the
 * security code. Neither leaves this module: callers get seq_no, the last four digits and the
 * expiry. Every message and record handed back, and every log line, is redacted.
 *
 * AMOUNTS. WaPay counts integer cents; PayCentral takes rands. Until PayCentral confirms that a
 * load may carry cents, an amount that is not whole rands is refused (PAYCENTRAL_WHOLE_RANDS).
 */

import crypto from 'node:crypto';
import { fetch as undiciFetch, Agent, ProxyAgent, buildConnector } from 'undici';

export const DEFAULT_BASE_URL = 'https://staging-api.paycentral.co.za';
const DEFAULTS = {
  timeoutMs: 15000,
  connectTimeoutMs: 5000,
  doorAttempts: 6,
  readAttempts: 3,
  callBudgetMs: 25000, // one call, all attempts included: fits inside a 60 s function
};
const BACKOFF_MS = 250;
const MIN_ATTEMPT_MS = 1000;
const TOKEN_FALLBACK_TTL_MS = 30 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

function log(type, data) {
  console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));
}

function pcError(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

const indeterminate = (path, why) =>
  pcError('TRANSPORT_INDETERMINATE', `PayCentral outcome unknown on ${path} (${why}): check the reference before releasing`, { indeterminate: true });

/** Whether the deployment has what the client needs (booleans only, never a value). */
export function payCentralConfigured(env = process.env) {
  return !!(env.PAYCENTRAL_API_EMAIL && env.PAYCENTRAL_API_PASSWORD);
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** A proxy that refused to open the tunnel: the request was never written. */
export function isTunnelRefusal(err) {
  let cur = err;
  for (let i = 0; cur && i < 5; i += 1) {
    if (/Proxy response \(\d+\)/i.test(String(cur.message || ''))) return true;
    cur = cur.cause;
  }
  return false;
}

const hasPayCentralShape = (json) =>
  !!json && typeof json === 'object' && !Array.isArray(json) &&
  Object.keys(json).some((k) => ['status', 'message', 'success', 'token'].includes(k.toLowerCase()));

/** For READS only: a 403 without PayCentral's JSON is the firewall turning the address away. */
export function isDoorRefusalResponse(httpStatus, json) {
  return httpStatus === 403 && !hasPayCentralShape(json);
}

const fieldCI = (obj, name) => {
  if (!obj || typeof obj !== 'object') return undefined;
  const want = String(name).toLowerCase();
  const key = Object.keys(obj).find((k) => k.toLowerCase() === want);
  return key === undefined ? undefined : obj[key];
};

/** PayCentral answers {"status":"Success"} or {"success":true}, in varying case. */
export function isSuccess(json) {
  if (!hasPayCentralShape(json)) return false;
  const status = String(fieldCI(json, 'status') ?? '').toLowerCase();
  const success = fieldCI(json, 'success');
  return status === 'success' || success === true || String(success).toLowerCase() === 'true';
}

const MAYBE_DONE = /duplicate|already|exists|in use|been used|processed/i;

/**
 * A write's outcome: 'ok', 'declined' only for a failure PayCentral plainly stated, else
 * 'unknown' (an unreadable or unexpected answer, or a refusal that may mean "done already").
 */
export function writeOutcome(json) {
  if (isSuccess(json)) return 'ok';
  if (!hasPayCentralShape(json)) return 'unknown';
  const status = String(fieldCI(json, 'status') ?? '').toLowerCase();
  const success = fieldCI(json, 'success');
  const failed = status === 'failure' || status === 'failed' || success === false || String(success).toLowerCase() === 'false';
  if (!failed) return 'unknown';
  return MAYBE_DONE.test(String(fieldCI(json, 'message') ?? '')) ? 'unknown' : 'declined';
}

/** The JWT's exp claim in ms, or null when it has none or cannot be read. */
export function jwtExpiryMs(token) {
  try {
    const part = String(token).split('.')[1];
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return Number.isFinite(claims?.exp) ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Integer cents → the rands string PayCentral takes. Whole rands only while PAYCENTRAL_WHOLE_RANDS is on. */
export function centsToRands(cents, { wholeRands = true } = {}) {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw pcError('BAD_INPUT', `amount must be a positive whole number of cents, got ${cents}`);
  const rest = cents % 100;
  if (wholeRands && rest !== 0) throw pcError('AMOUNT_NOT_WHOLE_RANDS', 'PayCentral loads are whole rands until cents are confirmed');
  const rands = (cents - rest) / 100;
  return wholeRands ? String(rands) : `${rands}.${String(rest).padStart(2, '0')}`;
}

/** "52.00" | "25.4" | 25.4 | "-0.10" | "1,250.00" | "25,40" → integer cents (string-parsed), else null. */
export function randsToCents(raw) {
  let s = String(raw ?? '').trim().replace(/\s/g, '');
  let negative = false;
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [intPart, decPart = ''] = s.split('.');
  const cents = Number(intPart) * 100 + Number((decPart + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) return null;
  return negative && cents !== 0 ? -cents : cents;
}

/**
 * A load's reference_no: digits, deterministic from our idemKey, first digit never 0. The spec
 * says "any 12 digit (unique)". The caller stores it with the hold (never recomputes it, never
 * puts it inside a ledger idemKey). 12 digits: about a 0.5% chance of any collision over 100k
 * loads; raise PAYCENTRAL_REFERENCE_DIGITS once PayCentral confirms longer references.
 */
export function loadReference(idemKey, digits = 12) {
  if (!idemKey) throw pcError('BAD_INPUT', 'loadReference needs the load idemKey');
  if (!Number.isInteger(digits) || digits < 12 || digits > 20 || digits === 13) {
    throw pcError('BAD_INPUT', 'reference length must be 12 or 14 to 20 digits');
  }
  const hex = crypto.createHash('sha256').update(`paycentral-load|${idemKey}`).digest('hex');
  const first = Number(BigInt(`0x${hex.slice(0, 16)}`) % 9n) + 1;
  const rest = (BigInt(`0x${hex.slice(16)}`) % 10n ** BigInt(digits - 1)).toString().padStart(digits - 1, '0');
  return `${first}${rest}`;
}

/** DD/MM/YYYY in South African time, the statement calls' date format. */
export function statementDate(d) {
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) throw pcError('BAD_INPUT', 'statement dates must be valid dates');
  return date.toLocaleDateString('en-GB', { timeZone: 'Africa/Johannesburg' });
}

// --- Redaction --------------------------------------------------------------

const norm = (k) => String(k ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const SECRET_KEYS = new Set(['securecode', 'cvv', 'cvc', 'cvv2', 'cardcvv', 'password', 'token', 'accesstoken', 'refreshtoken', 'authorization', 'pin', 'apikey', 'secret']);
const CARD_KEYS = new Set(['cardno', 'cardnumber', 'cardnum', 'cardidentifier', 'pan']);
const PERSON_KEYS = new Set([
  'idorpassport', 'idorpassportnumber', 'idnumber', 'idno', 'passport', 'passportnumber', 'accountnumber', 'accountno',
  'dateofbirth', 'dob', 'cellphonenumber', 'cellnumber', 'cellphone', 'mobile', 'mobilenumber', 'phone', 'phonenumber',
  'msisdn', 'emailid', 'email', 'emailaddress', 'firstname', 'lastname', 'surname', 'cardholdername', 'fullname',
  'address', 'addressline1', 'addressline2', 'physicaladdress', 'postaladdress',
]);
const DOC_KEY = /(document|documentcontent|content)$/;
const CARD_GROUPED = /\b\d{4}(?:[ -]\d{4}){2,3}\b/g;
const PHONE_GROUPED = /(?:\+?27|\b0)\d{2}[ -]\d{3}[ -]\d{4}\b/g;
const LONG_RUN = /\d{7,}/g;
const last4 = (s) => `•••${String(s).replace(/\D/g, '').slice(-4)}`;

function scrubText(s) {
  const str = String(s);
  if (/^\s*[[{]/.test(str)) {
    try {
      return JSON.stringify(redactPayCentral(JSON.parse(str)));
    } catch {
      // not JSON after all: scrub as text
    }
  }
  return str.replace(CARD_GROUPED, last4).replace(PHONE_GROUPED, last4).replace(LONG_RUN, last4);
}

/**
 * Deep copy with card numbers, security codes, identity and contact details, names, addresses,
 * passwords, tokens and documents masked; JSON held in strings is parsed and walked; any run of
 * 7 or more digits, a grouped card number or a grouped phone number in free text is masked.
 */
export function redactPayCentral(value, key = '') {
  if (Array.isArray(value)) return value.map((x) => redactPayCentral(x, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, redactPayCentral(x, k)]));
  }
  if (value === null || value === undefined || typeof value === 'boolean') return value;
  const k = norm(key);
  if (SECRET_KEYS.has(k)) return '[hidden]';
  if (k && DOC_KEY.test(k) && !k.endsWith('name')) return '[document]';
  if (CARD_KEYS.has(k)) return String(value).replace(/\D/g, '').length >= 12 ? last4(value) : value;
  if (PERSON_KEYS.has(k)) return '[masked]';
  if (typeof value === 'number') return Number.isInteger(value) && Math.abs(value) >= 1e11 ? last4(value) : value;
  return scrubText(value);
}

/** A PayCentral message, safe to hand back or log. */
export function safeMessage(m) {
  return scrubText(m ?? '').slice(0, 200);
}

const parseMaybeJson = (v) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Tokens by base URL and login, shared by every client in this instance. */
const TOKENS = new Map();
const LOGINS_IN_FLIGHT = new Map();
/** One proxy dispatcher per proxy URL (one fixed address needs no fresh connections). */
const PROXY_DISPATCHERS = new Map();

/** Tests only: forget tokens and close proxy connections. */
export function _resetPayCentralState() {
  TOKENS.clear();
  LOGINS_IN_FLIGHT.clear();
  for (const d of PROXY_DISPATCHERS.values()) d.close().catch(() => {});
  PROXY_DISPATCHERS.clear();
}

export class PayCentralClient {
  /**
   * @param {object} [config] - every field falls back to its PAYCENTRAL_* environment variable
   * @param {string} [config.baseUrl]
   * @param {string} [config.email]
   * @param {string} [config.password]
   * @param {string} [config.egressProxy] - HTTP proxy URL for one fixed outbound address
   * @param {boolean} [config.wholeRands]
   * @param {number} [config.timeoutMs] - one attempt
   * @param {number} [config.connectTimeoutMs]
   * @param {number} [config.doorAttempts] - connections tried when the door refuses
   * @param {number} [config.readAttempts] - attempts for a read that failed after connecting
   * @param {number} [config.callBudgetMs] - one call, all attempts included
   * @param {number} [config.referenceDigits]
   * @param {Function} [config.fetchFn] - tests
   * @param {Function} [config.connectionFactory] - tests: returns { dispatcher, state }
   * @param {Function} [config.sleep] - tests
   */
  constructor(config = {}) {
    const env = process.env;
    this.base = String(config.baseUrl ?? env.PAYCENTRAL_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.email = config.email ?? env.PAYCENTRAL_API_EMAIL;
    this.password = config.password ?? env.PAYCENTRAL_API_PASSWORD;
    if (!this.email || !this.password) throw pcError('CONFIG', 'Missing PAYCENTRAL_API_EMAIL or PAYCENTRAL_API_PASSWORD');
    this.egressProxy = config.egressProxy ?? (env.PAYCENTRAL_EGRESS_PROXY || null);
    if (this.egressProxy) {
      try {
        new URL(this.egressProxy); // eslint-disable-line no-new
      } catch {
        throw pcError('CONFIG', 'PAYCENTRAL_EGRESS_PROXY is not a valid URL');
      }
    }
    this.wholeRands = config.wholeRands ?? env.PAYCENTRAL_WHOLE_RANDS !== 'false';
    this.timeoutMs = config.timeoutMs ?? DEFAULTS.timeoutMs;
    this.connectTimeoutMs = config.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
    this.doorAttempts = config.doorAttempts ?? Number(env.PAYCENTRAL_DOOR_ATTEMPTS || DEFAULTS.doorAttempts);
    this.readAttempts = config.readAttempts ?? DEFAULTS.readAttempts;
    this.callBudgetMs = config.callBudgetMs ?? DEFAULTS.callBudgetMs;
    this.referenceDigits = config.referenceDigits ?? Number(env.PAYCENTRAL_REFERENCE_DIGITS || 12);
    this.fetchFn = config.fetchFn ?? undiciFetch;
    this.connectionFactory = config.connectionFactory ?? null;
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * One connection. Without a proxy it is new, single-socket, and counts its own connects:
   * state.connects (socket and TLS up) and state.connectFailures (never got there).
   */
  _connection() {
    if (this.connectionFactory) return this.connectionFactory();
    if (this.egressProxy) {
      let agent = PROXY_DISPATCHERS.get(this.egressProxy);
      if (!agent) {
        try {
          agent = new ProxyAgent({ uri: this.egressProxy, connect: { timeout: this.connectTimeoutMs } });
        } catch {
          throw pcError('CONFIG', 'PAYCENTRAL_EGRESS_PROXY could not be used');
        }
        PROXY_DISPATCHERS.set(this.egressProxy, agent);
      }
      return { dispatcher: agent, state: null, shared: true };
    }
    const state = { connects: 0, connectFailures: 0 };
    const connector = buildConnector({ timeout: this.connectTimeoutMs });
    const dispatcher = new Agent({
      connections: 1,
      connect: (opts, cb) =>
        connector(opts, (err, socket) => {
          if (err) state.connectFailures += 1;
          else state.connects += 1;
          cb(err, socket);
        }),
    });
    return { dispatcher, state, shared: false };
  }

  _release(conn) {
    if (!conn || conn.shared || !conn.dispatcher?.close) return;
    Promise.resolve()
      .then(() => conn.dispatcher.close())
      .catch(() => {});
  }

  _attemptTimeout(deadline) {
    return Math.max(MIN_ATTEMPT_MS, Math.min(this.timeoutMs, deadline - Date.now()));
  }

  /**
   * One HTTP exchange on a given connection. Never throws for transport failures: returns
   * { type: 'error', neverSent } where neverSent means this request's socket never connected.
   */
  async _exchange(conn, path, { method = 'POST', body, query, token, timeoutMs }) {
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const before = conn.state ? { connects: conn.state.connects, failures: conn.state.connectFailures } : null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    try {
      const resp = await this.fetchFn(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        dispatcher: conn.dispatcher,
        redirect: 'manual',
      });
      const text = await resp.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { type: 'response', status: resp.status, json };
    } catch (err) {
      let neverSent;
      if (before) {
        // Nothing connected for this request: either the connection never connected at all,
        // or this request's (re)connect failed and no new socket came up.
        neverSent = conn.state.connects === 0 || (conn.state.connects === before.connects && conn.state.connectFailures > before.failures);
      } else {
        neverSent = isTunnelRefusal(err);
      }
      return { type: 'error', neverSent, code: err?.name === 'AbortError' ? 'TIMEOUT' : err?.cause?.code || err?.code || 'ERROR' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * An idempotent call, retried: door refusals (never connected, or a 403 without PayCentral's
   * JSON) on fresh connections up to doorAttempts; other failures up to readAttempts; all
   * within the call budget.
   */
  async _read(path, opts) {
    const deadline = Date.now() + this.callBudgetMs;
    let doorTries = 0;
    let failTries = 0;
    for (;;) {
      if (Date.now() >= deadline) {
        throw doorTries > 0
          ? pcError('DOOR_REFUSED', `PayCentral refused the connection ${doorTries} times (address not whitelisted?)`, { attempts: doorTries })
          : pcError('TRANSPORT_FAILED', `PayCentral did not answer ${path} in time`);
      }
      const conn = this._connection();
      let r;
      try {
        r = await this._exchange(conn, path, { ...opts, timeoutMs: this._attemptTimeout(deadline) });
      } finally {
        this._release(conn);
      }
      const door = (r.type === 'error' && r.neverSent) || (r.type === 'response' && isDoorRefusalResponse(r.status, r.json));
      const fine = r.type === 'response' && !door && r.status < 300;
      const answered4xx = r.type === 'response' && !door && r.status >= 400 && r.status < 500;
      if (fine || answered4xx) {
        log('paycentral_call', { path, httpStatus: r.status, ok: isSuccess(r.json), doorRetries: doorTries });
        return { httpStatus: r.status, json: r.json, doorRetries: doorTries };
      }
      if (door) {
        doorTries += 1;
        log('paycentral_refused_at_door', { path, attempt: doorTries, how: r.type === 'error' ? 'connect' : '403' });
        if (doorTries >= this.doorAttempts) {
          throw pcError('DOOR_REFUSED', `PayCentral refused the connection ${doorTries} times (address not whitelisted?)`, { attempts: doorTries });
        }
      } else {
        failTries += 1;
        log('paycentral_read_retry', { path, attempt: failTries, code: r.type === 'error' ? r.code : `HTTP_${r.status}` });
        if (failTries >= this.readAttempts) {
          throw pcError(r.type === 'error' ? 'TRANSPORT_FAILED' : 'SERVER_ERROR', `PayCentral failed on ${path}`, { httpStatus: r.status });
        }
      }
      await this.sleep(BACKOFF_MS * (doorTries + failTries));
    }
  }

  /**
   * A money or state call. On each fresh connection: a harmless authenticated read first (the
   * door check); only when it got through is the write sent, once, on that same connection.
   * Returns { httpStatus, json, outcome } with outcome 'ok' | 'declined' | 'unknown', or throws
   * DOOR_REFUSED (nothing sent) or TRANSPORT_INDETERMINATE (sent; outcome unknown).
   */
  async _write(path, { body, doorCardIdentifier }) {
    const deadline = Date.now() + this.callBudgetMs;
    let doorTries = 0;
    let reauthed = false;
    for (;;) {
      if (Date.now() >= deadline) {
        throw pcError('DOOR_REFUSED', `PayCentral could not be reached for ${path}; nothing was sent`, { attempts: doorTries });
      }
      let token = await this._token();
      const conn = this._connection();
      try {
        const check = await this._exchange(conn, '/card/balance', {
          method: 'GET',
          query: { cardIdentifier: doorCardIdentifier || '0' },
          token,
          timeoutMs: this._attemptTimeout(deadline),
        });
        const shut = check.type === 'error' || isDoorRefusalResponse(check.status, check.json);
        if (shut) {
          doorTries += 1;
          log('paycentral_refused_at_door', { path, attempt: doorTries, how: check.type === 'error' ? (check.neverSent ? 'connect' : 'check_failed') : '403' });
          if (doorTries >= this.doorAttempts) throw pcError('DOOR_REFUSED', `PayCentral refused the connection ${doorTries} times; nothing was sent`, { attempts: doorTries });
          await this.sleep(BACKOFF_MS * doorTries);
          continue;
        }
        if (check.status === 401) token = await this._token({ fresh: true });

        const w = await this._exchange(conn, path, { body, token, timeoutMs: this._attemptTimeout(deadline) });
        if (w.type === 'error') {
          if (w.neverSent) {
            doorTries += 1;
            log('paycentral_refused_at_door', { path, attempt: doorTries, how: 'reconnect' });
            if (doorTries >= this.doorAttempts) throw pcError('DOOR_REFUSED', `PayCentral refused the connection ${doorTries} times; nothing was sent`, { attempts: doorTries });
            await this.sleep(BACKOFF_MS * doorTries);
            continue;
          }
          log('paycentral_write_indeterminate', { path, code: w.code });
          throw indeterminate(path, w.code);
        }
        if (w.status === 401 && hasPayCentralShape(w.json) && !reauthed) {
          // Rejected before it was processed: log in again and send it once more.
          reauthed = true;
          await this._token({ fresh: true });
          continue;
        }
        if ((w.status >= 300 && w.status < 400) || w.status >= 500) {
          log('paycentral_write_indeterminate', { path, code: `HTTP_${w.status}` });
          throw indeterminate(path, `HTTP ${w.status}`);
        }
        const outcome = writeOutcome(w.json);
        log('paycentral_write', { path, httpStatus: w.status, outcome, doorRetries: doorTries });
        return { httpStatus: w.status, json: w.json, outcome };
      } finally {
        this._release(conn);
      }
    }
  }

  /** A bearer token, cached until a minute before it expires; one login at a time per instance. */
  async _token({ fresh = false } = {}) {
    const key = `${this.base}|${this.email}`;
    const cached = TOKENS.get(key);
    if (!fresh && cached && cached.expMs - TOKEN_REFRESH_MARGIN_MS > Date.now()) return cached.token;
    if (LOGINS_IN_FLIGHT.has(key)) return LOGINS_IN_FLIGHT.get(key);
    const login = (async () => {
      const r = await this._read('/authenticate', { method: 'POST', body: { email: this.email, password: this.password } });
      const token = fieldCI(r.json, 'token');
      if (!token) throw pcError('AUTH_FAILED', `PayCentral login failed (HTTP ${r.httpStatus})`, { httpStatus: r.httpStatus });
      TOKENS.set(key, { token, expMs: jwtExpiryMs(token) ?? Date.now() + TOKEN_FALLBACK_TTL_MS });
      return token;
    })();
    LOGINS_IN_FLIGHT.set(key, login);
    try {
      return await login;
    } finally {
      LOGINS_IN_FLIGHT.delete(key);
    }
  }

  /** An authenticated read; a 401 logs in again once. */
  async _callRead(path, opts) {
    let token = await this._token();
    let r = await this._read(path, { ...opts, token });
    if (r.httpStatus === 401) {
      token = await this._token({ fresh: true });
      r = await this._read(path, { ...opts, token });
    }
    return r;
  }

  /** Log in afresh (the probe's check). */
  async authenticate() {
    const started = Date.now();
    await this._token({ fresh: true });
    return { ok: true, ms: Date.now() - started };
  }

  /**
   * The probe's sample: one door check on a fresh connection, no retry.
   * Returns 'ok' | 'refused_connect' | 'refused_403' | 'failed_after_connect'.
   */
  async doorSample() {
    const token = await this._token();
    const conn = this._connection();
    try {
      const r = await this._exchange(conn, '/card/balance', { method: 'GET', query: { cardIdentifier: '0' }, token });
      if (r.type === 'error') return r.neverSent ? 'refused_connect' : 'failed_after_connect';
      return isDoorRefusalResponse(r.status, r.json) ? 'refused_403' : 'ok';
    } finally {
      this._release(conn);
    }
  }

  /**
   * Issue a virtual card. Returns outcome 'created' | 'declined' | 'unknown', seq_no (use it as
   * the card identifier), the last four digits and the expiry. The card number and security
   * code PayCentral returns are dropped here. There is no reference: on 'unknown' or
   * TRANSPORT_INDETERMINATE never retry (a second card could be issued); look the card up first.
   * Prefer loadCents 0 and a separate loadCard, which has a reference.
   */
  async virtualAllocate({ cellphoneNumber, firstName, lastName, idOrPassportNumber, loadCents = 0 }) {
    if (!cellphoneNumber || !firstName) throw pcError('BAD_INPUT', 'cellphoneNumber and firstName are required');
    if (!Number.isSafeInteger(loadCents) || loadCents < 0) throw pcError('BAD_INPUT', 'loadCents must be a whole number of cents, 0 or more');
    const loadAmount = loadCents > 0 ? centsToRands(loadCents, { wholeRands: this.wholeRands }) : '0';
    const r = await this._write('/card/virtualAllocate', { body: { cellphoneNumber, firstName, lastName, idOrPassportNumber, loadAmount } });
    const j = r.json || {};
    const cardNo = String(fieldCI(j, 'card_no') ?? '').replace(/\D/g, '');
    const seq = fieldCI(j, 'seq_no');
    const outcome = r.outcome === 'ok' ? 'created' : r.outcome;
    return {
      outcome,
      ok: outcome === 'created',
      message: outcome === 'created' ? 'Card created' : safeMessage(fieldCI(j, 'message')),
      seqNo: seq != null ? String(seq) : null,
      last4: cardNo.length >= 4 ? cardNo.slice(-4) : null,
      expiryDate: fieldCI(j, 'expiry_date') ?? null,
    };
  }

  /** Assign a pre-printed physical card (by sequence or tracking number) to a cardholder. */
  async allocatePhysical({ cardIdentifier, firstName, lastName, idOrPassport, emailId, cellPhoneNumber, addressLine1, addressLine2 }) {
    if (!cardIdentifier || !firstName || !lastName || !idOrPassport || !cellPhoneNumber) {
      throw pcError('BAD_INPUT', 'cardIdentifier, names, idOrPassport and cellPhoneNumber are required');
    }
    const r = await this._write('/card/allocate', {
      body: { cardIdentifier, firstName, lastName, idOrPassport, emailId, cellPhoneNumber, addressLine1, addressLine2 },
      doorCardIdentifier: cardIdentifier,
    });
    return { outcome: r.outcome, ok: r.outcome === 'ok', message: safeMessage(fieldCI(r.json, 'message')) };
  }

  /**
   * Load a card from our profile. Returns outcome 'loaded' | 'declined' | 'unknown' and the
   * reference. Only 'declined' means nothing happened; on 'unknown', or a thrown
   * TRANSPORT_INDETERMINATE (which carries the reference), call checkReference before
   * releasing any hold. DOOR_REFUSED means nothing was sent.
   */
  async loadCard({ cardIdentifier, amountCents, idemKey, notes = 'WaPay load' }) {
    if (!cardIdentifier) throw pcError('BAD_INPUT', 'cardIdentifier is required');
    const amount = centsToRands(amountCents, { wholeRands: this.wholeRands });
    const reference = loadReference(idemKey, this.referenceDigits);
    try {
      const r = await this._write('/card/load', {
        body: { cardIdentifier, amount, notes: String(notes).slice(0, 50), reference_no: reference },
        doorCardIdentifier: cardIdentifier,
      });
      const outcome = r.outcome === 'ok' ? 'loaded' : r.outcome;
      return { outcome, ok: outcome === 'loaded', message: safeMessage(fieldCI(r.json, 'message')), reference };
    } catch (e) {
      e.reference = reference;
      throw e;
    }
  }

  /**
   * What PayCentral recorded for a reference (POST /get/auditlog). Returns outcome:
   *   'not_found' : PayCentral has no such request (safe to release the hold);
   *   'loaded'    : the recorded request succeeded and matches the card and amount given;
   *   'declined'  : it was recorded and plainly refused;
   *   'unknown'   : anything else (keep the hold; ask a person).
   * The spec's example spells the field "referance_no"; both spellings are sent. Confirm the
   * response's meaning on staging before a flow settles or releases on it.
   */
  async checkReference(reference, { cardIdentifier, amountCents } = {}) {
    const r = await this._callRead('/get/auditlog', { method: 'POST', body: { referance_no: String(reference), reference_no: String(reference) } });
    const j = r.json;
    const unknown = (why) => ({ outcome: 'unknown', why });
    if (!hasPayCentralShape(j)) return unknown('unreadable');
    const topMessage = parseMaybeJson(fieldCI(j, 'message'));
    if (!isSuccess(j)) {
      const text = typeof topMessage === 'object' && topMessage ? fieldCI(topMessage, 'message') : topMessage;
      return /not\s*found/i.test(String(text ?? '')) ? { outcome: 'not_found' } : unknown('lookup failed');
    }
    if (!topMessage || typeof topMessage !== 'object' || Array.isArray(topMessage)) return unknown('record shape');
    const request = parseMaybeJson(fieldCI(topMessage, 'request'));
    const response = parseMaybeJson(fieldCI(topMessage, 'response'));
    if (!response || typeof response !== 'object' || Array.isArray(response)) return unknown('response shape');
    if (cardIdentifier && request && typeof request === 'object') {
      const seen = Object.entries(request).find(([k]) => norm(k) === 'cardidentifier');
      if (seen && String(seen[1]).replace(/\D/g, '') !== String(cardIdentifier).replace(/\D/g, '')) return unknown('different card');
    }
    if (Number.isInteger(amountCents) && request && typeof request === 'object' && fieldCI(request, 'amount') !== undefined) {
      if (randsToCents(fieldCI(request, 'amount')) !== amountCents) return unknown('different amount');
    }
    const ok = fieldCI(response, 'success');
    const msg = String(fieldCI(response, 'message') ?? '');
    const said = ok === true || String(ok).toLowerCase() === 'true';
    const refused = ok === false || String(ok).toLowerCase() === 'false';
    if (said && !/could not|must be|fail|invalid|insufficient|not allowed|error|declin/i.test(msg)) return { outcome: 'loaded', responseMessage: safeMessage(msg) };
    if (refused && !MAYBE_DONE.test(msg)) return { outcome: 'declined', responseMessage: safeMessage(msg) };
    return unknown('ambiguous response');
  }

  /** The card's balance in integer cents. */
  async cardBalance(cardIdentifier) {
    const r = await this._callRead('/card/balance', { method: 'GET', query: { cardIdentifier } });
    return { ok: isSuccess(r.json), balanceCents: randsToCents(fieldCI(r.json, 'balance')), message: safeMessage(fieldCI(r.json, 'message')) };
  }

  /** The card's transactions between two dates, amounts in integer cents. */
  async cardStatement({ cardIdentifier, from, to }) {
    const r = await this._callRead('/card/cards_statement', {
      method: 'POST',
      body: { cardIdentifier, fromdate: statementDate(from), todate: statementDate(to) },
    });
    const rows = (Array.isArray(fieldCI(r.json, 'response')) ? fieldCI(r.json, 'response') : []).filter((t) => t && typeof t === 'object');
    return {
      ok: isSuccess(r.json),
      transactions: rows.map((t) => ({
        type: Number(t.transactionType),
        at: t.transaction_date ?? t.transactionDate ?? null,
        amountCents: randsToCents(t.transactionAmount),
        description: safeMessage(t.transactionDescription).slice(0, 120),
        cardBalanceCents: randsToCents(t.card_balance),
      })),
    };
  }

  /** The card's status, last four and balance: a fixed safe set, never the raw record. */
  async cardInfo(cardIdentifier) {
    const r = await this._callRead('/card/info', { method: 'GET', query: { cardIdentifier } });
    const j = r.json || {};
    const cardNo = String(fieldCI(j, 'cardNumber') ?? '').replace(/\D/g, '');
    return {
      ok: isSuccess(j),
      statusId: fieldCI(j, 'cardStatusId') ?? null,
      last4: cardNo.length >= 4 ? cardNo.slice(-4) : null,
      balanceCents: randsToCents(fieldCI(j, 'currentbalance')),
    };
  }

  /** Stop a card. Which stopReasonID values are reversible is still to be confirmed with PayCentral. */
  async freezeCard({ cardIdentifier, stopReasonId, notes = 'Frozen by cardholder' }) {
    if (!cardIdentifier || !Number.isInteger(stopReasonId)) throw pcError('BAD_INPUT', 'cardIdentifier and an integer stopReasonId are required');
    const r = await this._write('/card/cancel', { body: { cardIdentifier, stopReasonID: stopReasonId, notes: String(notes).slice(0, 50) }, doorCardIdentifier: cardIdentifier });
    return { outcome: r.outcome, ok: r.outcome === 'ok', message: safeMessage(fieldCI(r.json, 'message')) };
  }

  /** Lift a stop placed by freezeCard. */
  async unfreezeCard({ cardIdentifier, notes = 'Unfrozen by cardholder' }) {
    if (!cardIdentifier) throw pcError('BAD_INPUT', 'cardIdentifier is required');
    const r = await this._write('/card/stopcancel', { body: { cardIdentifier, notes: String(notes).slice(0, 50) }, doorCardIdentifier: cardIdentifier });
    return { outcome: r.outcome, ok: r.outcome === 'ok', message: safeMessage(fieldCI(r.json, 'message')) };
  }

  // Deliberately absent: /card/transfertoprofile (money back from a card). The spec gives it no
  // reference, so a timed-out call could not be checked and a retry could deduct twice.
}
