/**
 * Voucher balance on the home screen + balance answer (founder ask
 * 2026-08-24), the pay-link CTA button, and the requester-notify template
 * fallback.
 *
 * Locks:
 * - voucherBalanceSummary counts SELF-bought vouchers only (gifts to others
 *   were given away), excludes CANCELLED, and is best-effort — a balance
 *   surface must never fail on the voucher query;
 * - the home screen and CHECK_BALANCE render the voucher line ONLY when
 *   there is something to show, and the copy says "bought" — OTT gives us
 *   no redemption visibility yet, so we never promise "unspent";
 * - the requester's pay-link copy is a CTA BUTTON with a plain-text
 *   fallback, while the FORWARDABLE message keeps the visible URL
 *   (WhatsApp strips interactive buttons on forward — the link is the
 *   payer's only road in);
 * - the ITN requester confirm falls back to the env-gated
 *   WAPAY_TEMPLATE_REQUEST_PAID template when free-form is rejected
 *   (requests can be paid days later, outside the service window).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const processorSource = read('../pages/api/webhooks/message-processor-v2.js');
const itnSource = read('../pages/api/payfast/itn.js');

function fnBody(name) {
  const start = processorSource.indexOf(`async function ${name}(`);
  assert.ok(start > -1, `processor must define ${name}`);
  return processorSource.slice(start, processorSource.indexOf('\n}', start));
}

// ---------------------------------------------------------------------------
// voucherBalanceSummary
// ---------------------------------------------------------------------------

test('voucher summary: self-only, cancelled excluded, best-effort', () => {
  const body = fnBody('voucherBalanceSummary');
  assert.match(body, /status: \{ not: 'CANCELLED' \}/, 'cancelled vouchers never count');
  assert.match(body, /normaliseMsisdn\(r\.recipientMsisdn\) === own/, 'gifts to others are excluded');
  assert.match(body, /voucher_balance_error/, 'errors are logged, not thrown');
  assert.match(body, /return null/, 'error and empty paths render the surface without the line');
});

test('home screen: voucher line only when there is something to show', () => {
  const start = processorSource.indexOf('async function renderHome(');
  const body = processorSource.slice(start, processorSource.indexOf('logStructured(\'home_render\'', start));
  assert.match(body, /await voucherBalanceSummary\(account\)/);
  assert.match(body, /vouchers\s*\n?\s*\? `🎟️ Vouchers bought:/, 'gated on presence');
  assert.match(body, /: ''/, 'voucher-less users see the home screen unchanged');
  assert.match(body, /reply "my vouchers"/, 'the line routes to the detailed list');
});

test('CHECK_BALANCE: voucher line rides the deterministic balance answer', () => {
  const idx = processorSource.indexOf("case 'CHECK_BALANCE': {");
  const body = processorSource.slice(idx, processorSource.indexOf("case 'DEPOSIT_STATUS'", idx));
  assert.match(body, /voucherBalanceSummary\(account\)/);
  assert.match(body, /Vouchers you've bought/, 'copy says BOUGHT — we cannot see OTT-side redemption yet');
  assert.ok(!/unspent|still active/i.test(body), 'no unspent/active promise until OTT gives us redemption status');
});

// ---------------------------------------------------------------------------
// Pay-link CTA
// ---------------------------------------------------------------------------

test('pay-link: requester sees a CTA button, with a plain-text fallback', () => {
  const body = fnBody('handleCreatePaymentRequest');
  assert.match(body, /sendWhatsAppCtaUrl\(\{/);
  assert.match(body, /buttonText: 'View my payment page'/);
  assert.match(body, /if \(!interactive\?\.ok\)/, 'presentation must never block a request');
});

test('pay-link: the forwardable message keeps the visible URL', () => {
  const body = fnBody('handleCreatePaymentRequest');
  const fwd = body.indexOf('const forwardable');
  assert.ok(fwd > -1);
  assert.match(body.slice(fwd), /\$\{url\}/, 'forwarded buttons are stripped by WhatsApp — the payer needs the link as text');
});

// ---------------------------------------------------------------------------
// ITN requester-notify template fallback
// ---------------------------------------------------------------------------

test('ITN: request-paid template fallback is env-gated and fires only on free-form failure', () => {
  assert.match(itnSource, /WAPAY_TEMPLATE_REQUEST_PAID/);
  const idx = itnSource.indexOf('WAPAY_TEMPLATE_REQUEST_PAID');
  const around = itnSource.slice(idx - 700, idx + 900);
  assert.match(around, /if \(!confirmSent\?\.ok\)/, 'the fallback lives inside the failed-send branch');
  assert.match(around, /requestCode && paidTemplate/, 'deposits never use it; unset env is silent');
  assert.match(around, /payfast_itn_confirm_template_error/, 'template failure is observable');
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

test('new copy: no betting words, no cash-out promises', () => {
  for (const body of [fnBody('voucherBalanceSummary'), fnBody('handleCreatePaymentRequest')]) {
    assert.ok(!/\bbet(s|ting|tor|ted)?\b|\bgambl|\bwager|\bcasino|\bbookmak/i.test(body));
    assert.ok(!/cash\s*-?\s*out|withdraw/i.test(body));
  }
});
