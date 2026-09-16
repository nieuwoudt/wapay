/**
 * Typing indicator + claim release: static source checks on the package
 * source and the ledger module, plus a behavioural check on the built
 * package (no network: credentials are unset, so the call fails fast and
 * must resolve ok:false rather than throw).
 *
 * Meta: developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators
 * (marks the message read, shows typing for up to 25 s or until we reply).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();

async function fileText(relPath) {
  return await readFile(path.join(root, relPath), 'utf8');
}

const SEND = 'packages/whatsapp/src/send.ts';
const LEDGER = 'lib/ledger-post.js';

function fnBody(src, name) {
  const start = src.indexOf(`export async function ${name}(`);
  assert.ok(start > -1, `${name} must be exported from ${SEND}`);
  const next = src.indexOf('\nexport ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

test('sendTypingIndicator posts the Meta read + typing payload with an abort timeout', async () => {
  const src = await fileText(SEND);
  const body = fnBody(src, 'sendTypingIndicator');

  assert.match(body, /messaging_product:\s*'whatsapp'/, 'payload must carry messaging_product');
  assert.match(body, /status:\s*'read'/, "payload must set status: 'read'");
  assert.match(body, /message_id:\s*messageId/, 'payload must carry the inbound message id');
  assert.match(body, /typing_indicator:\s*\{\s*type:\s*'text'\s*\}/, 'payload must carry typing_indicator');
  assert.ok(body.includes('/messages`'), 'must POST to the /messages endpoint');

  // Same credential resolution as the other senders.
  assert.ok(src.includes('process.env.META_WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN'));
  assert.ok(
    src.includes('process.env.META_WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID')
  );

  // Bounded: AbortController + timer, cleared on every path.
  assert.ok(body.includes('new AbortController()'), 'must use an AbortController');
  assert.match(body, /setTimeout\(\(\) => controller\.abort\(\), timeoutMs\)/, 'must abort after timeoutMs');
  assert.ok(body.includes('signal: controller.signal'), 'must pass the abort signal to the request');
  assert.ok(body.includes('finally'), 'timer must be cleared in finally');
  assert.ok(body.includes('clearTimeout(timer)'), 'timer must be cleared');
  assert.match(body, /timeoutMs = 1500/, 'default timeout is 1500ms');

  // Never throws: the catch returns ok:false.
  assert.ok(body.includes('catch (error)'), 'must catch every failure');
  assert.ok(body.includes('return { ok: false, error'), 'failure must resolve ok:false');
});

test('outbound counter increments only on ok:true customer sends, never for typing', async () => {
  const src = await fileText(SEND);
  assert.ok(src.includes('export function outboundSendCount(): number'));
  const increments = src.match(/bumpSends\(\);/g) || [];
  assert.equal(increments.length, 3, 'text, template and CTA-URL each count once');
  for (const name of ['sendWhatsAppText', 'sendWhatsAppTemplate', 'sendWhatsAppCtaUrl']) {
    assert.ok(fnBody(src, name).includes('bumpSends();'), `${name} must increment the counter`);
  }
  assert.ok(
    !fnBody(src, 'sendTypingIndicator').includes('outboundSends'),
    'typing indicator must not count as a send'
  );
});

test('built package: sendTypingIndicator resolves ok:false without credentials, never throws', async () => {
  const saved = {};
  for (const k of ['META_WHATSAPP_TOKEN', 'WHATSAPP_ACCESS_TOKEN', 'META_WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_PHONE_NUMBER_ID']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    const mod = await import('../packages/whatsapp/dist/send.js');
    assert.equal(typeof mod.sendTypingIndicator, 'function');
    assert.equal(typeof mod.outboundSendCount, 'function');
    const before = mod.outboundSendCount();
    const res = await mod.sendTypingIndicator({ messageId: 'wamid.test', timeoutMs: 50 });
    assert.equal(res.ok, false);
    assert.match(res.error, /not set/);
    assert.equal(mod.outboundSendCount(), before, 'a failed typing call must not move the counter');
    const missing = await mod.sendTypingIndicator({ messageId: '' });
    assert.equal(missing.ok, false);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

test('package index re-exports sendTypingIndicator and outboundSendCount', async () => {
  const idx = await fileText('packages/whatsapp/src/index.ts');
  assert.match(idx, /export \{[^}]*sendTypingIndicator[^}]*\} from '\.\/send\.js'/);
  assert.match(idx, /export \{[^}]*outboundSendCount[^}]*\} from '\.\/send\.js'/);
});

test('lib/ledger-post.js exports releaseClaim using deleteMany and never throws', async () => {
  const src = await fileText(LEDGER);
  const start = src.indexOf('export async function releaseClaim({ waMessageId })');
  assert.ok(start > -1, 'releaseClaim must be exported');
  const next = src.indexOf('\nexport ', start + 1);
  const body = src.slice(start, next === -1 ? undefined : next);
  assert.ok(body.includes('prisma.processedMessage.deleteMany('), 'must delete via deleteMany');
  assert.ok(body.includes('where: { waMessageId }'), 'must delete by waMessageId');
  assert.ok(body.includes('try {') && body.includes('catch (err)'), 'must swallow errors');
  assert.ok(body.includes('return { released: false }'), 'failure resolves released:false');
  assert.ok(body.includes('return { released: count > 0 }'), 'success reports whether a row went');
  assert.ok(!body.includes('throw'), 'releaseClaim must never throw');
});
