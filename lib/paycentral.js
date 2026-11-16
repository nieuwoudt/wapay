/**
 * PayCentral platform API client: prepaid Mastercard cards on the PayCentral rail
 * (DigiCentral virtual, CashCentral physical, FuelCentral). Spec: "PayCentral Staging
 * Platform API Specification v2.1.5", summarised in docs/CARDS.md sections 0.9 to 0.11.
 *
 * This module is the wire only. It moves no WaPay money: the ledger flow
 * (reserveHold, load, settleHold or releaseHold) belongs to the caller and is not built yet.
 *
 * ONE WHITELISTED ADDRESS (2026-11-16). PayCentral whitelists one IP (155.121.235.0), but
 * Vercel's Static IPs are a pair and Vercel cannot pin one of them. Both ways through are here:
 *   1. Door retry (staging). A call refused before PayCentral's application saw it is
 *      retried on a fresh connection, which may leave from the other address. "Refused at
 *      the door" means: the connection was refused or timed out while connecting, the TLS
 *      handshake was cut before any request was written, a proxy refused the tunnel, or the
 *      firewall answered 403 with no PayCentral JSON. Such a call never reached PayCentral,
 *      so the retry is safe for every call, money included.
 *      Anything that may have reached PayCentral (a reset or timeout after connecting, a 5xx)
 *      is never retried on a money call: it throws TRANSPORT_INDETERMINATE and the caller
 *      checks the load's reference with checkReference() before releasing any hold.
 *   2. One fixed egress (production). PAYCENTRAL_EGRESS_PROXY sends every PayCentral call
 *      through one HTTP proxy with one address of our own; that is the address PayCentral
 *      whitelists for production.
 *   GET /api/internal/paycentral-probe measures how often the door refuses us.
 *
 * CARD DATA (golden thread 3.5). virtualAllocate answers with the full card number and the
 * security code. Neither leaves this module: callers get seq_no, the last four digits and
 * the expiry. Every log line carries kinds and masks, never a card number, security code,
 * ID number, password or token.
 *
 * AMOUNTS. WaPay counts integer cents; PayCentral takes rands. Until PayCentral confirms that
 * a load may carry cents, an amount that is not whole rands is refused
 * (PAYCENTRAL_WHOLE_RANDS, default on).
 */

import crypto from 'node:crypto';
import { fetch as undiciFetch, Agent, ProxyAgent } from 'undici';

export const DEFAULT_BASE_URL = 'https://staging-api.paycentral.co.za';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_DOOR_ATTEMPTS = 6;
const DEFAULT_DOOR_BUDGET_MS = 15000;
const DEFAULT_READ_ATTEMPTS = 3;
const DOOR_BACKOFF_MS = 250;
const TOKEN_FALLBACK_TTL_MS = 30 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

/** Error codes raised before any byte of the request was written. */
const DOOR_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

function log(type, data) {
  console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));
}

function pcError(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

/** Whether the deployment has what the client needs (booleans only, never a value). */
export function payCentralConfigured(env = process.env) {
  return !!(env.PAYCENTRAL_API_EMAIL && env.PAYCENTRAL_API_PASSWORD);
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Every error code and message along an error's cause chain. */
function causeChain(err) {
  const out = [];
  let cur = err;
  for (let i = 0; cur && i < 5; i += 1) {
    out.push({ code: cur.code || cur.name || null, message: String(cur.message || '') });
    cur = cur.cause;
  }
  return out;
}

/**
 * Classify a transport error (fetch threw, no HTTP response).
 * 'DOOR'    : refused before the request was written; never reached PayCentral.
 * 'UNKNOWN' : may have reached PayCentral (reset or timeout after connecting).
 */
export function classifyTransportError(err) {
  for (const { code, message } of causeChain(err)) {
    if (code && DOOR_CODES.has(code)) return 'DOOR';
    if (/before secure TLS connection was established/i.test(message)) return 'DOOR';
    if (/Proxy response \(\d+\)/i.test(message)) return 'DOOR';
  }
  return 'UNKNOWN';
}

/** A 403 that is not PayCentral's JSON is the firewall turning the address away. */
export function isDoorRefusalResponse(httpStatus, json) {
  if (httpStatus !== 403) return false;
  return !(json && typeof json === 'object' && !json._raw && ('status' in json || 'message' in json || 'token' in json));
}

/** PayCentral answers {"status":"Success"} or {"success":true}, in varying case. */
export function isSuccess(json) {
  if (!json || typeof json !== 'object') return false;
  return String(json.status ?? '').toLowerCase() === 'success' || json.success === true || json.success === 'true';
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

/**
 * Integer cents → the rands string PayCentral takes. Whole rands only while
 * PAYCENTRAL_WHOLE_RANDS is on (the spec types amounts as integers but its examples load "0.1").
 */
export function centsToRands(cents, { wholeRands = true } = {}) {
  if (!Number.isInteger(cents) || cents <= 0) throw pcError('BAD_INPUT', `amount must be a positive integer number of cents, got ${cents}`);
  if (wholeRands && cents % 100 !== 0) throw pcError('AMOUNT_NOT_WHOLE_RANDS', 'PayCentral loads are whole rands until cents are confirmed');
  const rands = Math.trunc(cents / 100);
  const rest = cents % 100;
  return wholeRands ? String(rands) : `${rands}.${String(rest).padStart(2, '0')}`;
}

/** "52.00" | "25.4" | 25.4 | "-0.10" → integer cents (string-parsed, no float math), else null. */
export function randsToCents(raw) {
  const s = String(raw ?? '').trim().replace(/[\s,]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const negative = s.startsWith('-');
  const [intPart, decPart = ''] = s.replace('-', '').split('.');
  const cents = Number(intPart) * 100 + Number((decPart + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/**
 * A load's reference_no: digits, deterministic from our idemKey (a retry of the same load
 * carries the same reference), first digit never 0 (it is typed as an integer). The spec says
 * "any 12 digit (unique)"; PAYCENTRAL_REFERENCE_DIGITS changes the length once confirmed.
 */
export function loadReference(idemKey, digits = 12) {
  if (!idemKey) throw pcError('BAD_INPUT', 'loadReference needs the load idemKey');
  if (!Number.isInteger(digits) || digits < 8 || digits > 20) throw pcError('BAD_INPUT', 'reference length must be 8 to 20 digits');
  const hex = crypto.createHash('sha256').update(`paycentral-load|${idemKey}`).digest('hex');
  const first = (parseInt(hex[0], 16) % 9) + 1;
  const rest = (BigInt(`0x${hex.slice(1)}`) % 10n ** BigInt(digits - 1)).toString().padStart(digits - 1, '0');
  return `${first}${rest}`;
}

/** DD/MM/YYYY in South African time, the statement calls' date format. */
export function statementDate(d) {
  return new Date(d).toLocaleDateString('en-GB', { timeZone: 'Africa/Johannesburg' });
}

const mask = (v, keep = 3) => {
  const s = String(v ?? '');
  return s ? `•••${s.slice(-keep)}` : s;
};

/**
 * Deep copy with card numbers, security codes, ID numbers, contact details, passwords,
 * tokens and document contents masked. Every PayCentral body passes through this before it
 * is logged or stored. Any run of 13 or more digits anywhere is masked too (invariant 8).
 */
export function redactPayCentral(value) {
  const SECRET = /^(secure_code|cvv|cvc|cvv2|password|token|pin)$/i;
  const CARD = /^(card_no|cardnumber|card ?identifier|card number)$/i;
  const IDENTITY = /^(idorpassport|idorpassportnumber|id number|id_number|accountnumber|account number)$/i;
  const CONTACT = /^(cellphonenumber|emailid|email)$/i;
  const DOCUMENT = /documentcontent$/i;
  const walk = (v, key) => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    }
    if (v === null || v === undefined || typeof v === 'boolean') return v;
    const k = String(key || '');
    if (SECRET.test(k)) return '[hidden]';
    if (DOCUMENT.test(k)) return '[document]';
    if (CARD.test(k)) return /^\d{12,}$/.test(String(v).replace(/\s/g, '')) ? mask(String(v).replace(/\s/g, ''), 4) : v;
    if (IDENTITY.test(k) || CONTACT.test(k)) return mask(v);
    return typeof v === 'string' ? v.replace(/\d{13,}/g, (run) => mask(run, 4)) : v;
  };
  return walk(value, '');
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Tokens by base URL and login, shared by every client in this instance. */
const TOKENS = new Map();
/** One proxy dispatcher per proxy URL (one fixed address needs no fresh connections). */
const PROXY_DISPATCHERS = new Map();

export function _resetPayCentralState() {
  TOKENS.clear();
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
   * @param {number} [config.timeoutMs]
   * @param {number} [config.connectTimeoutMs]
   * @param {number} [config.doorAttempts] - attempts for a call refused at the door
   * @param {number} [config.doorBudgetMs] - stop retrying refused calls after this long
   * @param {number} [config.readAttempts] - attempts for a read that failed in flight
   * @param {number} [config.referenceDigits]
   * @param {Function} [config.fetchFn] - tests
   * @param {Function} [config.dispatcherFactory] - tests
   * @param {Function} [config.sleep] - tests
   */
  constructor(config = {}) {
    const env = process.env;
    this.base = String(config.baseUrl ?? env.PAYCENTRAL_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.email = config.email ?? env.PAYCENTRAL_API_EMAIL;
    this.password = config.password ?? env.PAYCENTRAL_API_PASSWORD;
    if (!this.email || !this.password) throw pcError('CONFIG', 'Missing PAYCENTRAL_API_EMAIL or PAYCENTRAL_API_PASSWORD');
    this.egressProxy = config.egressProxy ?? (env.PAYCENTRAL_EGRESS_PROXY || null);
    this.wholeRands = config.wholeRands ?? env.PAYCENTRAL_WHOLE_RANDS !== 'false';
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.doorAttempts = config.doorAttempts ?? Number(env.PAYCENTRAL_DOOR_ATTEMPTS || DEFAULT_DOOR_ATTEMPTS);
    this.doorBudgetMs = config.doorBudgetMs ?? DEFAULT_DOOR_BUDGET_MS;
    this.readAttempts = config.readAttempts ?? DEFAULT_READ_ATTEMPTS;
    this.referenceDigits = config.referenceDigits ?? Number(env.PAYCENTRAL_REFERENCE_DIGITS || 12);
    this.fetchFn = config.fetchFn ?? undiciFetch;
    this.dispatcherFactory = config.dispatcherFactory ?? null;
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The connection for one attempt: fresh without a proxy (so a retry may leave from the other address). */
  _dispatcher() {
    if (this.dispatcherFactory) return { dispatcher: this.dispatcherFactory(), fresh: true };
    if (this.egressProxy) {
      if (!PROXY_DISPATCHERS.has(this.egressProxy)) PROXY_DISPATCHERS.set(this.egressProxy, new ProxyAgent(this.egressProxy));
      return { dispatcher: PROXY_DISPATCHERS.get(this.egressProxy), fresh: false };
    }
    return { dispatcher: new Agent({ connect: { timeout: this.connectTimeoutMs } }), fresh: true };
  }

  /**
   * One HTTP exchange with door retries.
   * kind 'read'  : idempotent; also retried after an in-flight failure or a 5xx.
   * kind 'money' : moves value; only door refusals are retried, anything else is indeterminate.
   * kind 'state' : changes a card's state; treated like money.
   */
  async _send(path, { method = 'POST', body, query, token, kind, doorAttempts = this.doorAttempts }) {
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const started = Date.now();
    let doorTries = 0;
    let readTries = 0;

    for (;;) {
      const { dispatcher, fresh } = this._dispatcher();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let refusedAtDoor = false;
      let failure = null;
      try {
        const resp = await this.fetchFn(url.toString(), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          dispatcher,
        });
        const text = await resp.text();
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = { _raw: true };
        }
        if (isDoorRefusalResponse(resp.status, json)) {
          refusedAtDoor = true;
        } else if (resp.status >= 500) {
          failure = pcError(kind === 'read' ? 'SERVER_ERROR' : 'TRANSPORT_INDETERMINATE', `PayCentral answered ${resp.status}`, { httpStatus: resp.status });
        } else {
          log('paycentral_call', { path, httpStatus: resp.status, ok: isSuccess(json), doorRetries: doorTries });
          return { httpStatus: resp.status, json, doorRetries: doorTries };
        }
      } catch (err) {
        if (classifyTransportError(err) === 'DOOR') refusedAtDoor = true;
        else failure = pcError(kind === 'read' ? 'TRANSPORT_FAILED' : 'TRANSPORT_INDETERMINATE', `PayCentral transport failure on ${path}`, { indeterminate: kind !== 'read' });
      } finally {
        clearTimeout(timer);
        if (fresh && dispatcher?.close) dispatcher.close().catch(() => {});
      }

      if (refusedAtDoor) {
        doorTries += 1;
        log('paycentral_refused_at_door', { path, attempt: doorTries });
        if (doorTries >= doorAttempts || Date.now() - started > this.doorBudgetMs) {
          throw pcError('DOOR_REFUSED', `PayCentral refused the connection ${doorTries} times (address not whitelisted?)`, { attempts: doorTries });
        }
        await this.sleep(DOOR_BACKOFF_MS * doorTries);
        continue;
      }
      if (kind === 'read' && readTries + 1 < this.readAttempts) {
        readTries += 1;
        log('paycentral_read_retry', { path, attempt: readTries, code: failure.code });
        await this.sleep(DOOR_BACKOFF_MS * readTries);
        continue;
      }
      log('paycentral_call_failed', { path, code: failure.code, kind });
      throw failure;
    }
  }

  /** A bearer token, cached until a minute before it expires. */
  async _token({ fresh = false, doorAttempts } = {}) {
    const key = `${this.base}|${this.email}`;
    const cached = TOKENS.get(key);
    if (!fresh && cached && cached.expMs - TOKEN_REFRESH_MARGIN_MS > Date.now()) return cached.token;
    const r = await this._send('/authenticate', { body: { email: this.email, password: this.password }, kind: 'read', doorAttempts });
    const token = r.json?.token;
    if (!token) throw pcError('AUTH_FAILED', `PayCentral login failed: ${String(r.json?.message || r.httpStatus).slice(0, 120)}`, { httpStatus: r.httpStatus });
    TOKENS.set(key, { token, expMs: jwtExpiryMs(token) ?? Date.now() + TOKEN_FALLBACK_TTL_MS });
    return token;
  }

  /** An authenticated call; a 401 (rejected, so nothing happened) logs in again once. */
  async _call(path, opts) {
    let token = await this._token();
    let r = await this._send(path, { ...opts, token });
    if (r.httpStatus === 401) {
      token = await this._token({ fresh: true });
      r = await this._send(path, { ...opts, token });
    }
    return r;
  }

  /** Log in (the probe's check). Returns how many door refusals it took. */
  async authenticate({ fresh = true, doorAttempts } = {}) {
    const key = `${this.base}|${this.email}`;
    if (fresh) TOKENS.delete(key);
    const before = Date.now();
    await this._token({ fresh, doorAttempts });
    return { ok: true, ms: Date.now() - before };
  }

  /**
   * Issue a virtual card. Returns seq_no (use it as the card identifier), the last four digits
   * and the expiry. The card number and security code PayCentral returns are dropped here.
   * Not idempotent and carries no reference: never retry after TRANSPORT_INDETERMINATE.
   * Prefer loadCents 0 and a separate loadCard, which has a reference.
   */
  async virtualAllocate({ cellphoneNumber, firstName, lastName, idOrPassportNumber, loadCents = 0 }) {
    if (!cellphoneNumber || !firstName) throw pcError('BAD_INPUT', 'cellphoneNumber and firstName are required');
    const loadAmount = loadCents > 0 ? centsToRands(loadCents, { wholeRands: this.wholeRands }) : '0';
    const r = await this._call('/card/virtualAllocate', {
      body: { cellphoneNumber, firstName, lastName, idOrPassportNumber, loadAmount },
      kind: loadCents > 0 ? 'money' : 'state',
    });
    const j = r.json || {};
    const cardNo = String(j.card_no ?? '').replace(/\s/g, '');
    return {
      ok: isSuccess(j),
      message: String(j.message ?? '').slice(0, 200),
      seqNo: j.seq_no != null ? String(j.seq_no) : null,
      last4: cardNo.length >= 4 ? cardNo.slice(-4) : null,
      expiryDate: j.expiry_date ?? null,
    };
  }

  /** Assign a pre-printed physical card (by sequence or tracking number) to a cardholder. */
  async allocatePhysical({ cardIdentifier, firstName, lastName, idOrPassport, emailId, cellPhoneNumber, addressLine1, addressLine2 }) {
    if (!cardIdentifier || !firstName || !lastName || !idOrPassport || !cellPhoneNumber) {
      throw pcError('BAD_INPUT', 'cardIdentifier, names, idOrPassport and cellPhoneNumber are required');
    }
    const r = await this._call('/card/allocate', {
      body: { cardIdentifier, firstName, lastName, idOrPassport, emailId, cellPhoneNumber, addressLine1, addressLine2 },
      kind: 'state',
    });
    return { ok: isSuccess(r.json), message: String(r.json?.message ?? '').slice(0, 200) };
  }

  /**
   * Load a card from our profile. The reference is derived from the caller's load idemKey,
   * so a repeat of the same load carries the same reference. On TRANSPORT_INDETERMINATE the
   * error carries the reference: call checkReference() before releasing any hold.
   */
  async loadCard({ cardIdentifier, amountCents, idemKey, notes = 'WaPay load' }) {
    if (!cardIdentifier) throw pcError('BAD_INPUT', 'cardIdentifier is required');
    const amount = centsToRands(amountCents, { wholeRands: this.wholeRands });
    const reference = loadReference(idemKey, this.referenceDigits);
    try {
      const r = await this._call('/card/load', {
        body: { cardIdentifier, amount, notes: String(notes).slice(0, 50), reference_no: reference },
        kind: 'money',
      });
      return { ok: isSuccess(r.json), message: String(r.json?.message ?? '').slice(0, 200), reference };
    } catch (e) {
      e.reference = reference;
      throw e;
    }
  }

  /**
   * What PayCentral recorded for a reference (POST /get/auditlog). The spec's input example
   * spells the field "referance_no"; both spellings are sent. The meaning of the inner
   * response must be confirmed on staging before a flow settles or releases on it.
   */
  async checkReference(reference) {
    const r = await this._call('/get/auditlog', { body: { referance_no: String(reference), reference_no: String(reference) }, kind: 'read' });
    const j = r.json || {};
    const inner = j.message && typeof j.message === 'object' ? j.message : {};
    const response = inner.response && typeof inner.response === 'object' ? inner.response : {};
    return {
      found: isSuccess(j) && inner.success !== false,
      responseSuccess: response.success === true || response.success === 'true',
      responseMessage: String(response.message ?? '').slice(0, 200),
      record: redactPayCentral(inner),
    };
  }

  /** The card's balance in integer cents. */
  async cardBalance(cardIdentifier) {
    const r = await this._call('/card/balance', { method: 'GET', query: { cardIdentifier }, kind: 'read' });
    return { ok: isSuccess(r.json), balanceCents: randsToCents(r.json?.balance), message: String(r.json?.message ?? '').slice(0, 200) };
  }

  /** The card's transactions between two dates, amounts in integer cents. */
  async cardStatement({ cardIdentifier, from, to }) {
    const r = await this._call('/card/cards_statement', {
      body: { cardIdentifier, fromdate: statementDate(from), todate: statementDate(to) },
      kind: 'read',
    });
    const rows = Array.isArray(r.json?.response) ? r.json.response : [];
    return {
      ok: isSuccess(r.json),
      transactions: rows.map((t) => ({
        type: Number(t.transactionType),
        at: t.transaction_date ?? t.transactionDate ?? null,
        amountCents: randsToCents(t.transactionAmount),
        description: redactPayCentral(String(t.transactionDescription ?? '')).slice(0, 120),
        cardBalanceCents: randsToCents(t.card_balance),
      })),
    };
  }

  /** The cardholder record, masked (the raw record carries the card and ID numbers). */
  async cardInfo(cardIdentifier) {
    const r = await this._call('/card/info', { method: 'GET', query: { cardIdentifier }, kind: 'read' });
    return { ok: isSuccess(r.json), record: redactPayCentral(r.json || {}) };
  }

  /** Stop a card. Which stopReasonID values are reversible is still to be confirmed with PayCentral. */
  async freezeCard({ cardIdentifier, stopReasonId, notes = 'Frozen by cardholder' }) {
    if (!cardIdentifier || !Number.isInteger(stopReasonId)) throw pcError('BAD_INPUT', 'cardIdentifier and an integer stopReasonId are required');
    const r = await this._call('/card/cancel', { body: { cardIdentifier, stopReasonID: stopReasonId, notes: String(notes).slice(0, 50) }, kind: 'state' });
    return { ok: isSuccess(r.json), message: String(r.json?.message ?? '').slice(0, 200) };
  }

  /** Lift a stop placed by freezeCard. */
  async unfreezeCard({ cardIdentifier, notes = 'Unfrozen by cardholder' }) {
    if (!cardIdentifier) throw pcError('BAD_INPUT', 'cardIdentifier is required');
    const r = await this._call('/card/stopcancel', { body: { cardIdentifier, notes: String(notes).slice(0, 50) }, kind: 'state' });
    return { ok: isSuccess(r.json), message: String(r.json?.message ?? '').slice(0, 200) };
  }

  // Deliberately absent: /card/transfertoprofile (moving money back from a card). The spec
  // gives it no reference, so a timed-out call could not be checked and a retry could deduct
  // twice. Ask PayCentral for a reference before adding it.
}
