/**
 * Electricity under a slow supplier (2026-10-06).
 *
 * Blu QA answered a meter lookup in more than 30 s while the VAS routes ran
 * under a 30 s Vercel cap with a 90 s client wait and retries: the function
 * was killed after the hold was reserved, with no settle, no release and no
 * receipt. These tests lock the shape that closes that:
 *   1. the cap on pages/api/vas/** fits the webhook that awaits it, and the
 *      electricity client waits fit inside the cap with margin, single attempt;
 *   2. a sale TIMEOUT keeps the hold and marks RECONCILE (never releases);
 *   3. the reconciler re-sends the same requestId: a replayed vend settles and
 *      hands back the token, a refusal releases, a timeout stays parked;
 *   4. the customer copy for both truths names no date and no supplier.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  reconcileElectricityPurchases,
  electricityExecKey,
  electricitySpendKey,
} from '../lib/electricity-settlement.js';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

test('the VAS function cap matches the webhook and the electricity waits fit inside it, single attempt', async () => {
  const vercel = JSON.parse(await read('vercel.json'));
  const vasCap = vercel.functions['pages/api/vas/**/*.js'].maxDuration;
  const webhookCap = vercel.functions['pages/api/webhooks/whatsapp.js'].maxDuration;
  assert.equal(vasCap, webhookCap, 'a VAS route cannot usefully outlive the webhook that awaits it');

  const client = await read('packages/providers/blu/src/vas-extended.ts');
  const info = Number(client.match(/ELEC_INFO_TIMEOUT_MS = Number\(process\.env\.BLU_ELEC_INFO_TIMEOUT_MS\) \|\| (\d+)/)[1]);
  const sale = Number(client.match(/ELEC_SALE_TIMEOUT_MS = Number\(process\.env\.BLU_ELEC_SALE_TIMEOUT_MS\) \|\| (\d+)/)[1]);
  assert.ok(info + 5000 <= vasCap * 1000, `meter lookup wait ${info} ms must leave margin under the ${vasCap} s cap`);
  assert.ok(sale + 5000 <= vasCap * 1000, `sale wait ${sale} ms must leave margin under the ${vasCap} s cap`);

  // Both electricity calls are single attempt (a retry after a timeout can never fit the cap)
  // and a transport timeout is thrown as its own error, which the retry loop never retries.
  const infoBody = client.slice(client.indexOf('async getElectricityInfo'), client.indexOf('async purchaseElectricity'));
  const saleBody = client.slice(client.indexOf('async purchaseElectricity'), client.indexOf('// PayTV (DStv, GOtv)'));
  for (const [name, body] of [['getElectricityInfo', infoBody], ['purchaseElectricity', saleBody]]) {
    assert.ok(body.includes('}, 1);'), `${name} must call callWithRetry with maxAttempts 1`);
    assert.ok(body.includes('asTimeout('), `${name} must surface a transport timeout as TIMEOUT`);
    assert.ok(!body.includes('90000') && !body.includes('30000'), `${name} must take its wait from the ELEC_*_TIMEOUT_MS constants`);
  }
  assert.match(client, /error\.message === 'TIMEOUT'\)\s*\{\s*throw error;/, 'callWithRetry must never retry a TIMEOUT');
});

test('the internal preview says what the supplier answered on an upstream failure, and the chat shows only the message', async () => {
  const preview = await read('pages/api/vas/electricity/preview.js');
  const catchIdx = preview.indexOf("logStructured('vas_electricity_info_failed'");
  const failure = preview.slice(preview.indexOf("error: 'UPSTREAM_FAILURE',", catchIdx), preview.indexOf("error: 'UPSTREAM_FAILURE',", catchIdx) + 400);
  assert.match(failure, /detail: \{ statusCode: e\?\.statusCode/, 'the operator sees the supplier status and reason');
  const processor = await read('pages/api/webhooks/message-processor-v2.js');
  const meter = processor.slice(processor.indexOf("errorKey: `elec_preview:${previewData.error || 'ERROR'}`"), processor.indexOf("errorKey: `elec_preview:${previewData.error || 'ERROR'}`") + 200);
  assert.ok(!meter.includes('previewData.detail'), 'the customer never sees the raw supplier detail');
});

test('a sale TIMEOUT keeps the hold and marks the row RECONCILE; a refusal still releases', async () => {
  const route = await read('pages/api/vas/electricity/execute.js');
  const timeoutIdx = route.indexOf("error?.message === 'TIMEOUT'");
  const releaseIdx = route.indexOf('await releaseHold({ idemKey, reason: `blu_failed:');
  assert.ok(timeoutIdx > -1, 'execute must branch on TIMEOUT');
  assert.ok(releaseIdx > -1, 'a refusal must still release the hold');
  assert.ok(timeoutIdx < releaseIdx, 'the TIMEOUT branch must sit before the release');
  const timeoutBranch = route.slice(timeoutIdx, releaseIdx);
  assert.ok(!timeoutBranch.includes('releaseHold'), 'the TIMEOUT branch must not release');
  assert.ok(timeoutBranch.includes("status: 'RECONCILE'"), 'the TIMEOUT branch must mark RECONCILE');
  assert.ok(timeoutBranch.includes('pending: true'), 'the TIMEOUT response must say pending');
  // A crash before delivery releases AND closes the row, so a stamped EXECUTING row is never re-sent.
  const crashBranch = route.slice(route.indexOf('if (holdIdemKey && !providerDelivered)'), route.indexOf('else if (holdIdemKey && providerDelivered)'));
  assert.ok(crashBranch.includes("status: 'FAILED'"), 'the crash release must close the row');
  // The row is stamped EXECUTING before the sale so a killed invocation can be told from a live one.
  assert.ok(route.indexOf("status: 'EXECUTING'") < route.indexOf('purchaseElectricity('), 'EXECUTING must be stamped before the sale');
  // Settlement goes through the shared module (same keys, same entry, replay-safe).
  assert.ok(route.includes('settleVendedElectricity('), 'execute must settle through lib/electricity-settlement.js');
  assert.equal(electricityExecKey('p1'), 'wapay-elec-exec-p1');
  assert.equal(electricitySpendKey('p1'), 'wapay-elec-spend-p1');
});

function fakeDb(rows, holdStatus = 'ACTIVE') {
  const updates = [];
  return {
    updates,
    providerRequest: {
      findMany: async () => rows,
      update: async ({ where, data }) => { updates.push({ id: where.id, ...data }); return {}; },
    },
    hold: { findUnique: async () => (holdStatus ? { status: holdStatus } : null) },
    wallet: { findFirst: async () => ({ availableCents: 4900 }) },
  };
}

const meta = { meterNumber: '000001020001', amountCents: 2000, serviceFee: 100, totalCents: 2100, reference: 'Q-1', transactionTypeId: 'TT-1', utility: 'Eskom', consumer: { name: null, address: null } };
const row = (status, extra = {}) => ({ id: 'preview-elec-1', status, metadata: { ...meta, ...extra }, requestTs: new Date() });
const account = { id: 'acct-1' };

test('reconciler: a replayed vend settles the hold, posts the spend and hands back the token', async () => {
  const db = fakeDb([row('RECONCILE')]);
  const settled = [];
  const released = [];
  const sent = [];
  const opts = [];
  const client = { purchaseElectricity: async (payload, o) => { sent.push(payload); opts.push(o); return { providerRef: 'BLU-E-1', token: '12345678901234567890', units: 18.2, dateTime: '2026-10-06T10:00:00Z' }; } };
  const out = await reconcileElectricityPurchases({ account, opportunistic: true, deps: { prisma: db, client, settleHold: async (a) => settled.push(a), releaseHold: async (a) => released.push(a), sendOpsAlert: async () => {} } });
  assert.equal(opts[0].timeoutMs, 15000, 'on the customer turn the re-send waits 15 s, not the full budget');
  assert.ok(db.updates.some((u) => u.metadata?.lastReconcileAt), 'the attempt is stamped on the row');
  assert.equal(out.settled, 1); assert.equal(out.failed, 0); assert.equal(out.pending, 0);
  assert.equal(sent[0].requestId, 'wapay-elec-exec-preview-elec-1', 'the SAME requestId is re-sent');
  assert.equal(sent[0].reference, 'Q-1', 'the stored quote reference is re-used');
  assert.equal(settled[0].idemKey, 'wapay-elec-exec-preview-elec-1');
  assert.equal(settled[0].entry.idemKey, 'wapay-elec-spend-preview-elec-1');
  assert.equal(released.length, 0);
  assert.equal(db.updates.at(-1).status, 'SUCCESS');
  assert.equal(out.delivered[0].token, '12345678901234567890');
  assert.equal(out.delivered[0].newBalanceCents, 4900);
});

test('reconciler: a definitive refusal releases the hold and marks FAILED; a timeout stays parked', async () => {
  const refusing = { purchaseElectricity: async () => { const e = new Error('USER_INPUT'); e.reason = 'Reference expired'; throw e; } };
  const db1 = fakeDb([row('RECONCILE')]);
  const released = [];
  const out1 = await reconcileElectricityPurchases({ account, deps: { prisma: db1, client: refusing, settleHold: async () => assert.fail('must not settle'), releaseHold: async (a) => released.push(a), sendOpsAlert: async () => {} } });
  assert.equal(out1.failed, 1); assert.equal(released[0].idemKey, 'wapay-elec-exec-preview-elec-1');
  assert.equal(db1.updates.at(-1).status, 'FAILED');
  assert.deepEqual(out1.failedAmounts, [2100]);

  const timingOut = { purchaseElectricity: async () => { throw new Error('TIMEOUT'); } };
  const db2 = fakeDb([row('RECONCILE')]);
  let alerted = 0;
  const out2 = await reconcileElectricityPurchases({ account, deps: { prisma: db2, client: timingOut, settleHold: async () => assert.fail('must not settle'), releaseHold: async () => assert.fail('must not release on a timeout'), sendOpsAlert: async () => { alerted += 1; } } });
  assert.equal(out2.pending, 1); assert.ok(db2.updates.every((u) => !u.status), 'a parked row keeps its status (only the attempt is stamped)'); assert.equal(alerted, 1);

  // On the customer's turn a row attempted a minute ago is left alone (the cron has no such gap).
  const recent = row('RECONCILE', { lastReconcileAt: new Date(Date.now() - 60_000).toISOString() });
  const db5 = fakeDb([recent]);
  const out5 = await reconcileElectricityPurchases({ account, opportunistic: true, deps: { prisma: db5, client: { purchaseElectricity: async () => assert.fail('throttled on the turn') }, settleHold: async () => {}, releaseHold: async () => {}, sendOpsAlert: async () => {} } });
  assert.equal(out5.pending, 1);
  const cronOpts = [];
  const db6 = fakeDb([recent]);
  await reconcileElectricityPurchases({ account, deps: { prisma: db6, client: { purchaseElectricity: async (p, o) => { cronOpts.push(o); throw new Error('TIMEOUT'); } }, settleHold: async () => {}, releaseHold: async () => {}, sendOpsAlert: async () => {} } });
  assert.deepEqual(cronOpts[0], {}, 'the cron re-sends with the full budget and ignores the gap');

  // A row whose hold was already released (a crash path gave the money back) is closed, never re-sent.
  const db4 = fakeDb([row('EXECUTING', { executingAt: '2026-01-01T00:00:00Z' })], 'RELEASED');
  const out4 = await reconcileElectricityPurchases({ account, deps: { prisma: db4, client: { purchaseElectricity: async () => assert.fail('must not re-send without an active hold') }, settleHold: async () => assert.fail('x'), releaseHold: async () => assert.fail('x'), sendOpsAlert: async () => {} } });
  assert.equal(out4.failed, 1); assert.equal(db4.updates.at(-1).status, 'FAILED');

  // A live EXECUTING row belongs to a running invocation: only a stale one is taken over.
  const db3 = fakeDb([row('EXECUTING', { executingAt: new Date().toISOString() })]);
  const out3 = await reconcileElectricityPurchases({ account, deps: { prisma: db3, client: refusing, settleHold: async () => assert.fail('x'), releaseHold: async () => assert.fail('must not touch a live invocation'), sendOpsAlert: async () => {} } });
  assert.equal(out3.pending, 1);
});

test('the customer copy for a timeout states both truths and names no date or supplier', async () => {
  const processor = await read('pages/api/webhooks/message-processor-v2.js');
  const pending = processor.slice(processor.indexOf('executeData.pending'), processor.indexOf('executeData.pending') + 900);
  assert.match(pending, /held, not spent/);
  assert.ok(!/\bBlu\b|Blue Label/.test(pending), 'no supplier name');
  assert.ok(!/\d{1,2}\s?(min|hour|day)s?\b|tomorrow|by\s+\d/.test(pending), 'no promised time');
  assert.ok(!pending.includes('—'), 'no em dash');
  assert.ok(!/✅/.test(pending), 'nothing is called successful');
  const lookup = processor.slice(processor.indexOf("previewData.error === 'TIMEOUT'"), processor.indexOf("previewData.error === 'TIMEOUT'") + 700);
  assert.match(lookup, /Nothing was charged/);
  assert.ok(!lookup.includes('—'));
  // The next message delivers the token or the refund through the opportunistic hook.
  assert.ok(processor.includes("route: 'electricity-preview', status: { in: ['RECONCILE', 'EXECUTING'] }"), 'inbound hook must look for stuck electricity rows');
  assert.ok(processor.includes("kind: 'electricity-reconcile'"), 'a still-pending row queues a job for the cron');
  assert.ok(processor.includes('reconcileElectricityPurchases({ account, opportunistic: true })'), 'the on-turn re-send is the short-bounded, throttled one');
});
