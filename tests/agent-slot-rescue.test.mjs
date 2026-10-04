/**
 * Clarify-step slot rescue (2026-10-04): the founder's "50 and 2" answer and
 * its neighbours, read the same way the withdraw flow reads them, with no
 * model call. Pure function cases plus a static lock on where the runtime
 * calls it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { rescueWithdrawSlots } from '../lib/agent/slot-rescue.js';

const pend = (slots = {}) => ({ action: 'WITHDRAW', slots });

test('"50 and 2": the amount is rescued, the bare menu number is left for the flow’s own menu', () => {
  assert.deepEqual(rescueWithdrawSlots({ pendingIntent: pend(), text: '50 and 2' }), { amountCents: 5000, method: null, rescued: ['amountCents'] });
  assert.deepEqual(rescueWithdrawSlots({ pendingIntent: pend(), text: 'R50, option 2' }), { amountCents: 5000, method: null, rescued: ['amountCents'] });
});

test('a method named in words is rescued, with the family fallback the flow uses', () => {
  assert.deepEqual(rescueWithdrawSlots({ pendingIntent: pend(), text: 'R50 to my FNB account' }), { amountCents: 5000, method: 'PAYSHAP', rescued: ['amountCents', 'method'] });
  assert.deepEqual(rescueWithdrawSlots({ pendingIntent: pend({ amountCents: 20000 }), text: 'cash at nedbank please' }), { amountCents: 20000, method: 'NEDCASH', rescued: ['method'] });
  assert.deepEqual(rescueWithdrawSlots({ pendingIntent: pend({ method: 'PAYSHAP' }), text: 'make it 100' }), { amountCents: 10000, method: 'PAYSHAP', rescued: ['amountCents'] });
  // Only methods actually offered can be rescued: a bank word with no bank method on offer yields null.
  assert.deepEqual(rescueWithdrawSlots({ pendingIntent: pend(), text: 'to my bank', options: ['NEDCASH', 'CASHSEND'] }), null);
});

test('the newest answer wins over what the model heard before', () => {
  assert.deepEqual(rescueWithdrawSlots({ pendingIntent: pend({ amountCents: 5000, method: 'RTC' }), text: 'R80 payshap' }), { amountCents: 8000, method: 'PAYSHAP', rescued: ['amountCents', 'method'] });
});

test('nothing usable, a negation, another intent, or an over-long message all go back to the model', () => {
  assert.equal(rescueWithdrawSlots({ pendingIntent: pend(), text: 'ok' }), null);
  assert.equal(rescueWithdrawSlots({ pendingIntent: pend(), text: '2' }), null, 'a bare menu number is not a method here');
  assert.equal(rescueWithdrawSlots({ pendingIntent: pend(), text: 'no, not cash' }), null);
  assert.equal(rescueWithdrawSlots({ pendingIntent: pend(), text: 'actually make it payshap' }), null, 'a correction with a hedge word is the model’s to read');
  assert.equal(rescueWithdrawSlots({ pendingIntent: { action: 'BUY_AIRTIME', slots: {} }, text: 'R50' }), null);
  assert.equal(rescueWithdrawSlots({ pendingIntent: null, text: 'R50' }), null);
  assert.equal(rescueWithdrawSlots({ pendingIntent: pend(), text: 'R50 ' + 'x'.repeat(170) }), null);
  assert.equal(rescueWithdrawSlots({ pendingIntent: pend({ amountCents: 'R50' }), text: 'cash' }).amountCents, null, 'a malformed pending amount is not trusted');
});

test('runtime lock: the rescue runs after the pack load and before the model, dispatches like a proposal, and is ledgered as its own path', () => {
  const src = readFileSync(fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)), 'utf8');
  assert.match(src, /import \{ rescueWithdrawSlots \} from '..\/..\/..\/lib\/agent\/slot-rescue.js'/);
  const fn = src.slice(src.indexOf('async function handleAgentTurn('), src.indexOf('async function handleAIChat('));
  const rescueAt = fn.indexOf('rescueWithdrawSlots({ pendingIntent, text');
  assert.ok(rescueAt > -1, 'the runtime calls the rescue');
  assert.ok(rescueAt > fn.indexOf('loadContextPack({ prisma, account })'), 'after the pack is loaded');
  assert.ok(rescueAt < fn.indexOf('runAgentTurn({'), 'before the model is called');
  assert.match(fn, /path: 'rescue', outcome: 'proposal'/);
  assert.match(fn, /payoutAllowedFor\(from\)[\s\S]*rescueWithdrawSlots/, 'never rescues for a number withdrawals are closed to');
});
