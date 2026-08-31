/**
 * OTT voucher SELF-purchase ("buy an OTT voucher") + the stale-content sweep
 * guards (2026-08-20).
 *
 * Locks:
 * - matchOttVoucherSelfRequest: purchase phrasings match; redemption-ish
 *   phrasings and messages carrying a recipient number do NOT;
 * - static wiring: the short-circuit runs before the AI; self-purchases get
 *   the in-session PIN delivery via the atomic claim flow; INSUFFICIENT_FUNDS
 *   becomes a top-up checkout moment, not an error;
 * - sweep guards: betting words never appear in WhatsApp-facing copy, the
 *   category menu renderer is coming-soon gated, and "what can I buy" only
 *   advertises live categories.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const processorSource = readFileSync(
  fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)),
  'utf8'
);

/** Extract a small top-level helper function and evaluate it. */
function extractFn(name) {
  const start = processorSource.indexOf(`function ${name}(`);
  assert.ok(start > -1, `processor must define ${name}`);
  const end = processorSource.indexOf('\n}', start);
  // eslint-disable-next-line no-new-func
  return new Function(`${processorSource.slice(start, end + 2)}; return ${name};`)();
}

// ---------------------------------------------------------------------------
// The self-purchase matcher
// ---------------------------------------------------------------------------

test('purchase phrasings match; redemption phrasings and gifts do not', () => {
  const m = extractFn('matchOttVoucherSelfRequest');
  for (const text of [
    'can I buy an ott voucher?',
    'buy OTT voucher',
    'ott voucher R50',
    'I want an OTT voucher for R100',
  ]) {
    assert.ok(m(text, {}), `should match: "${text}"`);
  }
  for (const [text, slots] of [
    ['redeem my ott voucher', {}],
    ['I have an OTT voucher', {}],
    ['load ott voucher 068086094638', {}],
    ['I received an ott voucher', {}],
    ['send an ott voucher to 0837654321', { msisdn: '0837654321' }],
    ['buy airtime', {}],
    // Information questions are NEVER purchases (founder screenshot
    // 2026-08-31: "Where is OTT vouchers accepted?" started the buy flow).
    ['Where is OTT vouchers accepted?', {}],
    ['where can I use an ott voucher', {}],
    ['what is an OTT voucher', {}],
    ['how do OTT vouchers work', {}],
    ['who accepts ott vouchers', {}],
  ]) {
    assert.ok(!m(text, slots), `must NOT match: "${text}"`);
  }
});

// ---------------------------------------------------------------------------
// Static wiring
// ---------------------------------------------------------------------------

test('static: the OTT short-circuit runs before the AI path', () => {
  const sc = processorSource.indexOf("intent: 'OTT_VOUCHER_SELF'");
  const ai = processorSource.indexOf('await orchestrate(');
  assert.ok(sc > -1 && ai > -1 && sc < ai, 'self-purchase must be intercepted deterministically');
});

test('static: self-purchase delivers the PIN in-session via the atomic claim flow', () => {
  assert.match(processorSource, /isSelfPurchase\s*\?/, 'receipt branches on self');
  assert.match(processorSource, /voucher_self_purchase_delivered/);
  assert.match(
    processorSource,
    /claimPendingGifts\(\{ recipientMsisdn: account\.msisdn \}\)/,
    'delivery reuses the ISSUED->DELIVERED claim guard'
  );
  assert.match(processorSource, /voucher_self_claim_deferred/, 'claim failure defers, never loses the PIN');
});

test('static: INSUFFICIENT_FUNDS is a checkout moment — direct link + resume', () => {
  assert.match(processorSource, /executeData\.error === 'INSUFFICIENT_FUNDS'/);
  assert.match(processorSource, /Pay the \$\{randsShort\(shortfallCents\)\} difference/);
  assert.match(processorSource, /'RESUME_VOUCHER_PURCHASE'/);
});

// ---------------------------------------------------------------------------
// Sweep guards (Meta policy + stale content)
// ---------------------------------------------------------------------------

test('sweep: betting words never appear in user-facing copy', () => {
  // String literals with betting words were scrubbed 2026-08-20 (Meta
  // policy: the WhatsApp surface must carry zero betting references).
  assert.ok(!processorSource.includes('Betting & Gaming'), 'no Betting & Gaming title');
  assert.ok(!processorSource.includes('betting operators'), 'no betting operators copy');
  assert.ok(!processorSource.includes('Betting top-ups'), 'no betting menu line');
  assert.ok(!processorSource.includes('🎰'), 'no slot-machine emoji');
  assert.ok(!processorSource.includes('Top up Hollywoodbets'), 'no bookmaker CTA');
});

test('sweep: category menus are coming-soon gated', () => {
  const start = processorSource.indexOf('async function showCategoryProducts');
  const head = processorSource.slice(start, start + 500);
  assert.match(head, /isCategoryLive\(category\)/, 'showCategoryProducts gates at the top');
  const vasList = processorSource.slice(processorSource.indexOf('async function handleListVasProducts'));
  assert.match(vasList.slice(0, 2000), /isCategoryLive\(cat\.category\)/, 'the what-can-I-buy card filters to live categories');
});

test('sweep: the money-rail words never map to media categories', () => {
  const mapStart = processorSource.indexOf('const categoryKeywords = {');
  const map = processorSource.slice(mapStart, mapStart + 900);
  assert.ok(!/LIFESTYLE: \[[^\]]*'ott'/.test(map), "'ott' must not map to LIFESTYLE");
  assert.ok(!/LIFESTYLE: \[[^\]]*'voucher'/.test(map), "'voucher' must not map to LIFESTYLE");
  assert.ok(!/REMITTANCE: \[[^\]]*'send money'/.test(map), "'send money' is WaPay's own feature");
});

test('sweep: legacy processor and chat module are gone', () => {
  assert.throws(
    () => readFileSync(fileURLToPath(new URL('../pages/api/webhooks/message-processor.js', import.meta.url))),
    'the dead V1 processor must stay deleted'
  );
  assert.throws(
    () => readFileSync(fileURLToPath(new URL('../packages/ai/src/chat.ts', import.meta.url))),
    'the dead chat module must stay deleted'
  );
});
