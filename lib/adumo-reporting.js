/**
 * Adumo Online Enterprise reporting: the read side of the card rail.
 *
 * The hosted page (lib/adumo.js) tells us a payment's outcome through the
 * payer's browser and, once enabled, a webhook. Both can fail to arrive: a
 * payer who pays and closes the tab, a webhook lost in a deploy. This client
 * asks Adumo directly what became of a transaction, by our merchant
 * reference or by Adumo's transaction id, and the reconciler settles a
 * PENDING pay-link intent when Adumo says SETTLED for the same gross amount.
 *
 * Source: the public Postman workspace "Adumo Online" (Enterprise (Rest API)
 * > Reporting) and developers.adumoonline.com/enterprise.php, read
 * 2026-09-29. OAuth 2.0 client credentials, then Bearer:
 *   POST {base}/oauth/token?grant_type=client_credentials&client_id&client_secret
 *   GET  {base}/products/payments/v1/card/getState/{transactionId}
 *   GET  {base}/products/payments/v1/card/getState?merchantReference=…&applicationUid=…
 * {base} = https://staging-apiv3.adumoonline.com (test) / https://apiv3.adumoonline.com.
 * Test client credentials are published on the enterprise page (staging only).
 *
 * Env: ADUMO_CLIENT_ID, ADUMO_CLIENT_SECRET (from the merchant portal),
 *      ADUMO_SANDBOX=true for staging. Nothing here rotates a credential;
 *      the token endpoint only issues short-lived bearer tokens.
 *
 * Money rule: a transaction Adumo reports as AUTHORISED or SETTLED for the
 * same gross credits, once, through the same idempotent settleCardPayment
 * the return and webhook use. AUTHORISED is the state the hosted page leaves
 * an approved card in (proven on staging 2026-09-29: the return route's
 * signed "approved" token and getState AUTHORISED are the same event; Adumo
 * settles in its batch, which is why the live merchant must have auto
 * settlement on). A TDS, pending, declined, refunded, unknown or unreadable
 * answer credits nothing and is recorded on the intent.
 */

import prisma from './prisma.js';
import { adumoConfig, ADUMO_STAGING, ADUMO_LIVE } from './adumo.js';
import { settleCardPayment as realSettleCardPayment } from './card-settlement.js';

const log = (type, data) => console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));

export const ADUMO_TOKEN_PATH = '/oauth/token';
export const ADUMO_GETSTATE_PATH = '/products/payments/v1/card/getState';
/** Adumo's transaction states as seen in the collection (2026-09-29). */
export const ADUMO_STATES = Object.freeze({
  SETTLED: 'SETTLED',
  AUTHORISED: 'AUTHORISED',
  REFUNDED: 'REFUNDED',
  TDS_AUTH_REQUIRED: 'TDS_AUTH_REQUIRED',
  TDS_AUTH_NOT_REQUIRED: 'TDS_AUTH_NOT_REQUIRED',
});

export function adumoReportingConfig(env = process.env) {
  const base = adumoConfig(env).sandbox ? ADUMO_STAGING : ADUMO_LIVE;
  return {
    base: String(env.ADUMO_ENTERPRISE_BASE_URL || base).replace(/\/+$/, ''),
    clientId: String(env.ADUMO_CLIENT_ID || '').trim(),
    clientSecret: String(env.ADUMO_CLIENT_SECRET || ''),
    applicationId: adumoConfig(env).applicationId,
    merchantId: adumoConfig(env).merchantId,
  };
}
export function adumoReportingConfigured(env = process.env) {
  const c = adumoReportingConfig(env);
  return !!(c.clientId && c.clientSecret);
}

/**
 * What a state means for OUR books.
 *   settled: the card was approved (AUTHORISED, the hosted page's end state) or captured
 *            (SETTLED) → credit (once) if the amount matches
 *   pending: still in flight (a 3-D Secure step not completed, initiated) → leave the intent alone
 *   failed: nothing to credit → leave the intent PENDING (a pay link can be retried), record it
 */
export function classifyAdumoState(state) {
  const s = String(state || '').toUpperCase();
  if (s === 'SETTLED' || s === 'AUTHORISED') return { settled: true, pending: false, failed: false };
  if (s === 'TDS_AUTH_REQUIRED' || s === 'TDS_AUTH_NOT_REQUIRED' || s === 'PENDING' || s === 'INITIATED') return { settled: false, pending: true, failed: false };
  if (s === 'REFUNDED' || s === 'REVERSED' || s === 'DECLINED' || s === 'FAILED' || s === 'TIMED_OUT' || s === 'CANCELLED' || s === 'USER_CANCELLED') return { settled: false, pending: false, failed: true };
  return { settled: false, pending: true, failed: false, unknown: true };
}

export class AdumoReportingClient {
  constructor({ config = adumoReportingConfig(), fetchImpl = globalThis.fetch, timeoutMs = 8000, now = () => Date.now() } = {}) {
    if (!config.clientId || !config.clientSecret) throw new Error('Adumo reporting is not configured (ADUMO_CLIENT_ID / ADUMO_CLIENT_SECRET)');
    this.config = config;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this._token = null; // { value, expiresAt }
  }

  async _request(method, url, { headers = {}, body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await this.fetch(url, { method, headers, body, signal: controller.signal });
      const text = await resp.text();
      let json;
      try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw: text.slice(0, 300) }; }
      return { httpStatus: resp.status, body: json };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Bearer token, cached until a minute before Adumo says it expires. */
  async token() {
    const now = this.now();
    if (this._token && this._token.expiresAt > now) return this._token.value;
    const q = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.config.clientId, client_secret: this.config.clientSecret });
    const { httpStatus, body } = await this._request('POST', `${this.config.base}${ADUMO_TOKEN_PATH}?${q}`, { headers: { Accept: 'application/json' } });
    if (httpStatus !== 200 || !body?.access_token) {
      const e = new Error(`Adumo OAuth failed (${httpStatus})`);
      e.code = 'ADUMO_AUTH';
      e.httpStatus = httpStatus;
      throw e;
    }
    const ttlMs = Math.max(30, Number(body.expires_in) || 600) * 1000;
    this._token = { value: String(body.access_token), expiresAt: now + ttlMs - 60_000 };
    return this._token.value;
  }

  async _get(url) {
    const bearer = await this.token();
    const { httpStatus, body } = await this._request('GET', url, { headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' } });
    if (httpStatus === 404) return { found: false, httpStatus, body };
    if (httpStatus !== 200) {
      const e = new Error(`Adumo getState failed (${httpStatus})`);
      e.code = 'ADUMO_HTTP';
      e.httpStatus = httpStatus;
      e.body = body;
      throw e;
    }
    return { found: true, httpStatus, state: normaliseState(body), body };
  }

  /** Reporting: the state of a transaction by Adumo's transaction id (the hosted page's _TRANSACTIONINDEX). */
  async getStateByTransactionId(transactionId) {
    if (!/^[0-9a-fA-F-]{8,64}$/.test(String(transactionId || ''))) throw new Error('transactionId required');
    return this._get(`${this.config.base}${ADUMO_GETSTATE_PATH}/${encodeURIComponent(transactionId)}`);
  }

  /** Reporting: the state of a transaction by OUR merchant reference (scoped to the application when known). */
  async getStateByMerchantReference(merchantReference, { applicationUid = this.config.applicationId, merchantUid } = {}) {
    if (!merchantReference) throw new Error('merchantReference required');
    const q = new URLSearchParams({ merchantReference: String(merchantReference) });
    if (applicationUid) q.set('applicationUid', applicationUid);
    else if (merchantUid) q.set('merchantUid', merchantUid);
    return this._get(`${this.config.base}${ADUMO_GETSTATE_PATH}?${q}`);
  }
}

/** The fields we keep from a getState answer, typed and capped. */
export function normaliseState(body = {}) {
  const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    paymentType: body.paymentType ? String(body.paymentType).slice(0, 24) : null,
    transactionState: body.transactionState ? String(body.transactionState).slice(0, 32) : null,
    merchantReference: body.merchantReference ? String(body.merchantReference).slice(0, 64) : null,
    amountCents: num(body.amount) === null ? null : Math.round(num(body.amount) * 100),
    authorisedCents: num(body.authorisedAmount) === null ? null : Math.round(num(body.authorisedAmount) * 100),
    settledCents: num(body.settledAmount) === null ? null : Math.round(num(body.settledAmount) * 100),
    refundedCents: num(body.refundedAmount) === null ? null : Math.round(num(body.refundedAmount) * 100),
    currencyCode: body.currencyCode ? String(body.currencyCode).slice(0, 3) : null,
    errorMessage: body.errorMessage ? String(body.errorMessage).slice(0, 160) : null,
    ...classifyAdumoState(body.transactionState),
  };
}

function grossOf(intent) {
  const m = intent?.metadata || {};
  return Number.isInteger(m.grossCents) ? m.grossCents : Number(m.amountCents || 0) + Number(m.feeCents || 0);
}

/**
 * Reconcile ONE Adumo pay-link intent against Adumo's reporting.
 * Credits only on SETTLED with the settled amount equal to our gross; every
 * other answer is stamped on the intent and changes no money.
 */
export async function reconcileAdumoIntent({ prisma: prismaClient = prisma, client, settle = realSettleCardPayment, intent, now = new Date() }) {
  const mref = intent?.metadata?.adumoRef;
  if (!mref) return { ok: false, error: 'NO_REFERENCE', code: intent?.metadata?.requestCode || null };
  if (intent.status !== 'PENDING') return { ok: true, noop: true, status: intent.status, mref };
  let probe;
  try {
    probe = await client.getStateByMerchantReference(mref);
  } catch (error) {
    log('adumo_reconcile_error', { mref, code: error?.code || 'TRANSPORT', httpStatus: error?.httpStatus || null });
    return { ok: true, status: 'PENDING', checked: false, error: error?.code || 'TRANSPORT', mref };
  }
  const stamp = (extra) => prismaClient.providerRequest.update({ where: { idemKey: intent.idemKey }, data: { metadata: { ...intent.metadata, adumoReport: { at: now.toISOString(), found: probe.found, ...(probe.state || {}), ...extra } } } }).catch(() => {});
  if (!probe.found) {
    await stamp({});
    log('adumo_reconcile_not_found', { mref });
    return { ok: true, status: 'PENDING', checked: true, found: false, mref };
  }
  const st = probe.state;
  const gross = grossOf(intent);
  if (st.settled) {
    // The amount Adumo holds or captured must be OUR gross, byte for byte in cents.
    const paidCents = st.transactionState === 'SETTLED' ? st.settledCents : st.authorisedCents;
    if (paidCents !== gross) {
      await stamp({ mismatch: 'AMOUNT' });
      console.error(JSON.stringify({ type: 'adumo_reconcile_amount_mismatch', severity: 'NEEDS_OPERATOR', mref, transactionState: st.transactionState, paidCents, grossCents: gross }));
      return { ok: true, status: 'PENDING', checked: true, found: true, mismatch: 'AMOUNT', mref };
    }
    await stamp({});
    const out = await settle({ prisma: prismaClient, intent, rail: 'ADUMO', providerRef: probe.body?.transactionId || mref, payerMsisdn: intent.metadata?.payerMsisdn || null });
    log('adumo_reconcile_settled', { mref, ok: out.ok, replayed: out.replayed });
    return { ok: out.ok, status: out.ok ? 'SETTLED' : 'PENDING', checked: true, found: true, replayed: out.replayed, mref, accountId: intent.metadata?.accountId || null, amountCents: intent.metadata?.amountCents ?? null };
  }
  await stamp({});
  log(st.failed ? 'adumo_reconcile_failed_at_adumo' : 'adumo_reconcile_pending', { mref, transactionState: st.transactionState });
  return { ok: true, status: 'PENDING', checked: true, found: true, transactionState: st.transactionState, mref };
}

/** Every Adumo pay-link intent still PENDING after the grace period, oldest first. */
export async function reconcileAdumoIntents({ prisma: prismaClient = prisma, client = null, settle = realSettleCardPayment, olderThanMs = 5 * 60 * 1000, limit = 20, now = Date.now() } = {}) {
  const rows = await prismaClient.providerRequest.findMany({
    where: { provider: 'ADUMO', status: 'PENDING', requestTs: { lt: new Date(now - olderThanMs) } },
    orderBy: { requestTs: 'asc' },
    take: Math.min(100, Math.max(1, Number(limit) || 20)),
  });
  if (rows.length === 0) return [];
  const c = client || new AdumoReportingClient();
  const results = [];
  for (const intent of rows) {
    results.push(await reconcileAdumoIntent({ prisma: prismaClient, client: c, settle, intent, now: new Date(now) }));
  }
  return results;
}
