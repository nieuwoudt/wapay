/**
 * Cash-out pilot gate.
 *
 * Cash-out is the rail where money genuinely leaves, the thing that makes
 * WaPay look like e-money rather than a closed-loop voucher, and the locked
 * model is "KYC on withdrawal only" (required there). WAPAY_PAYOUT_ENABLED
 * alone opens withdrawal to EVERY customer in chat, so while counsel
 * clearance is outstanding a named-tester list must be able to narrow it,
 * and nothing may ADVERTISE withdrawal to someone the gate will refuse.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { payoutAllowedFor, payoutEnabled } from '../lib/payouts.js';

const processorSource = readFileSync(
  fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)),
  'utf8'
);

function withEnv(env, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('the switch off means nobody withdraws, allowlist or not', () => {
  withEnv({ WAPAY_PAYOUT_ENABLED: 'false', WAPAY_PAYOUT_ALLOWLIST: '27787051175' }, () => {
    assert.equal(payoutEnabled(), false);
    assert.equal(payoutAllowedFor('27787051175'), false);
  });
});

test('no allowlist keeps existing behaviour (everyone who passes the other gates)', () => {
  withEnv({ WAPAY_PAYOUT_ENABLED: 'true', WAPAY_PAYOUT_ALLOWLIST: undefined }, () => {
    assert.equal(payoutAllowedFor('27780000001'), true);
    assert.equal(payoutAllowedFor('27787051175'), true);
  });
});

test('an allowlist narrows withdrawal to named testers only', () => {
  withEnv({ WAPAY_PAYOUT_ENABLED: 'true', WAPAY_PAYOUT_ALLOWLIST: '27787051175' }, () => {
    assert.equal(payoutAllowedFor('27787051175'), true, 'the tester can withdraw');
    assert.equal(payoutAllowedFor('27780000001'), false, 'every other customer cannot');
    assert.equal(payoutAllowedFor(''), false);
    assert.equal(payoutAllowedFor(undefined), false);
  });
});

test('whitespace and multiple testers are handled', () => {
  withEnv({ WAPAY_PAYOUT_ENABLED: 'true', WAPAY_PAYOUT_ALLOWLIST: ' 27787051175 , 27780000002 ' }, () => {
    assert.equal(payoutAllowedFor('27787051175'), true);
    assert.equal(payoutAllowedFor('27780000002'), true);
    assert.equal(payoutAllowedFor('27780000003'), false);
  });
});

test('every customer-facing withdraw surface asks the PER-USER gate', () => {
  // The entry points that start the flow.
  assert.match(processorSource, /if \(payoutAllowedFor\(from\)\) \{\s*\n\s*const \{ matchWithdrawAsk \}/);
  assert.match(processorSource, /\['WITHDRAW', payoutAllowedFor\(from\)/);
  assert.match(processorSource, /topic === 'withdraw' && payoutAllowedFor\(from\)/);
  // The surfaces that ADVERTISE it: promising withdrawal to someone the
  // gate will refuse is the trap the fuel rollout already taught us.
  assert.match(processorSource, /payoutAllowedFor\(from\) \? `🏧 \*Withdraw\*/, 'home screen');
  assert.match(processorSource, /\$\{payoutAllowedFor\(from\) \? '🏧 \*Withdraw\*/, 'help menu');
  assert.match(processorSource, /withdrawLive: payoutAllowedFor\(from\)/, 'what the AI may claim');
});

test('no customer-facing surface still uses the global switch alone', () => {
  const userFacing = processorSource
    .split('\n')
    .filter((l) => /payoutEnabled\(\)/.test(l))
    .filter((l) => /Withdraw|withdrawLive|matchWithdrawAsk|topic === 'withdraw'/.test(l));
  assert.deepEqual(userFacing, [], `these still bypass the pilot gate:\n${userFacing.join('\n')}`);
});
