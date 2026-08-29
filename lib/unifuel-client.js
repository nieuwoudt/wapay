/**
 * UniFuel service client — WaPay's side of the service-to-service wiCode
 * pipeline (design: docs/UNIFUEL_INTEGRATION.md). UniFuel owns the Yoyo
 * integration; WaPay owns the wallet and the conversation.
 *
 * Outcome discipline (the BUGLOG #28 lesson, applied across a second hop):
 * - ISSUED  → settle the hold; the wiCode came back (bearer secret).
 * - FAILED  → release the hold; UniFuel/Yoyo definitively refused.
 * - UNKNOWN → the hold STAYS. A transport failure, 5xx, or in-flight order
 *   is indeterminate: the voucher may exist. Reconcile via orderStatus()
 *   (UniFuel settles the truth against Yoyo's userRef); never re-issue
 *   under a fresh reference, never release on UNKNOWN.
 *
 * Env: UNIFUEL_API_BASE_URL (e.g. https://unifuel.co), UNIFUEL_PARTNER_SECRET.
 * Credentials never logged; wiCodes never logged.
 */

const DEFAULT_TIMEOUT_MS = 20000;

function log(type, data) {
  console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));
}

export function isUnifuelConfigured() {
  return !!(process.env.UNIFUEL_API_BASE_URL && process.env.UNIFUEL_PARTNER_SECRET);
}

async function unifuelFetch(path, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = process.env.UNIFUEL_API_BASE_URL;
  const secret = process.env.UNIFUEL_PARTNER_SECRET;
  if (!base || !secret) {
    const e = new Error('UNIFUEL_NOT_CONFIGURED');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await resp.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    return { httpStatus: resp.status, body: json };
  } catch (error) {
    // Transport failure: indeterminate, NOT a failure.
    const e = new Error('UNIFUEL_TRANSPORT');
    e.code = 'TRANSPORT_INDETERMINATE';
    e.cause = String(error?.message || error).slice(0, 120);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Map a partner response to the ISSUED / FAILED / UNKNOWN contract. */
function classifyIssueResponse({ httpStatus, body }) {
  if (body?.status === 'issued' && body?.wicode) {
    return {
      outcome: 'ISSUED',
      wicode: body.wicode,
      giftcardId: body.giftcardId || null,
      expiryDate: body.expiryDate || null,
      balanceCents: Number.isInteger(body.balanceCents) ? body.balanceCents : null,
      orderNumber: body.orderNumber || null,
      testMode: body.testMode === true,
    };
  }
  // "issued" without a code yet (reconcile minted the card but not the
  // wiCode) is still in flight — retry the status endpoint.
  if (body?.status === 'issued') return { outcome: 'UNKNOWN', code: 'NO_WICODE_YET' };
  if (body?.status === 'failed') return { outcome: 'FAILED', code: body?.code || `HTTP_${httpStatus}` };
  if (body?.status === 'not_found') return { outcome: 'FAILED', code: 'NOT_FOUND' };
  // 4xx validation rejections that never created an order are definitive.
  if (httpStatus === 400) return { outcome: 'FAILED', code: body?.code || 'BAD_REQUEST' };
  return { outcome: 'UNKNOWN', code: body?.code || `HTTP_${httpStatus}` };
}

/**
 * Issue a wiCode against the customer's already-held wallet money.
 * @param {object} args
 * @param {string} args.reference   deterministic, epoch-free (wapay-fuel-<previewId>)
 * @param {number} args.amountCents integer cents
 * @param {'FUEL'|'RETAIL'} [args.productType]
 */
export async function issueWicode({ reference, amountCents, productType = 'FUEL' }) {
  if (!reference) throw new Error('reference required');
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('amountCents must be positive integer cents');
  try {
    const resp = await unifuelFetch('/api/partner/wapay/issue', {
      method: 'POST',
      body: { reference, amountCents, productType },
    });
    const outcome = classifyIssueResponse(resp);
    log('unifuel_issue', { reference, outcome: outcome.outcome, code: outcome.code || null });
    return outcome;
  } catch (error) {
    if (error.code === 'NOT_CONFIGURED') return { outcome: 'FAILED', code: 'NOT_CONFIGURED' };
    log('unifuel_issue', { reference, outcome: 'UNKNOWN', code: 'TRANSPORT' });
    return { outcome: 'UNKNOWN', code: 'TRANSPORT' };
  }
}

/**
 * Reconcile an indeterminate issuance. UniFuel settles the truth against
 * Yoyo (userRef lookup), so this eventually returns ISSUED or FAILED.
 */
export async function orderStatus(reference) {
  if (!reference) throw new Error('reference required');
  try {
    const resp = await unifuelFetch(`/api/partner/wapay/order?reference=${encodeURIComponent(reference)}`);
    const outcome = classifyIssueResponse(resp);
    log('unifuel_order_status', { reference, outcome: outcome.outcome, code: outcome.code || null });
    return outcome;
  } catch (error) {
    if (error.code === 'NOT_CONFIGURED') return { outcome: 'FAILED', code: 'NOT_CONFIGURED' };
    return { outcome: 'UNKNOWN', code: 'TRANSPORT' };
  }
}

/** The live redeemable product catalogue (data-driven merchant knowledge). */
export async function fetchCatalog() {
  const resp = await unifuelFetch('/api/partner/wapay/catalog');
  if (resp.body?.ok) return { ok: true, testMode: resp.body.testMode === true, products: resp.body.products || [] };
  return { ok: false };
}

/** WaPay-originated issuance/redemption aggregates for Mission Control. */
export async function fetchStats() {
  const resp = await unifuelFetch('/api/partner/wapay/stats');
  if (resp.body?.ok) return { ok: true, ...resp.body };
  return { ok: false };
}
