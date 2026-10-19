/**
 * The ops reply (founder 2026-10-19): a person answers a customer in chat
 * through the internal route; text only, one message, inside the 24-hour
 * window, recorded as the assistant's turn through lib/say.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { opsReply, OPS_REPLY_MAX_CHARS } from '../lib/ops-reply.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const ID = 'cmvezlqma00hbi5od3b5anvv5';
const NOW = Date.parse('2026-10-19T10:00:00Z');
function db({ lastUserAt = '2026-10-19T09:21:02Z', account = { id: ID, waId: '27600000919' } } = {}) {
  return {
    account: { findUnique: async ({ where }) => (where.id === ID ? account : null) },
    conversationTurn: { findFirst: async () => (lastUserAt ? { createdAt: new Date(lastUserAt) } : null) },
  };
}

test('ops reply: validates, finds the account, respects the window, sends once through say() as kind ops', async () => {
  const sent = [];
  const send = async (a) => { sent.push(a); return { ok: true, data: { messages: [{ id: 'wamid.1' }] } }; };
  assert.deepEqual(await opsReply({ prisma: db(), send, accountId: 'short', text: 'hi', now: NOW }), { status: 400, body: { ok: false, error: 'BAD_ACCOUNT' } });
  assert.deepEqual(await opsReply({ prisma: db(), send, accountId: ID, text: '   ', now: NOW }), { status: 400, body: { ok: false, error: 'BAD_TEXT' } });
  assert.deepEqual(await opsReply({ prisma: db(), send, accountId: ID, text: 'x'.repeat(OPS_REPLY_MAX_CHARS + 1), now: NOW }), { status: 400, body: { ok: false, error: 'BAD_TEXT' } });
  assert.deepEqual(await opsReply({ prisma: db(), send, accountId: 'cmvezlqma00hbi5od3b5anvv6', text: 'hi', now: NOW }), { status: 404, body: { ok: false, error: 'NO_ACCOUNT' } });
  const closed = await opsReply({ prisma: db({ lastUserAt: '2026-10-18T09:00:00Z' }), send, accountId: ID, text: 'hi', now: NOW });
  assert.equal(closed.status, 409); assert.equal(closed.body.error, 'WINDOW_CLOSED');
  assert.equal((await opsReply({ prisma: db({ lastUserAt: null }), send, accountId: ID, text: 'hi', now: NOW })).status, 409, 'no inbound ever: closed');
  assert.equal(sent.length, 0, 'nothing sent so far');
  const ok = await opsReply({ prisma: db(), send, accountId: ID, text: '  Hi Cytric, this is the WaPay team 👋  ', now: NOW });
  assert.deepEqual(ok, { status: 200, body: { ok: true, error: null, messageId: 'wamid.1' } });
  assert.deepEqual(sent, [{ to: '27600000919', text: 'Hi Cytric, this is the WaPay team 👋', kind: 'ops' }]);
  const forced = await opsReply({ prisma: db({ lastUserAt: '2026-10-18T09:00:00Z' }), send, accountId: ID, text: 'hi', force: true, now: NOW });
  assert.equal(forced.status, 200); assert.equal(sent.length, 2);
  const failed = await opsReply({ prisma: db(), send: async () => ({ ok: false, error: 'rail down' }), accountId: ID, text: 'hi', now: NOW });
  assert.deepEqual(failed, { status: 502, body: { ok: false, error: 'rail down', messageId: null } });
});

test('the route: POST only, internal key, say() as the transport so the turn is recorded', () => {
  const route = read('../pages/api/internal/ops-reply.js');
  assert.match(route, /if \(!requireInternalAuth\(req, res\)\) return;/);
  assert.match(route, /if \(req\.method !== 'POST'\)/);
  assert.match(route, /import \{ sendWhatsAppText \} from '\.\.\/\.\.\/\.\.\/lib\/say\.js';/);
  assert.match(route, /opsReply\(\{ prisma, send: sendWhatsAppText, accountId: req\.body\?\.accountId, text: req\.body\?\.text, force: String\(req\.query\?\.force\) === '1' \}\)/);
  assert.ok(!route.includes('@wapay/whatsapp'), 'never the raw transport: memory must keep what the person said');
});
