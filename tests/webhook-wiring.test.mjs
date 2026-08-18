/**
 * Wiring tests for the WhatsApp webhook route.
 *
 * The handler pulls in message-processor-v2 -> Prisma, so it cannot be
 * imported in a unit test without a database. These are static source checks
 * (same pattern as no-whatsapp-sends-in-api-routes.test.mjs) that pin the
 * security-critical wiring: raw-body signature verification before any
 * processing, no leaked fallback verify token, and per-message dedupe.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();

async function fileText(relPath) {
  const abs = path.join(root, relPath);
  return await readFile(abs, 'utf8');
}

const WEBHOOK = 'pages/api/webhooks/whatsapp.js';

test('webhook disables the body parser so raw bytes are available for HMAC', async () => {
  const src = await fileText(WEBHOOK);
  assert.match(
    src,
    /export\s+const\s+config\s*=\s*\{\s*api:\s*\{\s*bodyParser:\s*false\s*\}\s*\}/,
    'must export config with bodyParser: false'
  );
});

test('webhook verifies the Meta signature with the security module', async () => {
  const src = await fileText(WEBHOOK);
  assert.ok(
    src.includes("from '../../../lib/webhook-security.js'"),
    'must import from lib/webhook-security.js'
  );
  assert.ok(src.includes('readRawBody(req)'), 'must read the raw body');
  assert.ok(src.includes('checkInboundWebhook('), 'must call checkInboundWebhook');
  assert.ok(
    src.includes("req.headers['x-hub-signature-256']"),
    'must pass the X-Hub-Signature-256 header'
  );
  assert.ok(
    src.includes('process.env.META_APP_SECRET'),
    'must use META_APP_SECRET as the HMAC key'
  );
  assert.ok(src.includes('status(401)'), 'must reject bad signatures with 401');
});

test('ordering: verify -> process (AWAITED) -> ACK', async () => {
  const src = await fileText(WEBHOOK);
  const verifyIdx = src.indexOf('checkInboundWebhook(');
  const rejectIdx = src.indexOf('status(401)');
  const ackIdx = src.indexOf('status(200).json({ ok: true })');
  const processIdx = src.indexOf('processMessage({');

  assert.ok(verifyIdx > -1 && rejectIdx > -1 && ackIdx > -1 && processIdx > -1);
  assert.ok(verifyIdx < processIdx, 'verification must run before any processing');
  assert.ok(rejectIdx < processIdx, 'the 401 path must precede processing');
  // Processing MUST complete before the 200 ACK: on Vercel serverless,
  // execution after the response is not guaranteed — fire-and-forget
  // post-ACK work is silently killed (shipped 2026-08-18, read as a mute
  // bot). The awaited-IIFE-then-ACK ordering is the invariant.
  assert.ok(processIdx < ackIdx, 'processing must be awaited BEFORE the 200 ACK');
  assert.ok(
    !src.includes('void (async'),
    'no fire-and-forget async blocks in the webhook'
  );
});

test('the leaked hardcoded verify token is gone', async () => {
  const src = await fileText(WEBHOOK);
  assert.ok(
    !src.includes('wapay_webhook_secret_2025'),
    'hardcoded fallback verify token must not appear'
  );
  // No other string fallback either: the expected token must come only from env.
  assert.match(
    src,
    /const expectedToken =\s*process\.env\.WHATSAPP_VERIFY_TOKEN \|\| process\.env\.META_WEBHOOK_VERIFY_TOKEN;/,
    'expected token must be env-only with no || <literal> fallback'
  );
  assert.ok(
    src.includes('expectedToken && token === expectedToken'),
    'GET verification must fail when no verify token env var is set'
  );
});

test('webhook claims each inbound message id before processing it', async () => {
  const src = await fileText(WEBHOOK);
  assert.ok(
    src.includes("from '../../../lib/ledger-post.js'"),
    'must import claimMessage from lib/ledger-post.js'
  );
  assert.ok(
    src.includes('claimMessage({ waMessageId: messageId'),
    'must claim by the WhatsApp message id'
  );
  assert.ok(
    src.includes("'wa_webhook_duplicate'") || src.includes('"wa_webhook_duplicate"'),
    'must log duplicates with type wa_webhook_duplicate'
  );

  // The claim must sit inside the message loop, before the first dispatch to
  // processMessage, so every message type is covered by dedupe.
  const claimIdx = src.indexOf('claimMessage({');
  const firstDispatchIdx = src.indexOf('processMessage({');
  assert.ok(claimIdx > -1 && firstDispatchIdx > -1);
  assert.ok(claimIdx < firstDispatchIdx, 'claimMessage must run before any processMessage call');

  // Dedupe failure must not drop the message: the claim call is wrapped in
  // try/catch and the catch logs instead of rethrowing/continuing.
  assert.ok(
    src.includes("'wa_webhook_dedupe_error'") || src.includes('"wa_webhook_dedupe_error"'),
    'dedupe storage failure must be logged and processing must continue'
  );
});

test('env.template documents META_APP_SECRET', async () => {
  const tpl = await fileText('env.template');
  assert.match(tpl, /^META_APP_SECRET=/m, 'env.template must carry a META_APP_SECRET line');
});
