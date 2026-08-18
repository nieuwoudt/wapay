/**
 * Deposit-status intent — "did my payment go through" is answered from the
 * intent table + ledger, deterministically. The AI must never invent
 * transaction status (founder review, 2026-08-18: it once improvised "your
 * balance will update shortly", which no code path could honour).
 *
 * Locks:
 * - matchDepositStatusRequest (pure): status questions match, requests to
 *   MAKE a deposit don't, and the card-deposit pattern keeps its territory;
 * - getLatestDepositIntent queries newest-first by requestTs (stubbed prisma);
 * - static wiring: the short-circuit runs BEFORE the AI path and the handler
 *   answers SUCCESS/PENDING/FAILED with the live balance in every reply.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { matchDepositStatusRequest, getLatestDepositIntent } from '../lib/deposits.js';

const processorSource = readFileSync(
  fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)),
  'utf8'
);

// ---------------------------------------------------------------------------
// The matcher: status questions in, deposit requests out
// ---------------------------------------------------------------------------

test('status questions match', () => {
  for (const text of [
    'did my payment go through',
    'Did my payment go through?',
    'has my deposit cleared',
    'did my deposit arrive',
    'did my money arrive?',
    'is my payment done',
    'was my deposit successful',
    'has the money reflected',
    'where is my money',
    "where's my deposit",
    'wheres my money?',
    'payment status',
    'deposit status',
    'status of my payment',
    'did my payment go thru and clear',
    'when will my deposit clear',
  ]) {
    assert.ok(matchDepositStatusRequest(text), `should match: "${text}"`);
  }
});

test('requests to MAKE a deposit do not match', () => {
  for (const text of [
    'deposit R100',
    'deposit money',
    'I want to deposit money',
    'how do I deposit',
    'deposit',
    'load my wallet',
  ]) {
    assert.ok(!matchDepositStatusRequest(text), `must NOT match: "${text}"`);
  }
});

test('unrelated intents do not match', () => {
  for (const text of [
    'balance',
    'what is my balance?',
    'buy R20 airtime',
    'send R50 to 0841234567',
    'did my airtime arrive',
    'where is my airtime',
    'hello',
  ]) {
    assert.ok(!matchDepositStatusRequest(text), `must NOT match: "${text}"`);
  }
});

test('the card-deposit link pattern keeps its territory', () => {
  // "deposit R100" routes to a payment link, never to a status lookup.
  const m = processorSource.match(/const DEPOSIT_CARD_PATTERN = \/(.*)\/([a-z]*);/);
  assert.ok(m, 'processor must still define DEPOSIT_CARD_PATTERN');
  const cardRe = new RegExp(m[1], m[2]);
  assert.ok(cardRe.test('deposit R100'));
  assert.ok(!cardRe.test('did my payment go through'), 'status question must not mint a link');
});

// ---------------------------------------------------------------------------
// getLatestDepositIntent: newest first, scoped to the account
// ---------------------------------------------------------------------------

test('getLatestDepositIntent queries PAYFAST deposits newest-first', async () => {
  let captured;
  const stub = {
    providerRequest: {
      findFirst: async (q) => {
        captured = q;
        return { id: 'row-1', status: 'PENDING' };
      },
    },
  };
  const row = await getLatestDepositIntent({ prisma: stub, accountId: 'acc-1' });
  assert.equal(row.id, 'row-1');
  assert.deepEqual(captured.where, { accountId: 'acc-1', provider: 'PAYFAST', route: 'deposit' });
  assert.deepEqual(captured.orderBy, { requestTs: 'desc' });
});

test('getLatestDepositIntent requires an accountId', async () => {
  await assert.rejects(() => getLatestDepositIntent({ prisma: {}, accountId: '' }), /accountId/);
});

// ---------------------------------------------------------------------------
// Static wiring in the processor
// ---------------------------------------------------------------------------

test('static: the status short-circuit runs before the AI path', () => {
  const shortCircuit = processorSource.indexOf("routeDecision: 'DEPOSIT_STATUS_LOOKUP'");
  const aiCall = processorSource.indexOf('await orchestrate(');
  assert.ok(shortCircuit > -1, 'processor must route DEPOSIT_STATUS_LOOKUP');
  assert.ok(aiCall > -1, 'processor still has the AI path');
  assert.ok(shortCircuit < aiCall, 'status questions must be intercepted before the AI sees them');
});

test('static: handleDepositStatus reads the intent table, never invents status', () => {
  const start = processorSource.indexOf('async function handleDepositStatus');
  assert.ok(start > -1, 'processor must define handleDepositStatus');
  const end = processorSource.indexOf('\nasync function ', start);
  const body = processorSource.slice(start, end);

  assert.match(body, /getLatestDepositIntent\(\{ accountId: account\.id \}\)/);
  // All three terminal answers exist…
  assert.match(body, /deposit was received/, 'SUCCESS answer');
  assert.match(body, /still confirming/, 'PENDING answer');
  assert.match(body, /didn't complete/, 'FAILED answer');
  // …and every answer shows the live balance (stale-number complaint).
  const balanceMentions = body.match(/Balance: R\$\{balance\}/g) ?? [];
  assert.ok(balanceMentions.length >= 4, 'every reply carries the live balance');
});
