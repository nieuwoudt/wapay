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
  assert.match(body, /vouchers\s*\n?\s*\? `🎟️ Voucher Balance:/, 'gated on presence');
  assert.match(body, /: ''/, 'voucher-less users see the home screen unchanged');
  assert.match(body, /[Rr]eply "my vouchers"/, 'the line routes to the detailed list');
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

test('request-paid template fallback is env-gated and fires only on free-form failure', () => {
  // Moved to lib/request-notify.js (durable notifications, 2026-08-25).
  const notifySource = readFileSync(
    fileURLToPath(new URL('../lib/request-notify.js', import.meta.url)),
    'utf8'
  );
  assert.match(notifySource, /WAPAY_TEMPLATE_REQUEST_PAID/);
  const idx = notifySource.indexOf('WAPAY_TEMPLATE_REQUEST_PAID');
  const around = notifySource.slice(idx - 900, idx + 900);
  assert.match(around, /request_notify_requester_text_failed/, 'fallback fires only after the free-form failure is logged');
  assert.match(around, /if \(tplName\)/, 'unset env is silent');
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

// ---------------------------------------------------------------------------
// Voucher display honesty (founder 2026-08-27)
// ---------------------------------------------------------------------------

test('voucher history: yours vs sent-away split, balance line, buy-another footer, no resend hint', () => {
  const src = readFileSync(fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)), 'utf8');
  const fn = src.indexOf('async function handleVoucherHistory(');
  const body = src.slice(fn, src.indexOf('\n}\n', fn));
  // v1.3: fuel (wiCode) vouchers joined the list, so the header is
  // rail-neutral and each section names its network.
  assert.match(body, /Your vouchers/, 'the surface is named');
  assert.match(body, /stores that accept OTT vouchers/, 'the OTT section names its network');
  assert.match(body, /UniFuel fuel vouchers \(for participating stations\)/, 'the fuel section carries the UniFuel brand');
  assert.match(body, /Sent to others \(no longer yours\)/, 'gifted vouchers are visibly not yours');
  assert.match(body, /filter\(\(g\) => g\.status !== 'CANCELLED'\)/, 'balance excludes cancelled');
  assert.match(body, /Voucher Balance:/, 'the same label as the home screen');
  assert.match(body, /Want another\? Reply "buy a voucher/, 'buy-another CTA');
  assert.ok(!body.includes('voucher pin <last'), 'the resend hint is gone from this surface (keyword still works)');
  // The sent-away section must never print a serial: the SN belongs to the
  // recipient now, and the sender re-fetching PINs for gifted vouchers is
  // exactly what the wallet-PIN gate on resend exists to prevent surfacing.
  const sentFmt = body.slice(body.indexOf('const fmt'), body.indexOf('const mine'));
  assert.match(sentFmt, /sent \? `to \$\{maskMsisdn/, 'sent rows show the masked recipient, not the SN');
});

test('home: the voucher line is labelled Voucher Balance under Balance', () => {
  const src = readFileSync(fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)), 'utf8');
  const home = src.slice(src.indexOf('const home ='), src.indexOf('Just tell me what you need'));
  const bal = home.indexOf('Balance:');
  const vbal = home.indexOf('Voucher Balance:');
  assert.ok(bal > -1 && vbal > bal, 'Balance first, Voucher Balance directly under it');
});
