/**
 * BUGLOG #145 (2026-11-07): the founder paid his own R5 link PRAHSUHH with Apple Pay on Adumo and got three
 * messages: the requester notice and the payer receipt twice. Adumo finishes a payment on two paths at once
 * (the browser return and the webhook) and both ran deliverRequestPaidNotifications, which read the notified
 * flags at the start and wrote them after a slow send.
 *
 * Pinned here: two racing deliveries send one requester notice and one payer receipt; a failed send gives the
 * claim back and a later delivery delivers; a claim left by a call that died is taken over, a live one is not;
 * a payment to your own link is one message in total.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverRequestPaidNotifications, notifyClaimKey, notifyDoneKey, NOTIFY_CLAIM_STALE_MS } from '../lib/request-notify.js';
import { claimTable, jsonbMerge } from './helpers/notify-claims.mjs';

const CODE = 'PRRACEAB';
const REQUESTER_WA = '27787051175';
const PAYER_LOCAL = '0726252243';
const PAYER_WA = '27726252243';

for (const k of ['WAPAY_TEMPLATE_REQUEST_PAID', 'WAPAY_TEMPLATE_PAYMENT_RECEIPT', 'WAPAY_TEMPLATE_PAYMENT_RECEIPT_V2', 'WHATSAPP_DIRECT_SEND', 'WAPAY_PAYER_PREREGISTER']) delete process.env[k];

// A paid R5 link whose requester and payer both wrote to WaPay today (window open, guard passes).
function world({ payerMsisdn = PAYER_LOCAL } = {}) {
  const table = claimTable();
  const intentRow = { idemKey: `wapay-payreq-${CODE}`, providerRef: 'ADUMO-TX-1', metadata: { waId: REQUESTER_WA, accountId: 'acc_req', amountCents: 500, grossCents: 500, payerMsisdn, requestCode: CODE } };
  const prisma = {
    paymentRequest: { findUnique: async () => ({ id: CODE, status: 'PAID', amountCents: 500, accountId: 'acc_req' }) },
    providerRequest: { findUnique: async () => ({ ...intentRow, metadata: { ...intentRow.metadata } }) },
    wallet: { findFirst: async () => null },
    account: {
      findUnique: async () => ({ id: 'acc_req', displayName: 'Nieuwoudt', waId: REQUESTER_WA, profile: {} }),
      findFirst: async () => ({ id: 'acc_any', profile: {}, createdAt: new Date() }),
    },
    conversationTurn: { findFirst: async () => ({ createdAt: new Date() }) },
    processedMessage: table.processedMessage,
    $executeRaw: jsonbMerge((idemKey) => (idemKey === intentRow.idemKey ? intentRow : null)),
  };
  return { prisma, intentRow, table };
}

// Sends take a while, like Meta's API; `ok` decides each one.
function wire({ ok = () => true, onSend = () => {}, delayMs = 15 } = {}) {
  const sends = [];
  const rail = (kind) => async (a) => {
    sends.push({ kind, to: a.to });
    onSend({ kind, to: a.to });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return ok({ kind, to: a.to }) ? { ok: true } : { ok: false, error: 'send failed' };
  };
  return { sends, send: { text: rail('text'), template: rail('template'), direct: rail('direct') } };
}

const to = (sends, waId) => sends.filter((s) => s.to === waId).length;

test('two deliveries started together send one requester notice and one payer receipt', async () => {
  const { prisma, intentRow, table } = world();
  const { sends, send } = wire();
  const outs = await Promise.all([
    deliverRequestPaidNotifications({ code: CODE, prisma, send }),
    deliverRequestPaidNotifications({ code: CODE, prisma, send }),
  ]);
  assert.equal(to(sends, REQUESTER_WA), 1, 'one requester notice');
  assert.equal(to(sends, PAYER_WA), 1, 'one payer receipt');
  // The loser says 'in_flight' while the winner is sending, 'already' once it has finished.
  for (const leg of ['requester', 'payer']) {
    const [lost, won] = outs.map((o) => o[leg]).sort();
    assert.equal(won, 'sent');
    assert.ok(['already', 'in_flight'].includes(lost), `${leg}: ${lost}`);
  }
  assert.ok(intentRow.metadata.requesterNotifiedAt && intentRow.metadata.payerNotifiedAt, 'both flags merged');
  assert.equal(intentRow.metadata.payerMsisdn, PAYER_LOCAL, 'the merge keeps the rest of the metadata');
  assert.ok(table.rows.has(notifyDoneKey('requester', CODE)) && table.rows.has(notifyDoneKey('payer', CODE)));

  // A stale spread elsewhere (an Adumo route writing the copy it read earlier) can drop the flags.
  // The done rows still stop a third delivery from sending anything.
  delete intentRow.metadata.requesterNotifiedAt;
  delete intentRow.metadata.payerNotifiedAt;
  const later = await deliverRequestPaidNotifications({ code: CODE, prisma, send });
  assert.deepEqual(later, { requester: 'already', payer: 'already' });
  assert.equal(sends.length, 2, 'still two messages');
});

test('the PRAHSUHH shape: the webhook arrives while the return is still sending the payer receipt', async () => {
  const { prisma } = world();
  let second = null;
  const { sends, send } = wire({
    delayMs: 200,
    onSend: ({ to: waId }) => {
      if (waId === PAYER_WA && !second) second = deliverRequestPaidNotifications({ code: CODE, prisma, send });
    },
  });
  const first = await deliverRequestPaidNotifications({ code: CODE, prisma, send });
  const other = await second;
  assert.deepEqual(first, { requester: 'sent', payer: 'sent' });
  assert.equal(other.requester, 'already', 'the requester leg finished before the second call looked');
  assert.equal(other.payer, 'in_flight', 'the payer leg is held by the first call');
  assert.equal(to(sends, PAYER_WA), 1, 'one receipt, not two');
  assert.equal(sends.length, 2);
});

test('a failed send gives the claim back, and the next delivery delivers', async () => {
  const { prisma, intentRow, table } = world();
  let up = false;
  const { sends, send } = wire({ ok: () => up });
  const first = await deliverRequestPaidNotifications({ code: CODE, prisma, send });
  assert.deepEqual(first, { requester: 'failed', payer: 'failed' });
  assert.ok(!table.rows.has(notifyClaimKey('requester', CODE)) && !table.rows.has(notifyClaimKey('payer', CODE)), 'both claims released');
  assert.ok(!intentRow.metadata.requesterNotifiedAt && !intentRow.metadata.payerNotifiedAt, 'nothing marked as told');

  up = true;
  const retry = await deliverRequestPaidNotifications({ code: CODE, prisma, send });
  assert.deepEqual(retry, { requester: 'sent', payer: 'sent' });
  assert.equal(to(sends, REQUESTER_WA), 2, 'one failed attempt, one delivery');
  assert.equal(to(sends, PAYER_WA), 2);
  assert.ok(intentRow.metadata.requesterNotifiedAt && intentRow.metadata.payerNotifiedAt);
});

test('a claim left by a call that died mid-send is taken over; a live claim is not', async () => {
  const { prisma, table } = world({ payerMsisdn: null });
  const { sends, send } = wire();
  table.rows.set(notifyClaimKey('requester', CODE), { id: 'live', waMessageId: notifyClaimKey('requester', CODE), processedAt: new Date() });
  const held = await deliverRequestPaidNotifications({ code: CODE, prisma, send });
  assert.equal(held.requester, 'in_flight');
  assert.equal(sends.length, 0, 'nothing while another call holds the leg');

  table.rows.get(notifyClaimKey('requester', CODE)).processedAt = new Date(Date.now() - NOTIFY_CLAIM_STALE_MS - 1000);
  const taken = await deliverRequestPaidNotifications({ code: CODE, prisma, send });
  assert.equal(taken.requester, 'sent');
  assert.equal(sends.length, 1);
});

test('paying your own link is one message: the requester notice, no payer receipt', async () => {
  const { prisma, intentRow } = world({ payerMsisdn: '0787051175' });
  const { sends, send } = wire();
  const guarded = [];
  const pre = [];
  process.env.WAPAY_PAYER_PREREGISTER = 'on';
  try {
    const out = await deliverRequestPaidNotifications({
      code: CODE,
      prisma,
      send,
      preRegisterPayer: async (a) => { pre.push(a); return { ok: true }; },
      guard: async (a) => { guarded.push(a.purpose); return { ok: true }; },
    });
    assert.deepEqual(out, { requester: 'sent', payer: 'own_number' });
  } finally {
    delete process.env.WAPAY_PAYER_PREREGISTER;
  }
  assert.equal(sends.length, 1, 'one message in total');
  assert.equal(sends[0].to, REQUESTER_WA);
  assert.ok(!guarded.includes('payer-receipt') && pre.length === 0, 'no receipt rail, no payer record');
  assert.ok(!intentRow.metadata.payerNotifiedAt);

  // The other stored form of the requester's number (0-form waId on an older intent) is the same person.
  const older = world({ payerMsisdn: '0787051175' });
  older.intentRow.metadata.waId = '0787051175';
  const w = wire();
  const out2 = await deliverRequestPaidNotifications({ code: CODE, prisma: older.prisma, send: w.send });
  assert.equal(out2.payer, 'own_number');
  assert.equal(w.sends.length, 1);
});
