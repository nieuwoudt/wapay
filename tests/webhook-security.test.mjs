/**
 * Tests for WhatsApp webhook signature verification and dedupe extraction.
 * These are the guard between "a real message from Meta" and "a forged money
 * flow from anyone who found the URL", so they are worth being thorough about.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import {
  checkInboundWebhook,
  extractMessageId,
  verifySignature,
} from '../lib/webhook-security.js';

const SECRET = 'test_app_secret';

function sign(body, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

test('verifySignature: accepts a correctly signed body', () => {
  const body = JSON.stringify({ hello: 'world' });
  assert.equal(verifySignature(body, sign(body), SECRET), true);
});

test('verifySignature: rejects a tampered body', () => {
  const body = JSON.stringify({ amount: 50 });
  const header = sign(body);
  const tampered = JSON.stringify({ amount: 5000 });
  assert.equal(verifySignature(tampered, header, SECRET), false);
});

test('verifySignature: rejects the wrong secret', () => {
  const body = 'payload';
  assert.equal(verifySignature(body, sign(body, 'other_secret'), SECRET), false);
});

test('verifySignature: rejects malformed headers', () => {
  const body = 'payload';
  const good = sign(body).split('=')[1];
  assert.equal(verifySignature(body, good, SECRET), false, 'missing scheme');
  assert.equal(verifySignature(body, 'sha1=' + good, SECRET), false, 'wrong scheme');
  assert.equal(verifySignature(body, 'sha256=', SECRET), false, 'empty digest');
  assert.equal(verifySignature(body, '', SECRET), false, 'empty header');
  assert.equal(verifySignature(body, undefined, SECRET), false, 'no header');
});

test('verifySignature: rejects when no secret is configured', () => {
  const body = 'payload';
  assert.equal(verifySignature(body, sign(body), ''), false);
  assert.equal(verifySignature(body, sign(body), undefined), false);
});

test('verifySignature: a non-hex digest of the right length does not throw', () => {
  const body = 'payload';
  // 64 'z' chars — right length for sha256 hex, but not valid hex.
  assert.equal(verifySignature(body, 'sha256=' + 'z'.repeat(64), SECRET), false);
});

test('checkInboundWebhook: valid signature passes', () => {
  const body = JSON.stringify({ ok: true });
  const res = checkInboundWebhook({
    rawBody: body,
    signatureHeader: sign(body),
    appSecret: SECRET,
    env: { NODE_ENV: 'production' },
  });
  assert.equal(res.ok, true);
});

test('checkInboundWebhook: bad signature fails closed even in dev', () => {
  const res = checkInboundWebhook({
    rawBody: 'x',
    signatureHeader: sign('y'),
    appSecret: SECRET,
    env: { NODE_ENV: 'development' },
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'BAD_SIGNATURE');
});

test('checkInboundWebhook: missing secret fails closed in production', () => {
  const res = checkInboundWebhook({
    rawBody: 'x',
    signatureHeader: 'sha256=abc',
    appSecret: '',
    env: { NODE_ENV: 'production' },
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'NO_APP_SECRET_IN_PROD');
});

test('checkInboundWebhook: missing secret allows in dev (with reason)', () => {
  const res = checkInboundWebhook({
    rawBody: 'x',
    signatureHeader: 'sha256=abc',
    appSecret: '',
    env: { NODE_ENV: 'development' },
  });
  assert.equal(res.ok, true);
  assert.equal(res.reason, 'NO_SECRET_DEV_BYPASS');
});

test('checkInboundWebhook: the disable flag cannot open production', () => {
  const body = JSON.stringify({ ok: true });
  const res = checkInboundWebhook({
    rawBody: body,
    signatureHeader: 'sha256=deadbeef',
    appSecret: SECRET,
    env: { NODE_ENV: 'production', WHATSAPP_VERIFY_SIGNATURE: 'false' },
  });
  assert.equal(res.ok, false, 'production must ignore the disable flag');
});

test('extractMessageId: pulls the id from a message webhook', () => {
  const body = {
    entry: [{ changes: [{ value: { messages: [{ id: 'wamid.ABC123' }] } }] }],
  };
  assert.equal(extractMessageId(body), 'wamid.ABC123');
});

test('extractMessageId: returns null for a status callback (no message)', () => {
  const body = {
    entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.X', status: 'delivered' }] } }] }],
  };
  assert.equal(extractMessageId(body), null);
});

test('extractMessageId: returns null for junk without throwing', () => {
  assert.equal(extractMessageId(undefined), null);
  assert.equal(extractMessageId({}), null);
  assert.equal(extractMessageId({ entry: [] }), null);
});
