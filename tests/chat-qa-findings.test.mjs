/**
 * Regression guards for the first conversational QA run (2026-08-27):
 * - BUGLOG #31: bare "what/which/show/list" routed EVERY question to the
 *   products menu — the indicator now requires a commerce noun;
 * - AI-authored replies and static language confirmations carried em
 *   dashes into client copy (banned, founder decree);
 * - (BUGLOG #30, conversation history across state changes, is guarded in
 *   tests/conversation-data.test.mjs.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { LANGUAGE_CONFIRMATIONS } from '../lib/localize.js';

const processorSource = readFileSync(
  fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)),
  'utf8'
);

function extractIndicators() {
  const start = processorSource.indexOf('const productQueryIndicators = [');
  assert.ok(start > -1);
  const end = processorSource.indexOf('];', start);
  // eslint-disable-next-line no-new-func
  return new Function(`${processorSource.slice(start, end + 2)}; return productQueryIndicators;`)();
}

test('product-query indicators: personal questions never look like product asks (BUGLOG #31)', () => {
  const indicators = extractIndicators();
  const isProductQuery = (t) => indicators.some((p) => p.test(t.toLowerCase()));
  for (const q of [
    'What did I tell you my name was?',
    'What is my favourite colour?',
    'what time is it',
    'which language are we speaking',
    'show him this message',
  ]) {
    assert.ok(!isProductQuery(q), `must NOT read as a product ask: "${q}"`);
  }
  for (const q of [
    'show me vodacom bundles',
    'what data bundles do you have',
    'which airtime can I get',
    'what can I buy',
    'buy airtime',
    'can i buy electricity',
    'list products',
  ]) {
    assert.ok(isProductQuery(q), `must still read as a product ask: "${q}"`);
  }
});

test('the bare what/which indicator is gone from the source', () => {
  assert.ok(
    !processorSource.includes('/\\b(show|list|what|which)\\s+(me\\s+)?(your\\s+)?(the\\s+)?/i'),
    'the optional-groups-only pattern must never come back'
  );
});

test('language confirmations carry no em or en dashes', () => {
  for (const [lang, msg] of Object.entries(LANGUAGE_CONFIRMATIONS)) {
    assert.ok(!/[—–]/.test(msg), `em/en dash in ${lang} confirmation: ${msg}`);
  }
});

test('sanitizeUserText: strips em dashes from AI replies, still blocks JSON', () => {
  const start = processorSource.indexOf('function sanitizeUserText(');
  const end = processorSource.indexOf('\n}', start);
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${processorSource.slice(start, end + 2)}; return sanitizeUserText;`)();
  assert.equal(fn('Got it — I will remember that.'), 'Got it, I will remember that.');
  assert.equal(fn('range 9–5 works'), 'range 9, 5 works');
  assert.equal(fn('{"json": true}'), null);
  assert.equal(fn('   '), null);
  assert.equal(fn('plain reply'), 'plain reply');
});
