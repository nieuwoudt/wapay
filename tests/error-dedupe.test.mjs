import test from 'node:test';
import assert from 'node:assert/strict';

import { sendTextOnce } from '../lib/error-guard.js';

test('sendTextOnce: sends only once per errorKey', async () => {
  const sent = [];
  const store = new Set();

  const wasSent = async (_to, key) => store.has(key);
  const markSent = async (_to, key) => store.add(key);
  const send = async ({ to, text }) => {
    sent.push({ to, text });
    return { ok: true };
  };

  await sendTextOnce({ to: '277...', errorKey: 'flow1:INVALID_PHONE_NUMBER', text: 'Nope', wasSent, markSent, send });
  await sendTextOnce({ to: '277...', errorKey: 'flow1:INVALID_PHONE_NUMBER', text: 'Nope', wasSent, markSent, send });
  await sendTextOnce({ to: '277...', errorKey: 'flow1:INVALID_PHONE_NUMBER', text: 'Nope', wasSent, markSent, send });

  assert.equal(sent.length, 1);
});


