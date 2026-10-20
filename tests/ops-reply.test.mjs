/**
 * The ops reply (founder 2026-10-19): a person answers a customer in chat
 * through the internal route; text only, one message, inside the 24-hour
 * window, recorded as the assistant's turn through lib/say.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { opsReply, OPS_REPLY_MAX_CHARS, templateParam, supportTemplateName, greetingName } from '../lib/ops-reply.js';

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
  const closed = await opsReply({ prisma: db({ lastUserAt: '2026-10-18T09:00:00Z' }), send, accountId: ID, text: 'hi', now: NOW, env: { WAPAY_TEMPLATE_SUPPORT_FOLLOWUP: 'off' } });
  assert.equal(closed.status, 409); assert.equal(closed.body.error, 'WINDOW_CLOSED');
  assert.equal((await opsReply({ prisma: db({ lastUserAt: null }), send, accountId: ID, text: 'hi', now: NOW, env: { WAPAY_TEMPLATE_SUPPORT_FOLLOWUP: 'off' } })).status, 409, 'no inbound ever: closed');
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

// 2026-10-20: after the 24-hour window the same text travels inside the approved
// UTILITY support follow-up template, so a person who asked for help is never
// out of reach; a stopped customer is not written to on either rail.
test('ops reply after the window: the support template carries the text, the turn is remembered, stop still wins', async () => {
  const sends = []; const templates = []; const remembered = [];
  const send = async (a) => { sends.push(a); return { ok: true, data: { messages: [{ id: 'wamid.text' }] } }; };
  const sendTemplate = async (a) => { templates.push(a); return { ok: true, data: { messages: [{ id: 'wamid.tpl' }] } }; };
  const remember = async (a) => { remembered.push(a); };
  const account = { id: ID, waId: '27600000919', displayName: 'Simza Dlamini' };
  const r = await opsReply({ prisma: db({ lastUserAt: '2026-10-18T09:00:00Z', account }), send, sendTemplate, remember, accountId: ID, text: 'You asked us to close your account.\n\nReply CLOSE to confirm,   or tell us what went wrong.', now: NOW, env: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.rail, 'template');
  assert.equal(r.body.template, 'wapay_support_followup');
  assert.equal(r.body.messageId, 'wamid.tpl');
  assert.equal(sends.length, 0, 'no free-form text after the window');
  assert.equal(templates.length, 1);
  assert.equal(templates[0].templateName, 'wapay_support_followup');
  assert.equal(templates[0].language, 'en');
  const params = templates[0].components[0].parameters.map((p) => p.text);
  assert.equal(params[0], 'Simza');
  assert.equal(params[1], 'You asked us to close your account. Reply CLOSE to confirm, or tell us what went wrong.', 'newlines and runs of spaces collapsed for Meta');
  assert.equal(remembered.length, 1);
  assert.equal(remembered[0].kind, 'ops');
  assert.equal(remembered[0].waMessageId, 'wamid.tpl');
  // a named template from the environment, and the rail switched off
  const named = await opsReply({ prisma: db({ lastUserAt: '2026-10-18T09:00:00Z', account }), send, sendTemplate, remember, accountId: ID, text: 'hi', now: NOW, env: { WAPAY_TEMPLATE_SUPPORT_FOLLOWUP: 'support_v2' } });
  assert.equal(named.body.template, 'support_v2');
  const off = await opsReply({ prisma: db({ lastUserAt: '2026-10-18T09:00:00Z', account }), send, sendTemplate, remember, accountId: ID, text: 'hi', now: NOW, env: { WAPAY_TEMPLATE_SUPPORT_FOLLOWUP: 'off' } });
  assert.equal(off.status, 409); assert.equal(off.body.error, 'WINDOW_CLOSED');
  // a stopped customer: refused before any rail, window open or closed
  const stopped = { ...account, profile: { messaging: { optOut: true, optOutAt: '2026-10-19T09:30:00Z' } } };
  const refused = await opsReply({ prisma: db({ lastUserAt: '2026-10-18T09:00:00Z', account: stopped }), send, sendTemplate, remember, accountId: ID, text: 'hi', now: NOW, env: {} });
  assert.equal(refused.status, 409); assert.equal(refused.body.error, 'OPTED_OUT');
  assert.equal(templates.length, 2, 'no template to a stopped customer');
  // a template failure is a 502 and nothing is remembered
  const before = remembered.length;
  const failed = await opsReply({ prisma: db({ lastUserAt: '2026-10-18T09:00:00Z', account }), send, sendTemplate: async () => ({ ok: false, error: '(#132001) Template name does not exist' }), remember, accountId: ID, text: 'hi', now: NOW, env: {} });
  assert.equal(failed.status, 502); assert.equal(remembered.length, before, 'a failed template send is not remembered as said');
});

test('template helpers: parameter sanitiser, name switch, greeting name', () => {
  assert.equal(templateParam('a\n\nb\tc    d'), 'a b c d');
  assert.equal(templateParam('x'.repeat(2000)).length, 1000);
  assert.equal(supportTemplateName({}), 'wapay_support_followup');
  assert.equal(supportTemplateName({ WAPAY_TEMPLATE_SUPPORT_FOLLOWUP: ' OFF ' }), '');
  assert.equal(supportTemplateName({ WAPAY_TEMPLATE_SUPPORT_FOLLOWUP: 'support_v2' }), 'support_v2');
  assert.equal(greetingName('Thandi Nkosi'), 'Thandi');
  assert.equal(greetingName("O'Neil"), "O'Neil");
  assert.equal(greetingName('0761234567'), 'there');
  assert.equal(greetingName(''), 'there');
  assert.equal(greetingName('💚 Mo'), 'there');
});
