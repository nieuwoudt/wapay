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



test('mergeConversationData: HISTORY survives every state transition (BUGLOG #30)', () => {
  const history = [
    { role: 'user', text: 'my name is Thabo', timestamp: 't1' },
    { role: 'assistant', text: 'Nice to meet you Thabo', timestamp: 't2' },
  ];
  // entering a flow
  const enter = mergeConversationData({
    prevState: null,
    prevData: { history, processedMessageIds: ['m1'] },
    nextState: 'ELECTRICITY_AMOUNT',
    nextData: { amountCents: 5000 },
  });
  assert.deepEqual(enter.history, history, 'starting a flow must not drop history');
  assert.equal(enter.amountCents, 5000);
  // leaving a flow (state cleared)
  const leave = mergeConversationData({
    prevState: 'ELECTRICITY_AMOUNT',
    prevData: { history, amountCents: 5000 },
    nextState: null,
    nextData: null,
  });
  assert.deepEqual(leave.history, history, 'ending a flow must not drop history');
  assert.equal(leave.amountCents, undefined, 'state slots still reset');
  // an explicit next.history always wins
  const explicit = mergeConversationData({
    prevState: 'A',
    prevData: { history },
    nextState: 'B',
    nextData: { history: [{ role: 'user', text: 'newer', timestamp: 't3' }] },
  });
  assert.equal(explicit.history.length, 1);
  assert.equal(explicit.history[0].text, 'newer');
  // junk prev.history is ignored, not resurrected
  const junk = mergeConversationData({
    prevState: 'A',
    prevData: { history: 'not-an-array' },
    nextState: 'B',
    nextData: {},
  });
  assert.equal(junk.history, undefined);
});
