/**
 * Adumo Online (Nedbank acquiring via SHB Financial Services) — the hosted
 * "Virtual" payment page as a second card rail next to PayFast (founder
 * decision 2026-09-10 after the SHB offer: credit 2.35%, debit 1.35%, plus
 * R0.80 + 0.10% gateway, all ex VAT).
 *
 * Flow (developers.adumoonline.com → Virtual):
 *   our checkout → auto-submitting form POST to
 *     {staging|live}/product/payment/v1/initialisevirtual with MerchantID,
 *     ApplicationID, MerchantReference, Amount and a JWT (HS256 over our
 *     JWT secret; claims cuid, auid, mref, amount) → Adumo hosts card /
 *     Instant EFT / Capitec Pay / Apple & Google Pay → browser comes back to
 *     RedirectSuccessfulURL or RedirectFailedURL carrying _RESPONSE_TOKEN, a
 *     JWT signed with the same secret. Async methods also POST a webhook.
 *
 * Trust model: ONLY the signed response token decides. Its signature must
 * verify, its cuid/auid/mref/amount must match the intent we created, and
 * its `result` claim must say success. The unsigned _RESULT/_STATUS fields
 * are for display and forensics, never for money.
 *
 * Env: ADUMO_MERCHANT_ID, ADUMO_APPLICATION_ID, ADUMO_JWT_SECRET,
 *      ADUMO_SANDBOX=true (staging), WAPAY_ADUMO_ENABLED=true,
 *      WAPAY_PRIMARY_CARD_RAIL=ADUMO|PAYFAST (default ADUMO once enabled).
 */

import crypto from 'node:crypto';

export const ADUMO_STAGING = 'https://staging-apiv3.adumoonline.com';
export const ADUMO_LIVE = 'https://apiv3.adumoonline.com';
export const ADUMO_VIRTUAL_PATH = '/product/payment/v1/initialisevirtual';
/** Adumo's PUBLISHED sandbox values (developers.adumoonline.com/virtual.php); test cards 4111 1111 1111 1111 (ok) / 4242 4242 4242 4242 (declined), 3DS OTP 1234. */
export const ADUMO_PUBLIC_TEST = {
  merchantId: '9BA5008C-08EE-4286-A349-54AF91A621B0',
  applicationId3ds: '23ADADC0-DA2D-4DAC-A128-4845A5D71293',
  applicationIdNo3ds: '904A34AF-0CE9-42B1-9C98-B69E6329D154',
  jwtSecret: 'yglTxLCSMm7PEsfaMszAKf2LSRvM2qVW',
};
export const MREF_MAX = 38;
export const TOKEN_TTL_S = 15 * 60;
/**
 * Hosted-page flows that skip the payment-options page and land the payer on
 * one method (developers.adumoonline.com/virtual.php, "Possible flows").
 * Empty = Adumo's options page. OTT_VOUCHER lets a payer settle a WaPay pay
 * link with an OTT voucher through Adumo, once the live merchant carries it.
 */
export const ADUMO_FLOWS = Object.freeze(['CARD', 'CARD_VERIFICATION', 'EFT_ADUMO', 'EFT_OZOW', 'MOBICRED', 'MASTER_PASS', 'ZAPPER', 'CLICK_TO_PAY', 'OTT_VOUCHER']);
export function adumoFlow(raw) {
  const f = String(raw || '').trim().toUpperCase();
  return ADUMO_FLOWS.includes(f) ? f : null;
}

export function adumoConfig(env = process.env) {
  return {
    merchantId: String(env.ADUMO_MERCHANT_ID || '').trim(),
    applicationId: String(env.ADUMO_APPLICATION_ID || '').trim(),
    jwtSecret: String(env.ADUMO_JWT_SECRET || ''),
    sandbox: env.ADUMO_SANDBOX === 'true',
  };
}
export function adumoConfigured(env = process.env) {
  const c = adumoConfig(env);
  return !!(c.merchantId && c.applicationId && c.jwtSecret);
}
export function adumoEnabled(env = process.env) {
  return env.WAPAY_ADUMO_ENABLED === 'true' && adumoConfigured(env);
}
/** Which rail the pay page leads with and the portal quotes. */
export function primaryCardRail(env = process.env) {
  if (!adumoEnabled(env)) return 'PAYFAST';
  return String(env.WAPAY_PRIMARY_CARD_RAIL || 'ADUMO').toUpperCase() === 'PAYFAST' ? 'PAYFAST' : 'ADUMO';
}
export function adumoBase(env = process.env) {
  return adumoConfig(env).sandbox ? ADUMO_STAGING : ADUMO_LIVE;
}

// ---------------------------------------------------------------------------
// JWT (HS256) — small and explicit; no library, no surprises
// ---------------------------------------------------------------------------
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

export function signJwtHs256(claims, secret) {
  if (!secret) throw new Error('JWT secret required');
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify(claims));
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

/** @returns {{ok: boolean, claims?: object, error?: string}} */
export function verifyJwtHs256(token, secret, { now = Date.now() } = {}) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return { ok: false, error: 'MALFORMED' };
    const [h, p, s] = parts;
    const header = JSON.parse(fromB64u(h).toString('utf8'));
    if (!/^HS256$/i.test(String(header.alg || ''))) return { ok: false, error: 'BAD_ALG' };
    const expected = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest();
    const got = fromB64u(s);
    if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return { ok: false, error: 'BAD_SIGNATURE' };
    const claims = JSON.parse(fromB64u(p).toString('utf8'));
    if (claims && typeof claims.exp === 'number' && claims.exp * 1000 < now) return { ok: false, error: 'EXPIRED' };
    return { ok: true, claims };
  } catch {
    return { ok: false, error: 'MALFORMED' };
  }
}

export function amountString(cents) {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error(`amountString requires positive integer cents, got ${cents}`);
  return (cents / 100).toFixed(2);
}

/** A merchant reference Adumo accepts (≤38 chars) that we can map back to the request code. */
export function adumoMerchantReference(code, attempt = 1) {
  return `${String(code).toUpperCase()}-${Math.max(1, Number(attempt) | 0)}`.slice(0, MREF_MAX);
}
export function codeFromMerchantReference(mref) {
  const m = String(mref || '').toUpperCase().match(/^([A-Z]{6,12})(?:-\d+)?$/);
  return m ? m[1] : null;
}

/**
 * The form the payer's browser POSTs to Adumo's hosted page.
 * @returns {{action: string, fields: Record<string,string>, claims: object}}
 */
export function buildVirtualCheckout({ amountCents, merchantReference, successUrl, failUrl, description, recipient, ipAddress, notificationUrl, flow, config = adumoConfig(), now = Date.now() }) {
  if (!config.merchantId || !config.applicationId || !config.jwtSecret) throw new Error('Adumo is not configured');
  if (!/^https:\/\//.test(successUrl) || !/^https:\/\//.test(failUrl)) {
    if (!(config.sandbox && /^http:\/\/localhost/.test(successUrl))) throw new Error('redirect URLs must be https');
  }
  const mref = String(merchantReference || '').slice(0, MREF_MAX);
  if (!mref) throw new Error('merchantReference required');
  const amount = amountString(amountCents);
  const iat = Math.floor(now / 1000);
  const claims = { iss: 'WaPay', cuid: config.merchantId, auid: config.applicationId, mref, amount: Number(amount), iat, exp: iat + TOKEN_TTL_S };
  // A per-transaction webhook (virtual.php, JWT: "notificationURL can be used to send a webhook per
  // transaction in addition to the ones configured in the merchant portal"): an async method
  // (Instant EFT, Capitec Pay) or a payer who never comes back still reaches settlement.
  if (notificationUrl) {
    if (!/^https:\/\//.test(notificationUrl) && !(config.sandbox && /^http:\/\/localhost/.test(notificationUrl))) throw new Error('notificationUrl must be https');
    claims.notificationURL = String(notificationUrl).slice(0, 255);
  }
  const fields = {
    MerchantID: config.merchantId,
    ApplicationID: config.applicationId,
    MerchantReference: mref,
    Amount: amount,
    Token: signJwtHs256(claims, config.jwtSecret),
    AuthoriseCurrencyCode: 'ZAR',
    RedirectSuccessfulURL: successUrl,
    RedirectFailedURL: failUrl,
    CountryCode: 'ZA',
  };
  if (description) fields.OrderDescription = String(description).slice(0, 255);
  if (recipient) fields.Recipient = String(recipient).slice(0, 255);
  if (ipAddress) fields.IPAddress = String(ipAddress).slice(0, 255);
  const f = adumoFlow(flow);
  if (f) fields.flow = f;
  return { action: `${adumoBase({ ADUMO_SANDBOX: config.sandbox ? 'true' : '' })}${ADUMO_VIRTUAL_PATH}`, fields, claims };
}

const same = (a, b) => String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase();
const APPROVED_STATUS = /^(APPROVED|SETTLED|AUTHORI[SZ]ED|SUCCESS(FUL)?)$/i;

/**
 * Decide a payment from Adumo's signed response token. Nothing unsigned can
 * approve money. `expected.amountCents` is the GROSS the payer was asked for
 * (our intent), never anything from the response.
 * @returns {{ok: boolean, approved?: boolean, status?: string, transactionIndex?: string|null, errorCode?: string|null, errorMessage?: string|null, claims?: object, error?: string, detail?: string}}
 */
export function verifyAdumoResponse({ fields = {}, expected, config = adumoConfig(), now = Date.now() }) {
  const token = fields._RESPONSE_TOKEN || fields._response_token || fields.token || fields.Token || null;
  if (!token) return { ok: false, error: 'NO_TOKEN' };
  const v = verifyJwtHs256(token, config.jwtSecret, { now });
  if (!v.ok) return { ok: false, error: v.error };
  const c = v.claims || {};
  if (!same(c.cuid, config.merchantId)) return { ok: false, error: 'CLAIM_MISMATCH', detail: 'cuid' };
  if (!same(c.auid, config.applicationId)) return { ok: false, error: 'CLAIM_MISMATCH', detail: 'auid' };
  if (expected?.mref && !same(c.mref, expected.mref)) return { ok: false, error: 'CLAIM_MISMATCH', detail: 'mref' };
  if (expected?.amountCents != null) {
    const want = Number(amountString(expected.amountCents));
    if (Math.round(Number(c.amount) * 100) !== Math.round(want * 100)) return { ok: false, error: 'CLAIM_MISMATCH', detail: 'amount' };
  }
  const resultClaim = c.result !== undefined ? String(c.result) : null;
  const statusClaim = c.status || c.transactionStatus || null;
  if (resultClaim === null && !statusClaim) return { ok: false, error: 'NO_RESULT_CLAIM' };
  const approved = resultClaim === '0' || resultClaim === '1' || (resultClaim === null && APPROVED_STATUS.test(String(statusClaim)));
  const str = (v, n) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, n));
  const pan = str(fields._PANHASHED, 24);
  return {
    ok: true,
    approved,
    status: String(statusClaim || fields._STATUS || (approved ? 'APPROVED' : 'DECLINED')).slice(0, 40),
    transactionIndex: String(c.transactionIndex || c.tid || fields._TRANSACTIONINDEX || '').slice(0, 64) || null,
    errorCode: fields._ERROR_CODE ? String(fields._ERROR_CODE).slice(0, 8) : null,
    errorMessage: fields._ERROR_MESSAGE ? String(fields._ERROR_MESSAGE).slice(0, 160) : null,
    // Unsigned, for the books and the fee truth (debit vs credit vs EFT), never for the decision.
    method: str(fields._PAYMETHOD, 40),
    methodClass: adumoMethodClass(fields._PAYMETHOD),
    panMasked: pan && /^\d{6}\*+\d{4}$/.test(pan) ? pan : null,
    cardCountry: str(fields._CARDCOUNTRY, 3),
    bankErrorCode: str(fields._BANK_ERROR_CODE, 8),
    bankErrorMessage: str(fields._BANK_ERROR_MESSAGE, 120),
    threeDStatus: str(fields._3DSTATUS, 2),
    acquirerDateTime: str(fields._ACQUIRERDATETIME, 32),
    puid: str(c.puid || fields.puid, 64),
    claims: c,
  };
}

/** CARD / EFT / WALLET / VOUCHER / OTHER from Adumo's free-text _PAYMETHOD ("ePay Virtual", "SID", "Mobicred", "Visa Checkout"). */
export function adumoMethodClass(payMethod) {
  const m = String(payMethod || '').toUpperCase();
  if (!m) return null;
  if (/EFT|OZOW|SID|CAPITEC|BANK/.test(m)) return 'EFT';
  if (/OTT|VOUCHER/.test(m)) return 'VOUCHER';
  if (/APPLE|GOOGLE|SAMSUNG|MASTERPASS|ZAPPER|CLICK|WALLET|SNAPSCAN/.test(m)) return 'WALLET';
  if (/MOBICRED/.test(m)) return 'CREDIT';
  if (/VIRTUAL|CARD|VISA|MASTER|AMEX|DINERS|MAESTRO/.test(m)) return 'CARD';
  return 'OTHER';
}

/**
 * The metadata fragment a route stores on the intent after a verified
 * response (approved or not): what Adumo said, with nothing a payer could be
 * identified by beyond the PCI-safe masked PAN.
 */
export function adumoOutcomeRecord(v, { via = 'return', now = new Date() } = {}) {
  return {
    adumoOutcome: {
      via,
      at: now.toISOString(),
      approved: !!v.approved,
      status: v.status || null,
      transactionIndex: v.transactionIndex || null,
      method: v.method || null,
      methodClass: v.methodClass || null,
      panMasked: v.panMasked || null,
      cardCountry: v.cardCountry || null,
      errorCode: v.errorCode || null,
      bankErrorCode: v.bankErrorCode || null,
      bankErrorMessage: v.bankErrorMessage || null,
      threeDStatus: v.threeDStatus || null,
      puid: v.puid || null,
    },
  };
}

/** HTML that hands the browser to Adumo: a self-submitting form (no script = a button). */
export function autoSubmitHtml({ action, fields, title = 'Taking you to the secure payment page…' }) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const inputs = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{font:16px system-ui,sans-serif;background:#f4f6f5;color:#0b1411;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center;padding:24px}button{font:inherit;padding:12px 18px;border:0;border-radius:12px;background:#359853;color:#fff}</style></head><body><main><p>${esc(title)}</p><form method="POST" action="${esc(action)}">${inputs}<noscript><button type="submit">Continue to secure payment</button></noscript></form></main><script>document.forms[0].submit()</script></body></html>`;
}
