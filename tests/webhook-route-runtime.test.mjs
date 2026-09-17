/**
 * The WhatsApp webhook route, LOADED AND RUN (2026-09-17, BUGLOG #67).
 *
 * Every other lock reads the route as text. `node --check` and `next build`
 * both accept an identifier that is used but never imported, and the chat
 * harness calls processMessage directly, so a ReferenceError inside the
 * route's turn wrapper reached production unseen for 14 hours (the claim was
 * released, Meta got a 500, retried, and the bot was mute). This test signs a
 * real payload, runs the handler with its collaborators mocked, and asserts
 * the two contracts: a text message reaches processMessage and is
 * acknowledged 200; a turn that throws before sending releases the claim and
 * answers 500 so Meta redelivers.
 *
 * Module mocks need --experimental-test-module-mocks, which the plain suite
 * does not pass, so the scenario runs in a child node process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const SCRIPT = `
import { mock } from 'node:test';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
const abs = (rel) => new URL(rel, 'file://' + process.env.WAPAY_ROOT + '/').href;
const calls = { process: [], release: [], unmark: [], typing: [] };
let throwBeforeSend = false;
mock.module('@wapay/whatsapp', { namedExports: {
  sendTypingIndicator: async (a) => { calls.typing.push(a); return { ok: true }; },
  outboundSendCount: () => 0,
  runWithSendScope: (fn) => fn(),
  sendWhatsAppText: async () => ({ ok: true }), sendWhatsAppTemplate: async () => ({ ok: true }),
  sendWhatsAppCtaUrl: async () => ({ ok: true }), sendWhatsAppUtilityDirect: async () => ({ ok: true }),
  directSendEnabled: () => false,
} });
mock.module(abs('pages/api/webhooks/message-processor-v2.js'), { namedExports: {
  processMessage: async (args) => { calls.process.push(args); if (throwBeforeSend) throw new Error('boom before send'); },
} });
mock.module(abs('pages/api/webhooks/_middleware.js'), { namedExports: { ensureTemplatesReady: async () => {} } });
mock.module(abs('lib/initTemplates.js'), { namedExports: { isReady: () => true } });
mock.module(abs('lib/ledger-post.js'), { namedExports: {
  claimMessage: async () => true,
  releaseClaim: async (a) => { calls.release.push(a); return { released: true }; },
} });
mock.module(abs('pages/api/webhooks/user-manager.js'), { namedExports: { unmarkMessageProcessed: async (...a) => { calls.unmark.push(a); } } });
mock.module(abs('lib/prisma.js'), { defaultExport: {} });

const { default: handler } = await import(abs('pages/api/webhooks/whatsapp.js'));

function payload(text) {
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '27760497624', phone_number_id: '1' },
    contacts: [{ profile: { name: 'Test' }, wa_id: '27600000901' }],
    messages: [{ from: '27600000901', id: 'wamid.TEST' + Date.now(), timestamp: '1', type: 'text', text: { body: text } }],
  } }] }] });
}
function makeReq(raw) {
  const sig = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex');
  const req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST'; req.headers = { 'x-hub-signature-256': sig, 'content-type': 'application/json' }; req.query = {};
  return req;
}
function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.body = b; return res; };
  return res;
}
const out = {};
{ const res = makeRes(); await handler(makeReq(payload('hi')), res); out.ok = { status: res.statusCode, processed: calls.process.length, text: calls.process[0]?.text, typing: calls.typing.length }; }
throwBeforeSend = true;
{ const res = makeRes(); await handler(makeReq(payload('again')), res); out.thrown = { status: res.statusCode, body: res.body, released: calls.release.length, unmarked: calls.unmark.length }; }
console.log('RESULT ' + JSON.stringify(out));
`;

test('the webhook route loads and runs: a signed text message reaches processMessage with a 200; a turn that throws before sending releases the claim and answers 500', () => {
  const run = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', SCRIPT], {
    cwd: root,
    env: { ...process.env, WAPAY_ROOT: root.replace(/\/$/, ''), META_APP_SECRET: 'route-runtime-test-secret', NODE_ENV: 'production' },
    encoding: 'utf8',
    timeout: 60000,
  });
  const line = String(run.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no RESULT line; exit ${run.status}\nstdout: ${String(run.stdout).slice(-1500)}\nstderr: ${String(run.stderr).slice(-3000)}`);
  const out = JSON.parse(line.slice('RESULT '.length));
  assert.deepEqual(out.ok, { status: 200, processed: 1, text: 'hi', typing: 1 }, JSON.stringify(out));
  assert.equal(out.thrown.status, 500, 'a turn that threw before sending asks Meta to redeliver');
  assert.deepEqual(out.thrown.body, { ok: false, retry: true });
  assert.equal(out.thrown.released, 1, 'the claim is released');
  assert.equal(out.thrown.unmarked, 1, 'the processor dedupe ring forgets the id');
});
