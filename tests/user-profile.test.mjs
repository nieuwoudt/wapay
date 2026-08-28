/**
 * User memory/profile (lib/user-profile.js) — the bot gets to know each
 * customer. Stubbed prisma; plus static wiring over the processor and ITN.
 *
 * Locks:
 * - noteLanguage: preferred language = most evidence, never flipped by one
 *   foreign test line (the live isiZulu-"Okay" bug, 2026-08-20);
 * - noteDepositMethod/noteMeterNumber/noteInterest shapes and guards;
 * - all writers swallow DB failures (never break a money flow);
 * - static: profile context is injected into orchestrate, language/interests
 *   recorded per AI turn, ITN records CARD, redemption records VOUCHER,
 *   electricity success records the meter, and the deposit short-circuit
 *   offers BOTH methods when no preference is known.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  noteLanguage,
  noteDepositMethod,
  noteMeterNumber,
  noteInterest,
  formatProfileContext,
} from '../lib/user-profile.js';

const processorSource = readFileSync(
  fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)),
  'utf8'
);
const itnSource = readFileSync(
  fileURLToPath(new URL('../pages/api/payfast/itn.js', import.meta.url)),
  'utf8'
);

function stubPrisma(initialProfile = null) {
  const state = { profile: initialProfile, writes: [] };
  return {
    state,
    account: {
      findUnique: async () => ({ id: 'a1', profile: state.profile }),
      update: async ({ data }) => {
        state.profile = data.profile;
        state.writes.push(data.profile);
        return { id: 'a1', profile: data.profile };
      },
    },
    // updateProfile now merges atomically in Postgres (lib/profile-merge.js);
    // model the top-level jsonb `||` merge: values = [json, accountId].
    $executeRaw: async (_strings, ...vals) => {
      const patch = JSON.parse(vals[0]);
      state.profile = { ...(state.profile || {}), ...patch };
      state.writes.push(state.profile);
      return 1;
    },
  };
}

test('noteLanguage: preference follows the evidence, one foreign line never flips it', async () => {
  const stub = stubPrisma({ language: 'en', languageCounts: { en: 5 } });
  await noteLanguage({ prisma: stub, accountId: 'a1', language: 'zu' });
  assert.equal(stub.state.profile.language, 'en', 'en still preferred at 5 vs 1');
  assert.deepEqual(stub.state.profile.languageCounts, { en: 5, zu: 1 });

  // Sustained zu use eventually flips it — memory follows the person.
  for (let i = 0; i < 5; i += 1) await noteLanguage({ prisma: stub, accountId: 'a1', language: 'zu' });
  assert.equal(stub.state.profile.language, 'zu');
});

test("noteLanguage ignores 'other' and empty", async () => {
  const stub = stubPrisma();
  assert.equal(await noteLanguage({ prisma: stub, accountId: 'a1', language: 'other' }), null);
  assert.equal(await noteLanguage({ prisma: stub, accountId: 'a1', language: '' }), null);
  assert.equal(stub.state.writes.length, 0);
});

test('deposit method, meter and interests have guards and shapes', async () => {
  const stub = stubPrisma();
  await noteDepositMethod({ prisma: stub, accountId: 'a1', method: 'CARD' });
  assert.equal(stub.state.profile.preferredDepositMethod, 'CARD');
  assert.equal(await noteDepositMethod({ prisma: stub, accountId: 'a1', method: 'BITCOIN' }), null);

  await noteMeterNumber({ prisma: stub, accountId: 'a1', meterNumber: '000001020001' });
  assert.equal(stub.state.profile.lastMeterNumber, '000001020001');
  assert.equal(await noteMeterNumber({ prisma: stub, accountId: 'a1', meterNumber: '123' }), null);

  for (const t of ['data bundles', 'ott voucher', 'electricity', 'data bundles']) {
    await noteInterest({ prisma: stub, accountId: 'a1', topic: t });
  }
  assert.deepEqual(stub.state.profile.interests.slice(0, 2), ['data bundles', 'electricity'], 'dedup + newest first');
});

test('writers swallow DB failures', async () => {
  const boom = { account: { findUnique: async () => { throw new Error('db down'); }, update: async () => { throw new Error('db down'); } } };
  assert.equal(await noteDepositMethod({ prisma: boom, accountId: 'a1', method: 'CARD' }), null);
});

test('formatProfileContext renders compactly and empty when unknown', () => {
  assert.equal(formatProfileContext({}), '');
  const ctx = formatProfileContext({
    language: 'en',
    preferredDepositMethod: 'CARD',
    lastMeterNumber: '000001020001',
    interests: ['data'],
  });
  assert.match(ctx, /KNOWN USER PROFILE/);
  assert.match(ctx, /preferred language: en/);
  assert.match(ctx, /card\/PayFast/);
});

// ---------------------------------------------------------------------------
// Static wiring
// ---------------------------------------------------------------------------

test('static: profile is injected into orchestrate and written per AI turn', () => {
  assert.match(processorSource, /formatProfileContext\(profile\)/);
  assert.match(processorSource, /noteLanguage\(\{ accountId: account\.id, language: result\.language \}\)/);
  assert.match(processorSource, /noteInterest\(/);
});

test('static: rails record the deposit preference; electricity records the meter', () => {
  assert.match(itnSource, /noteDepositMethod\(\{ accountId, method: 'CARD' \}\)/);
  assert.match(processorSource, /noteDepositMethod\(\{ accountId: account\.id, method: 'VOUCHER' \}\)/);
  assert.match(processorSource, /noteMeterNumber\(\{ accountId: account\.id, meterNumber \}\)/);
});

test('static: unknown deposit preference offers BOTH methods', () => {
  assert.match(processorSource, /AWAITING_DEPOSIT_METHOD/);
  assert.match(processorSource, /depositProfile\.preferredDepositMethod/);
  assert.match(processorSource, /Reply \*1\* or \*2\*/);
});

test('static: voucher history + PIN-gated resend are wired', () => {
  assert.match(processorSource, /async function handleVoucherHistory/);
  assert.match(processorSource, /voucher history|my vouchers/i);
  assert.match(processorSource, /VOUCHER_PIN_RESEND_AUTH/);
  assert.match(processorSource, /verifyPIN\(\{ accountId: account\.id, pin: pinAttempt \}\)/, 'resend is wallet-PIN gated');
});

test('static: broke checkout hands over a PayFast link and resumes', () => {
  assert.match(processorSource, /RESUME_VOUCHER_PURCHASE/);
  assert.match(processorSource, /handleCardDepositLink\(\{\s*\n\s*from,\s*\n\s*account,\s*\n\s*amountCents: shortfallCents/, 'shortfall gets a direct link');
});

test('static: self voucher purchase carries no fee', () => {
  const previewSource = readFileSync(
    fileURLToPath(new URL('../pages/api/vas/voucher/preview.js', import.meta.url)),
    'utf8'
  );
  assert.match(previewSource, /isSelfPurchase \? 0 : flatFeeCents/);
  assert.match(processorSource, /Generating your OTT voucher/, 'self interstitial says generating, not sending');
});
