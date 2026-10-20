// The send cap (docs/WHATSAPP_POLICY_COMPLIANCE.md, 2026-10-20): no code path may send a
// storm of texts to one number. lib/say.js refuses the ninth text inside twenty seconds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendWhatsAppText, configureSay, resetSendCap, sendCap, SEND_CAP_WINDOW_MS } from '../lib/say.js';

const prismaStub = { account: { findUnique: async () => null } };

test('send cap: eight texts pass, the ninth is refused, another number is unaffected, the window slides', async () => {
  const sent = [];
  configureSay({ transport: async (a) => { sent.push(a.to); return { ok: true, data: { messages: [{ id: 'm' }] } }; }, prisma: prismaStub });
  resetSendCap();
  let t = 1_000_000;
  const now = () => t;
  for (let i = 0; i < 8; i += 1) assert.equal((await sendWhatsAppText({ to: '27600000919', text: `m${i}`, now })).ok, true, `send ${i + 1}`);
  const ninth = await sendWhatsAppText({ to: '27600000919', text: 'storm', now });
  assert.deepEqual(ninth, { ok: false, error: 'SEND_CAP' });
  assert.equal(sent.length, 8, 'the transport never saw the ninth');
  assert.equal((await sendWhatsAppText({ to: '27600000918', text: 'other', now })).ok, true, 'another number has its own budget');
  t += SEND_CAP_WINDOW_MS + 1;
  assert.equal((await sendWhatsAppText({ to: '27600000919', text: 'later', now })).ok, true, 'after the window the number may be written to again');
  configureSay({ transport: null, prisma: null });
  resetSendCap();
});

test('send cap: the environment knob never goes below three and defaults to eight', () => {
  assert.equal(sendCap({}), 8);
  assert.equal(sendCap({ WAPAY_SEND_CAP: '10' }), 10);
  assert.equal(sendCap({ WAPAY_SEND_CAP: '1' }), 8, 'below three falls back to the default');
  assert.equal(sendCap({ WAPAY_SEND_CAP: 'abc' }), 8);
  assert.equal(SEND_CAP_WINDOW_MS, 20000);
});

test('a long text split into chunks counts as one message against the cap', async () => {
  let calls = 0;
  configureSay({ transport: async () => { calls += 1; return { ok: true, data: { messages: [{ id: 'm' }] } }; }, prisma: prismaStub });
  resetSendCap();
  const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${'x'.repeat(100)}`).join('\n\n');
  const now = () => 5_000_000;
  assert.equal((await sendWhatsAppText({ to: '27600000917', text: long, now })).ok, true);
  assert.ok(calls >= 2, 'the long text went as several chunks');
  for (let i = 0; i < 7; i += 1) assert.equal((await sendWhatsAppText({ to: '27600000917', text: `m${i}`, now })).ok, true);
  assert.equal((await sendWhatsAppText({ to: '27600000917', text: 'ninth', now })).error, 'SEND_CAP');
  configureSay({ transport: null, prisma: null });
  resetSendCap();
});
