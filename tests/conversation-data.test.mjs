import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeConversationData } from '../lib/conversation-data.js';

test('mergeConversationData: preserves idempotency keys on state clear', () => {
  const prev = {
    processedMessageIds: ['m1', 'm2'],
    sentErrorKeys: ['e1'],
    amountCents: 1000,
  };

  const next = mergeConversationData({
    prevState: 'AIRTIME_PIN',
    prevData: prev,
    nextState: null,
    nextData: null,
  });

  assert.deepEqual(next.processedMessageIds, ['m1', 'm2']);
  // state changed -> reset
  assert.deepEqual(next.sentErrorKeys, []);
  // state-specific slot should be cleared (no carry-over)
  assert.equal(next.amountCents, undefined);
});

test('mergeConversationData: keeps sentErrorKeys when state unchanged', () => {
  const prev = {
    processedMessageIds: ['m1'],
    sentErrorKeys: ['flow1:INVALID_PHONE_NUMBER'],
    previewId: 'p1',
  };

  const next = mergeConversationData({
    prevState: null,
    prevData: prev,
    nextState: null,
    nextData: { some: 'value' },
  });

  assert.deepEqual(next.processedMessageIds, ['m1']);
  assert.deepEqual(next.sentErrorKeys, ['flow1:INVALID_PHONE_NUMBER']);
  assert.equal(next.some, 'value');
});


