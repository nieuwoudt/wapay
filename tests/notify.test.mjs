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

test('C19: the pay-out half of the card reports what is held and how long the oldest has waited', () => {
  const route = read('../pages/api/admin/conversations.js');
  assert.match(route, /const heldCents = parkedRows\.reduce\(\(sum, p\) => sum \+ \(p\.amountCents \|\| 0\) \+ \(p\.feeCents \|\| 0\), 0\);/);
  assert.match(route, /const oldestMinutes = parkedRows\.length \? Math\.max\(\.\.\.parkedRows\.map\(\(p\) => p\.ageMinutes \|\| 0\)\) : null;/);
  assert.match(route, /payouts: \{ parked: parkedRows\.length, heldCents, oldestMinutes, rows:/);
  const page = read('../pages/admin/index.js');
  assert.match(page, /holding.*R\(c\.payouts\.heldCents\)/);
  assert.match(page, /oldest ' \+ c\.payouts\.oldestMinutes/);
  // the console still carries none of the gate words as copy
  assert.doesNotMatch(page, /\bbet(s|ting|tor)?\b|gambl|casino|wager|bookmak/i);
  assert.doesNotMatch(page, /cash\s?-?\s?out|withdraw/i);
});

test('the eval runner has a frozen baseline and a script that uses it, so a regression exits non-zero', () => {
  const pkg = JSON.parse(read('../package.json'));
  assert.equal(pkg.scripts['eval:agent'], 'node --env-file=.env scripts/eval-agent.mjs --baseline docs/testing/agent-eval-baseline.json');
  assert.ok(pkg.scripts['eval:orchestrator']);
  const baseline = JSON.parse(read('../docs/testing/agent-eval-baseline.json'));
  assert.ok(baseline.summary?.overall, 'compareBaseline reads summary.overall');
  assert.equal(baseline.summary.overall.total, 156);
  assert.equal(baseline.summary.overall.actionPct, 100);
  assert.ok(Object.keys(baseline.summary.byLanguage || {}).length >= 11, 'all eleven languages are in the baseline');
  const runner = read('../scripts/eval-agent.mjs');
  assert.match(runner, /Exit 1: regression against baseline\./);
});

test('C14: a money outcome the customer was not told about is written into the history the agent reads', async () => {
  const { recordMoneyEvent } = await import('../lib/notify.js');
  const rows = [];
  const db = { conversationTurn: { create: async ({ data }) => { rows.push(data); return { id: 't1' }; } } };
  const ok = await recordMoneyEvent({ prisma: db, accountId: 'a1', text: '❌ Your withdrawal of R30 could not be completed.', kind: 'reconcile', refs: { reference: 'WP1' } });
  assert.equal(ok.ok, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'event', 'the agent renders this as "[event] …", not as something WaPay said');
  assert.equal(rows[0].kind, 'reconcile');
  assert.match(rows[0].text, /could not be completed/);
  // never throws, and never writes half a row
  assert.deepEqual(await recordMoneyEvent({ prisma: db, accountId: null, text: 'x' }), { ok: false });
  assert.deepEqual(await recordMoneyEvent({ prisma: db, accountId: 'a1', text: '' }), { ok: false });
  const boom = { conversationTurn: { create: async () => { throw new Error('db down'); } } };
  assert.equal((await recordMoneyEvent({ prisma: boom, accountId: 'a1', text: 'x' })).ok, false);

  // the sweep writes it exactly when nothing reached the customer
  const payouts = read('../lib/payouts.js');
  const block = payouts.slice(payouts.indexOf('counts.notifyFailed += 1;'), payouts.indexOf('counts.notifyFailed += 1;') + 700);
  assert.match(block, /recordMoneyEvent\(\{/);
  assert.match(block, /kind: 'reconcile'/);
  assert.ok(payouts.indexOf('recordMoneyEvent({') > payouts.indexOf('counts.notifyFailed += 1;'), 'only on the failure path, so a delivered notice is not in history twice');
});

test('C13: the internal-auth gate fails CLOSED in production when the key is missing', async () => {
  const src = read('../lib/internal-auth.js');
  assert.match(src, /if \(process\.env\.NODE_ENV === 'production'\) \{[\s\S]*?res\.status\(503\)[\s\S]*?return false;/);
  assert.match(src, /internal_auth_misconfigured/);
  const { requireInternalAuth } = await import('../lib/internal-auth.js');
  const mkRes = () => { const r = { code: null, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  const prev = process.env.WAPAY_INTERNAL_API_KEY;
  const prevEnv = process.env.NODE_ENV;
  delete process.env.WAPAY_INTERNAL_API_KEY;
  try {
    process.env.NODE_ENV = 'production';
    const res = mkRes();
    assert.equal(requireInternalAuth({ url: '/api/vas/airtime/execute', headers: {} }, res), false, 'a missing key must never open a money route in production');
    assert.equal(res.code, 503);
    process.env.NODE_ENV = 'development';
    assert.equal(requireInternalAuth({ url: '/x', headers: {} }, mkRes()), true, 'a local run still needs no key');
  } finally {
    if (prev === undefined) delete process.env.WAPAY_INTERNAL_API_KEY; else process.env.WAPAY_INTERNAL_API_KEY = prev;
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
  }
});
