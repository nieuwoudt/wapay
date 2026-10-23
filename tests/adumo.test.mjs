import crypto from 'node:crypto';
/**
 * Adumo Online rail (lib/adumo.js + routes): the JWT is the only thing that
 * can approve money; the form carries exactly what the hosted page needs;
 * fees are rail-aware; PayFast stays the fallback and its own tests stay green.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  signJwtHs256, verifyJwtHs256, buildVirtualCheckout, verifyAdumoResponse, adumoMerchantReference, codeFromMerchantReference,
  amountString, autoSubmitHtml, adumoEnabled, primaryCardRail, ADUMO_PUBLIC_TEST, ADUMO_STAGING, ADUMO_LIVE, ADUMO_VIRTUAL_PATH,
} from '../lib/adumo.js';
import { paymentRequestFeeCents, cardRailFee } from '../lib/deposits.js';
import { RAIL, buildLoad, ACCT } from '../lib/ledger-core.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const cfg = { merchantId: ADUMO_PUBLIC_TEST.merchantId, applicationId: ADUMO_PUBLIC_TEST.applicationId3ds, jwtSecret: ADUMO_PUBLIC_TEST.jwtSecret, sandbox: true };

test('JWT HS256: round trip, tamper, wrong secret, expiry', () => {
  const t = signJwtHs256({ mref: 'PRABCDEF-1', amount: 38, cuid: 'X', auid: 'Y', exp: Math.floor(Date.now() / 1000) + 60 }, 's3cret');
  assert.equal(verifyJwtHs256(t, 's3cret').ok, true);
  assert.equal(verifyJwtHs256(t, 'other').error, 'BAD_SIGNATURE');
  const [h, p, s] = t.split('.');
  const tampered = `${h}.${Buffer.from(JSON.stringify({ mref: 'PRABCDEF-1', amount: 3800, cuid: 'X', auid: 'Y' })).toString('base64url')}.${s}`;
  assert.equal(verifyJwtHs256(tampered, 's3cret').error, 'BAD_SIGNATURE');
  assert.equal(verifyJwtHs256('nope', 's3cret').error, 'MALFORMED');
  const none = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${p}.`;
  assert.equal(verifyJwtHs256(none, 's3cret').error, 'BAD_ALG', 'alg=none is never accepted');
  const old = signJwtHs256({ exp: Math.floor(Date.now() / 1000) - 5 }, 's3cret');
  assert.equal(verifyJwtHs256(old, 's3cret').error, 'EXPIRED');
  // An empty secret verifies nothing, not even a token signed with the empty key (BUGLOG #114).
  const fh = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const fp = Buffer.from(JSON.stringify({ mref: 'PRABCDEF-1', amount: 38, exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
  const forged = `${fh}.${fp}.${crypto.createHmac('sha256', '').update(`${fh}.${fp}`).digest('base64url')}`;
  assert.equal(verifyJwtHs256(forged, '').error, 'NO_SECRET');
  assert.equal(verifyJwtHs256(forged, undefined).error, 'NO_SECRET');
});

test('checkout form: staging vs live action, every mandatory field, signed claims match the form', () => {
  const f = buildVirtualCheckout({ amountCents: 3800, merchantReference: 'PRFMXNPV-1', successUrl: 'https://pleasepayme.co.za/api/pay/adumo-return?code=PRFMXNPV', failUrl: 'https://pleasepayme.co.za/api/pay/adumo-return?code=PRFMXNPV', description: 'WaPay payment request PRFMXNPV', config: cfg });
  assert.equal(f.action, `${ADUMO_STAGING}${ADUMO_VIRTUAL_PATH}`);
  assert.equal(buildVirtualCheckout({ amountCents: 500, merchantReference: 'PRAAAAAA-1', successUrl: 'https://x/y', failUrl: 'https://x/z', config: { ...cfg, sandbox: false } }).action, `${ADUMO_LIVE}${ADUMO_VIRTUAL_PATH}`);
  for (const k of ['MerchantID', 'ApplicationID', 'MerchantReference', 'Amount', 'Token', 'RedirectSuccessfulURL', 'RedirectFailedURL', 'AuthoriseCurrencyCode']) assert.ok(f.fields[k], k);
  assert.equal(f.fields.Amount, '38.00'); assert.equal(f.fields.AuthoriseCurrencyCode, 'ZAR'); assert.equal(f.fields.MerchantReference, 'PRFMXNPV-1');
  const v = verifyJwtHs256(f.fields.Token, cfg.jwtSecret);
  assert.equal(v.ok, true);
  assert.equal(v.claims.mref, 'PRFMXNPV-1'); assert.equal(v.claims.amount, 38); assert.equal(v.claims.cuid, cfg.merchantId); assert.equal(v.claims.auid, cfg.applicationId);
  assert.ok(v.claims.exp - v.claims.iat === 900, 'short-lived token');
  assert.throws(() => buildVirtualCheckout({ amountCents: 500, merchantReference: 'PRAAAAAA-1', successUrl: 'http://evil/y', failUrl: 'https://x/z', config: { ...cfg, sandbox: false } }), /https/);
  assert.equal(amountString(123456), '1234.56');
  assert.equal(adumoMerchantReference('prfmxnpv', 3), 'PRFMXNPV-3'); assert.equal(codeFromMerchantReference('PRFMXNPV-3'), 'PRFMXNPV'); assert.equal(codeFromMerchantReference('PRFMXNPV'), 'PRFMXNPV'); assert.equal(codeFromMerchantReference('x'), null);
  const html = autoSubmitHtml(f);
  assert.match(html, /<form method="POST" action="https:\/\/staging-apiv3\.adumoonline\.com\/product\/payment\/v1\/initialisevirtual">/);
  assert.match(html, /name="Token" value="eyJ/); assert.match(html, /document\.forms\[0\]\.submit\(\)/); assert.match(html, /<noscript><button/);
  assert.ok(!/<script src/.test(html));
});

test('response decision: only a signed token with matching claims and a success result approves', () => {
  const mk = (claims, secret = cfg.jwtSecret) => ({ _RESPONSE_TOKEN: signJwtHs256(claims, secret), _RESULT: '0', _STATUS: 'APPROVED', _TRANSACTIONINDEX: 'T-1' });
  const good = { cuid: cfg.merchantId, auid: cfg.applicationId, mref: 'PRFMXNPV-1', amount: 38, result: 0, status: 'APPROVED', transactionIndex: 'ABC-123' };
  const ok = verifyAdumoResponse({ fields: mk(good), expected: { mref: 'PRFMXNPV-1', amountCents: 3800 }, config: cfg });
  assert.equal(ok.ok, true); assert.equal(ok.approved, true); assert.equal(ok.transactionIndex, 'ABC-123');
  assert.equal(verifyAdumoResponse({ fields: mk({ ...good, amount: 38.5 }), expected: { mref: 'PRFMXNPV-1', amountCents: 3800 }, config: cfg }).detail, 'amount', 'gross must match our intent');
  assert.equal(verifyAdumoResponse({ fields: mk({ ...good, mref: 'PROTHER-1' }), expected: { mref: 'PRFMXNPV-1', amountCents: 3800 }, config: cfg }).detail, 'mref');
  assert.equal(verifyAdumoResponse({ fields: mk({ ...good, cuid: 'someone-else' }), expected: { mref: 'PRFMXNPV-1', amountCents: 3800 }, config: cfg }).detail, 'cuid');
  assert.equal(verifyAdumoResponse({ fields: mk(good, 'wrong-secret'), expected: { mref: 'PRFMXNPV-1', amountCents: 3800 }, config: cfg }).error, 'BAD_SIGNATURE');
  assert.equal(verifyAdumoResponse({ fields: { _RESULT: '0', _STATUS: 'APPROVED' }, expected: { mref: 'PRFMXNPV-1', amountCents: 3800 }, config: cfg }).error, 'NO_TOKEN', 'unsigned success fields approve nothing');
  const declined = verifyAdumoResponse({ fields: mk({ ...good, result: -1, status: 'DECLINED' }), expected: { mref: 'PRFMXNPV-1', amountCents: 3800 }, config: cfg });
  assert.equal(declined.ok, true); assert.equal(declined.approved, false); assert.equal(declined.status, 'DECLINED');
  assert.equal(verifyAdumoResponse({ fields: mk({ ...good, result: 1 }), expected: { mref: 'PRFMXNPV-1', amountCents: 3800 }, config: cfg }).approved, true, 'successful with warning still paid');
  assert.equal(verifyAdumoResponse({ fields: mk({ cuid: cfg.merchantId, auid: cfg.applicationId, mref: 'PRFMXNPV-1', amount: 38 }), expected: { mref: 'PRFMXNPV-1', amountCents: 3800 }, config: cfg }).error, 'NO_RESULT_CLAIM');
  assert.equal(verifyAdumoResponse({ fields: mk({ cuid: cfg.merchantId, auid: cfg.applicationId, mref: 'PRFMXNPV-1', amount: '38.00', status: 'SETTLED' }), expected: { mref: 'PRFMXNPV-1', amountCents: 3800 }, config: cfg }).approved, true, 'string amount + status-only claims (webhook shape) still decide');
});

test('fees per rail: one price on every rail (founder 2026-10-23), free under R50, still env-tunable', () => {
  delete process.env.WAPAY_ADUMO_FEE_BPS; delete process.env.WAPAY_ADUMO_FEE_FIXED_CENTS;
  assert.deepEqual(cardRailFee('PAYFAST'), { bps: 420, fixedCents: 230 });
  assert.deepEqual(cardRailFee('ADUMO'), cardRailFee('PAYFAST'), 'Adumo charges what PayFast charges: the rail is never a price difference');
  assert.equal(paymentRequestFeeCents(10000), 650, 'PayFast: R2.30 + 4.20% → R6.50');
  for (const c of [5000, 10000, 50000, 72000, 300000]) assert.equal(paymentRequestFeeCents(c, 'ADUMO'), paymentRequestFeeCents(c), `same fee at ${c}`);
  assert.equal(paymentRequestFeeCents(4900, 'ADUMO'), 0, 'free under R50 on every rail');
  // Adumo's true cost incl the VAT we cannot recover: debit R0.92 + 1.6675%, credit R0.92 + 2.8175%,
  // international R0.92 + 3.335%, Ozow R1.38 + 1.725%, Capitec Pay R1.38 + 2.30%. At the PayFast price
  // every method is margin-positive from R60 up. (R50 to R60 is the taper across the free threshold:
  // a deliberate, bounded subsidy so NET never falls as the amount rises.)
  for (let c = 6000; c <= 300000; c += 2500) {
    for (const [fixed, rate, method] of [[92, 0.016675, 'debit'], [92, 0.028175, 'credit'], [92, 0.03335, 'international'], [138, 0.01725, 'Ozow'], [138, 0.023, 'Capitec Pay']]) {
      assert.ok(paymentRequestFeeCents(c, 'ADUMO') - (fixed + Math.ceil(c * rate)) > 0, `${method} margin at ${c}`);
    }
  }
  // A later price decision stays an env change.
  process.env.WAPAY_ADUMO_FEE_BPS = '300'; process.env.WAPAY_ADUMO_FEE_FIXED_CENTS = '150';
  assert.equal(paymentRequestFeeCents(10000, 'ADUMO'), 450);
  delete process.env.WAPAY_ADUMO_FEE_BPS; delete process.env.WAPAY_ADUMO_FEE_FIXED_CENTS;
  // VAT registration day: one switch grosses every card fee up by 15% (R6.50 → R7.48 → R7.50 after 10c rounding); off = unchanged.
  process.env.WAPAY_VAT_REGISTERED = 'true';
  assert.equal(paymentRequestFeeCents(10000, 'ADUMO'), 750);
  assert.equal(paymentRequestFeeCents(10000), 750, 'PayFast R6.50 → R7.48 → R7.50');
  assert.equal(paymentRequestFeeCents(4900, 'ADUMO'), 0, 'still free under R50');
  delete process.env.WAPAY_VAT_REGISTERED;
  assert.equal(paymentRequestFeeCents(10000, 'ADUMO'), 650);
  assert.equal(RAIL.ADUMO, 'ADUMO');
  const e = buildLoad({ accountId: 'a1', rail: RAIL.ADUMO, faceCents: 3420, customerFeeCents: 380, idemKey: 'wapay-payreq-PRX' });
  assert.equal(e.postings.find((p) => p.accountCode === ACCT.clearing('ADUMO')).debitCents, 3800, 'gross lands in Adumo clearing');
  assert.equal(e.postings.find((p) => p.accountCode === ACCT.wallet('a1', 'SPEND')).creditCents, 3420);
});

test('switches: Adumo is off until configured AND enabled; primary rail defaults to Adumo when on', () => {
  const off = {};
  assert.equal(adumoEnabled(off), false); assert.equal(primaryCardRail(off), 'PAYFAST');
  const on = { WAPAY_ADUMO_ENABLED: 'true', ADUMO_MERCHANT_ID: 'm', ADUMO_APPLICATION_ID: 'a', ADUMO_JWT_SECRET: 's' };
  assert.equal(adumoEnabled(on), true); assert.equal(primaryCardRail(on), 'ADUMO');
  assert.equal(primaryCardRail({ ...on, WAPAY_PRIMARY_CARD_RAIL: 'PAYFAST' }), 'PAYFAST');
  assert.equal(adumoEnabled({ ...on, ADUMO_JWT_SECRET: '' }), false, 'no secret, no rail');
});

test('routes: checkout books the chosen rail and its fee; the return + webhook settle only on a verified token; PayFast path untouched', () => {
  const checkout = read('../pages/api/pay/checkout.js');
  assert.match(checkout, /const rail = adumoEnabled\(\) && \(askedRail === 'adumo'/);
  assert.match(checkout, /rail === 'ADUMO' \? paymentRequestFeeCents\(amountCents, 'ADUMO'\) : paymentRequestFeeCents\(amountCents\)/);
  assert.match(checkout, /provider: rail,/); assert.match(checkout, /adumoMerchantReference\(code, attempt\)/); assert.match(checkout, /autoSubmitHtml\(form\)/);
  assert.ok(checkout.indexOf("if (rail === 'ADUMO') {") < checkout.indexOf('buildCheckoutUrl({'), 'Adumo branch before the PayFast redirect');
  const ret = read('../pages/api/pay/adumo-return.js');
  assert.ok(ret.indexOf('verifyAdumoResponse(') < ret.indexOf('settleCardPayment('), 'verify before money');
  assert.match(ret, /if \(!v\.approved\)/); assert.match(ret, /\?e=unverified/);
  const hook = read('../pages/api/webhooks/adumo.js');
  assert.ok(hook.indexOf('verifyAdumoResponse(') < hook.indexOf('settleCardPayment('));
  assert.match(hook, /res\.status\(401\)\.json\(\{ ok: false, error: v\.error \}\)/);
  const settle = read('../lib/card-settlement.js');
  assert.match(settle, /idemKey: intent\.idemKey/, 'the ledger dedupes on the intent key');
  assert.match(settle, /CRITICAL_REFUND_NEEDED/);
  const page = read('../pages/pay/[code].js');
  assert.match(page, /name="rail"\s+value=\{adumo \? 'adumo' : 'payfast'\}/);
  assert.match(page, /Other ways to pay \(PayFast\)/);
  // Enabled is not offered: while WAPAY_PRIMARY_CARD_RAIL=PAYFAST (the live R5 tests) payers see PayFast only.
  assert.match(page, /const adumo = adumoEnabled\(\) && primaryCardRail\(\) === 'ADUMO';/);
});
