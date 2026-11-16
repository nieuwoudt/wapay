// 2026-11-10, founder: "the user should automatically receive a message from WaPay if they get paid by
// another customer". A member is told every time (inside their window a plain message, outside it the
// approved UTILITY template through notifyCustomer and its outbound guard); anyone else only inside a
// window they opened; nobody who said stop; never a number that never wrote (BUGLOG #144).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { notifySendRecipient, sendReceiptText, recipientNoticeLine, moneyReceivedTemplateOn, MONEY_RECEIVED_TEMPLATE_ENV } = await import('../lib/send-money.js');

const NOW = Date.parse('2026-11-10T14:30:00Z');
const SENDER = { id: 'sender1', msisdn: '0820000001', waId: '27820000001', displayName: 'Thandi *bold* [x]' };
const hoursAgo = (h) => new Date(NOW - h * 3600e3);

function store({ accounts = [], turns = [] } = {}) {
  return {
    account: {
      findFirst: async ({ where }) => accounts.find((a) => where.OR.some((w) => (w.waId && w.waId === a.waId) || (w.msisdn && w.msisdn === a.msisdn))) || null,
    },
    conversationTurn: {
      findFirst: async ({ where }) => turns.filter((t) => t.accountId === where.accountId && t.role === where.role).sort((a, b) => b.createdAt - a.createdAt)[0] || null,
    },
  };
}

function spies() {
  const calls = { notify: [], text: [] };
  return {
    calls,
    deps: {
      notifyCustomer: async (args) => { calls.notify.push(args); return { ok: true, rail: 'template' }; },
      say: { sendWhatsAppText: async (args) => { calls.text.push(args); return { ok: true }; } },
    },
  };
}

const MEMBER = { id: 'member1', waId: '27601879361', msisdn: '27601879361', profile: {} };
const ON = { [MONEY_RECEIVED_TEMPLATE_ENV]: 'wapay_money_received' };

test('a member outside their window is told through notifyCustomer with the money-received template', async () => {
  const { calls, deps } = spies();
  const prisma = store({ accounts: [MEMBER], turns: [{ accountId: 'member1', role: 'user', createdAt: hoursAgo(72) }] });
  const r = await notifySendRecipient({ prisma, sender: SENDER, recipientMsisdn: '0601879361', amountCents: 40000, delivered: 'BALANCE', env: ON, now: NOW, deps });
  assert.equal(r.sent, true);
  assert.equal(calls.notify.length, 1);
  const n = calls.notify[0];
  assert.equal(n.to, '27601879361');
  assert.equal(n.accountId, 'member1');
  assert.equal(n.kind, 'receipt');
  assert.equal(n.templateEnv, 'WAPAY_TEMPLATE_MONEY_RECEIVED');
  assert.deepEqual(n.templateParams, ['Thandi bold x', 'R400'], 'the sender label is sanitised: no markdown, no brackets');
  assert.match(n.text, /sent you R400 with WaPay\. It is in your WaPay balance/);
  assert.equal(calls.text.length, 0);
});

test('a member inside their window is told even before the template exists', async () => {
  const { calls, deps } = spies();
  const prisma = store({ accounts: [MEMBER], turns: [{ accountId: 'member1', role: 'user', createdAt: hoursAgo(2) }] });
  const r = await notifySendRecipient({ prisma, sender: SENDER, recipientMsisdn: '0601879361', amountCents: 40000, delivered: 'BALANCE', env: {}, now: NOW, deps });
  assert.equal(r.sent, true);
  assert.equal(calls.notify.length, 1, 'notifyCustomer sends the plain message inside the window');
});

test('a member outside their window without the template: nothing is attempted', async () => {
  const { calls, deps } = spies();
  const prisma = store({ accounts: [MEMBER], turns: [{ accountId: 'member1', role: 'user', createdAt: hoursAgo(30) }] });
  const r = await notifySendRecipient({ prisma, sender: SENDER, recipientMsisdn: '0601879361', amountCents: 40000, delivered: 'BALANCE', env: { [MONEY_RECEIVED_TEMPLATE_ENV]: 'off' }, now: NOW, deps });
  assert.deepEqual(r, { sent: false, reason: 'NO_TEMPLATE' });
  assert.equal(calls.notify.length + calls.text.length, 0);
});

test('a number with no account (never wrote to WaPay) hears nothing, template or not', async () => {
  const { calls, deps } = spies();
  const r = await notifySendRecipient({ prisma: store(), sender: SENDER, recipientMsisdn: '0721112222', amountCents: 5000, delivered: 'HELD', env: ON, now: NOW, deps });
  assert.deepEqual(r, { sent: false, reason: 'NO_ACCOUNT' });
  assert.equal(calls.notify.length + calls.text.length, 0);
});

test('not a member: a plain message only inside a window they opened; outside it nothing', async () => {
  const visitor = { id: 'visitor1', waId: '27721112222', msisdn: '27721112222', profile: {} };
  let { calls, deps } = spies();
  let r = await notifySendRecipient({ prisma: store({ accounts: [visitor], turns: [{ accountId: 'visitor1', role: 'user', createdAt: hoursAgo(1) }] }), sender: SENDER, recipientMsisdn: '0721112222', amountCents: 5000, delivered: 'HELD', env: ON, now: NOW, deps });
  assert.equal(r.sent, true);
  assert.equal(calls.text.length, 1);
  assert.match(calls.text[0].text, /Reply here to open your WaPay/);
  assert.equal(calls.notify.length, 0, 'never the template for someone who is not a member');
  ({ calls, deps } = spies());
  r = await notifySendRecipient({ prisma: store({ accounts: [visitor], turns: [{ accountId: 'visitor1', role: 'user', createdAt: hoursAgo(25) }] }), sender: SENDER, recipientMsisdn: '0721112222', amountCents: 5000, delivered: 'HELD', env: ON, now: NOW, deps });
  assert.deepEqual(r, { sent: false, reason: 'NO_WINDOW' });
  assert.equal(calls.notify.length + calls.text.length, 0);
});

test('someone who said stop hears nothing until they write again', async () => {
  const stopped = { ...MEMBER, profile: { messaging: { optOut: true, optOutAt: hoursAgo(5).toISOString() } } };
  let { calls, deps } = spies();
  let r = await notifySendRecipient({ prisma: store({ accounts: [stopped], turns: [{ accountId: 'member1', role: 'user', createdAt: hoursAgo(5.1) }] }), sender: SENDER, recipientMsisdn: '0601879361', amountCents: 40000, delivered: 'BALANCE', env: ON, now: NOW, deps });
  assert.deepEqual(r, { sent: false, reason: 'OPTED_OUT' });
  assert.equal(calls.notify.length, 0);
  ({ calls, deps } = spies());
  r = await notifySendRecipient({ prisma: store({ accounts: [stopped], turns: [{ accountId: 'member1', role: 'user', createdAt: hoursAgo(1) }] }), sender: SENDER, recipientMsisdn: '0601879361', amountCents: 40000, delivered: 'BALANCE', env: ON, now: NOW, deps });
  assert.equal(r.sent, true, 'they wrote after the stop');
});

test('a send to your own number and a store that throws never message anyone and never throw', async () => {
  const { calls, deps } = spies();
  assert.deepEqual(await notifySendRecipient({ prisma: store({ accounts: [MEMBER] }), sender: SENDER, recipientMsisdn: '0820000001', amountCents: 1000, delivered: 'BALANCE', env: ON, now: NOW, deps }), { sent: false, reason: 'SELF' });
  const broken = { account: { findFirst: async () => { throw new Error('db down'); } }, conversationTurn: { findFirst: async () => null } };
  const r = await notifySendRecipient({ prisma: broken, sender: SENDER, recipientMsisdn: '0601879361', amountCents: 1000, delivered: 'BALANCE', env: ON, now: NOW, deps });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'ERROR');
  assert.equal(calls.notify.length + calls.text.length, 0);
});

test('the sender reads the same words whoever the number belongs to, and the line follows the template switch', () => {
  assert.equal(moneyReceivedTemplateOn({}), false);
  assert.equal(moneyReceivedTemplateOn({ [MONEY_RECEIVED_TEMPLATE_ENV]: 'off' }), false);
  assert.equal(moneyReceivedTemplateOn(ON), true);
  const off = sendReceiptText({ amountCents: 40000, recipientMsisdn: '0601879361', newBalanceCents: 483950, env: {} });
  assert.match(off, /WaPay does not message them, so let them know you sent it\./);
  const on = sendReceiptText({ amountCents: 40000, recipientMsisdn: '0601879361', newBalanceCents: 483950, env: ON });
  assert.match(on, /If they use WaPay, WaPay tells them on WhatsApp\. If not, let them know it is waiting for them\./);
  assert.ok(!/does not message them/.test(on));
  assert.equal(recipientNoticeLine(ON), 'If they use WaPay, WaPay tells them on WhatsApp. If not, let them know it is waiting for them.');
  assert.ok(!/—/.test(on + off), 'no em dashes in customer copy');
});
