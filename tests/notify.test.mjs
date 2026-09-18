/**
 * notifyCustomer (C21): the only messages WaPay starts on its own.
 *
 * The pay-out sweep runs at 02:00 and from a cron, so the customer it needs to
 * tell is usually far outside their 24 hour window. Meta ACCEPTS a free-form
 * send there and drops it silently (BUGLOG #33), which meant a withdrawal that
 * settled overnight was never reported. These tests pin the rail choice, the
 * window check, the memory row and the never-throws contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { notifyCustomer, windowIsOpen, WINDOW_MS } from '../lib/notify.js';
import { payoutOutcomeParams, payoutOutcomeMessage } from '../lib/payouts.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const dbWithLastInbound = (agoMs) => ({
  conversationTurn: {
    findFirst: async ({ where }) => {
      assert.equal(where.role, 'user', 'the window is measured from the customer\'s last message');
      return agoMs == null ? null : { createdAt: new Date(Date.now() - agoMs) };
    },
  },
});

function rails({ directOk = true, templateOk = true, directEnabled = true } = {}) {
  const calls = [];
  return {
    calls,
    say: {
      sendWhatsAppText: async (a) => { calls.push(['text', a]); return { ok: true, data: { messages: [{ id: 'wamid.T' }] } }; },
      recordOutboundTurn: async (a) => { calls.push(['record', a]); return { ok: true }; },
    },
    wa: {
      directSendEnabled: () => directEnabled,
      sendWhatsAppUtilityDirect: async (a) => { calls.push(['direct', a]); return directOk ? { ok: true, messageId: 'wamid.D' } : { ok: false, error: 'NO_DIRECT' }; },
      sendWhatsAppTemplate: async (a) => { calls.push(['template', a]); return templateOk ? { ok: true, messageId: 'wamid.P' } : { ok: false, error: 'NO_TEMPLATE' }; },
    },
  };
}

test('the window is measured from the customer\'s last inbound, and an unreadable answer fails open', async () => {
  assert.equal(WINDOW_MS, 24 * 60 * 60 * 1000);
  assert.equal(await windowIsOpen({ prisma: dbWithLastInbound(60 * 1000), accountId: 'a1' }), true);
  assert.equal(await windowIsOpen({ prisma: dbWithLastInbound(WINDOW_MS - 1000), accountId: 'a1' }), true);
  assert.equal(await windowIsOpen({ prisma: dbWithLastInbound(WINDOW_MS + 1000), accountId: 'a1' }), false);
  assert.equal(await windowIsOpen({ prisma: dbWithLastInbound(null), accountId: 'a1' }), false, 'never messaged: the window is closed');
  assert.equal(await windowIsOpen({ prisma: {}, accountId: 'a1' }), true, 'no turns table: fail open');
  const throws = { conversationTurn: { findFirst: async () => { throw new Error('db down'); } } };
  assert.equal(await windowIsOpen({ prisma: throws, accountId: 'a1' }), true, 'a read failure must not silence a pay-out notice');
  assert.equal(await windowIsOpen({ accountId: null }), false);
});

test('inside the window it is a plain text, which lands in the thread the customer is reading', async () => {
  const r = rails();
  const out = await notifyCustomer({ to: '27600000901', accountId: 'a1', text: 'hi', deps: { prisma: dbWithLastInbound(1000), ...r } });
  assert.deepEqual(out.ok, true);
  assert.equal(out.rail, 'text');
  assert.deepEqual(r.calls.map((c) => c[0]), ['text'], 'no direct send and no template are spent on an open window');
});

test('outside the window: direct send first, then an approved template, then free-form; the turn is recorded either way', async () => {
  process.env.WAPAY_TEMPLATE_PAYOUT_OUTCOME = 'wapay_payment_receipt';
  const closed = dbWithLastInbound(WINDOW_MS + 60_000);

  const a = rails();
  const first = await notifyCustomer({ to: '27600000901', accountId: 'a1', text: 'paid', deps: { prisma: closed, ...a } });
  assert.equal(first.rail, 'direct');
  assert.deepEqual(a.calls.map((c) => c[0]), ['direct', 'record'], 'a direct send still reaches memory');

  const b = rails({ directOk: false });
  const second = await notifyCustomer({ to: '27600000901', accountId: 'a1', text: 'paid', templateEnv: 'WAPAY_TEMPLATE_PAYOUT_OUTCOME', templateParams: ['R50', 'Cash at a Nedbank ATM', 'WP123'], deps: { prisma: closed, ...b } });
  assert.equal(second.rail, 'template');
  const tpl = b.calls.find((c) => c[0] === 'template')[1];
  assert.equal(tpl.templateName, 'wapay_payment_receipt');
  assert.deepEqual(tpl.components[0].parameters.map((p) => p.text), ['R50', 'Cash at a Nedbank ATM', 'WP123']);
  assert.ok(b.calls.some((c) => c[0] === 'record'));

  const c = rails({ directOk: false, templateOk: false });
  const third = await notifyCustomer({ to: '27600000901', accountId: 'a1', text: 'paid', templateEnv: 'WAPAY_TEMPLATE_PAYOUT_OUTCOME', deps: { prisma: closed, ...c } });
  assert.equal(third.rail, 'text_fallback', 'an open window we failed to detect still gets through');

  const d = rails({ directEnabled: false });
  const fourth = await notifyCustomer({ to: '27600000901', accountId: 'a1', text: 'paid', deps: { prisma: closed, ...d } });
  assert.equal(fourth.rail, 'text_fallback', 'direct send off and no template configured');
  assert.ok(!d.calls.some((c) => c[0] === 'direct'), 'a disabled rail is never called');
  delete process.env.WAPAY_TEMPLATE_PAYOUT_OUTCOME;
});

test('a transport that throws, or missing arguments, never throws at the caller', async () => {
  const boom = {
    say: { sendWhatsAppText: async () => { throw new Error('transport down'); } },
    wa: { directSendEnabled: () => false },
  };
  const out = await notifyCustomer({ to: '27600000901', accountId: 'a1', text: 'paid', deps: { prisma: dbWithLastInbound(1000), ...boom } });
  assert.equal(out.ok, false);
  assert.equal(typeof out.rail, 'string');
  assert.deepEqual(await notifyCustomer({ to: '', text: 'x' }), { ok: false, rail: null, error: 'MISSING_ARGS' });
  assert.deepEqual(await notifyCustomer({ to: '27600000901', text: '' }), { ok: false, rail: null, error: 'MISSING_ARGS' });
});

test('the pay-out sweep goes through notifyCustomer, and the template parameters mirror the message', () => {
  const payouts = read('../lib/payouts.js');
  assert.match(payouts, /const \{ notifyCustomer \} = await import\('\.\/notify\.js'\);/);
  assert.match(payouts, /templateEnv: 'WAPAY_TEMPLATE_PAYOUT_OUTCOME'/);
  assert.match(payouts, /kind: 'receipt'/);
  const p = payoutOutcomeParams({ amountCents: 5000, method: 'NEDCASH', reference: 'WP123' });
  const msg = payoutOutcomeMessage({ status: 'SETTLED', amountCents: 5000, method: 'NEDCASH', reference: 'WP123' });
  for (const v of [p.amount, p.method, p.reference]) {
    assert.ok(msg.includes(v), `the template carries what the message says: ${v}`);
  }
  assert.equal(p.amount, 'R50');
  assert.equal(p.method, 'Cash at a Nedbank ATM');
});
