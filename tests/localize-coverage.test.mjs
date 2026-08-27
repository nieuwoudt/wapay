/**
 * Localization coverage — deterministic surfaces speak the user's language.
 *
 * The 2026-08-25 batch localized home/help/get-paid/airtime; the 2026-08-27
 * sweep extended it to every deterministic prompt, confirmation and receipt
 * in the money flows (state machine, orchestrator dispatch, product lists,
 * deposit status, voucher history). These statics lock that coverage so a
 * future copy edit can't silently ship a new English-only surface into a
 * flow that already speaks isiZulu.
 *
 * Deliberately NOT localized (and locked below):
 * - bearer voucher claim messages (buildVoucherClaimMessage) — a bearer
 *   artifact is delivered verbatim, never through a translation model;
 * - messages to OTHER parties (gift recipients, requesters being notified)
 *   — their language is their own profile's business, not the sender's.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)),
  'utf8'
);

test('coverage floor: the sweep stays swept', () => {
  const count = (src.match(/localizeOutbound\(/g) || []).length;
  assert.ok(
    count >= 150,
    `expected ≥150 localizeOutbound call sites, found ${count} — a refactor dropped localization coverage`
  );
});

test('key money surfaces are localized', () => {
  // One representative per flow family: if any of these loses its wrap the
  // founder's isiZulu testers get English again on a core journey.
  const surfaces = [
    'Your WaPay Balance', // CHECK_BALANCE
    'Confirm Airtime Purchase', // AIRTIME_CONFIRM prompt
    'Confirm Electricity', // electricity confirm preview
    'Confirm OTT Voucher', // voucher self-purchase confirm
    'Voucher Redeemed Successfully', // Blu redemption receipt
    'Tap the link to pay', // the forwardable pay-request message (copy rewritten 2026-08-27: Pay-name-now style)
  ];
  for (const marker of surfaces) {
    const idx = src.indexOf(marker);
    assert.ok(idx > -1, `marker not found: ${marker}`);
    // The wrap sits within a short window before the copy itself.
    const windowStart = Math.max(0, idx - 600);
    const window = src.slice(windowStart, idx);
    assert.ok(
      window.includes('localizeOutbound('),
      `surface "${marker}" is no longer localized (no localizeOutbound within 600 chars before it)`
    );
  }
});

test('bearer voucher claim messages are NEVER localized', () => {
  // A translation model must never sit between a bearer PIN artifact and
  // the customer. The claim builder's output goes out verbatim.
  const re = /localizeOutbound\(\s*buildVoucherClaimMessage/;
  assert.ok(!re.test(src), 'buildVoucherClaimMessage output must be sent verbatim, never translated');
});

test('localization is always paired with the user language lookup', () => {
  // Every processor call passes the profile language — never a hardcoded
  // language, never the raw text of the message as the language arg.
  const calls = src.match(/localizeOutbound\([^;]{0,1200}?\)\)/gs) || [];
  const unpaired = (src.match(/localizeOutbound\(/g) || []).length - (src.match(/await userLang\(account\)/g) || []).length;
  assert.ok(
    unpaired <= 0,
    `${unpaired} localizeOutbound call(s) without a matching userLang(account) lookup`
  );
  assert.ok(calls.length > 0);
});
