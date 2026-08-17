/**
 * Unit tests for the pure parts of the ledger writer: account-code parsing
 * and the posting -> wallet-delta mapping. These decide whose balance moves
 * and by how much, so they are the highest-risk logic in the writer.
 *
 * The transactional behaviour (idempotent replay, atomic check-and-decrement,
 * holds) needs a real database and is covered by scripts/verify-ledger-db.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseWalletCode, walletDeltas } from '../lib/ledger-post.js';
import {
  ACCT,
  BALANCE,
  RAIL,
  buildCashout,
  buildLoad,
  buildSend,
  buildSpend,
} from '../lib/ledger-core.js';

const ALICE = 'acct_alice';
const BOB = 'acct_bob';

// ---------------------------------------------------------------------------
// Account code parsing
// ---------------------------------------------------------------------------

test('parseWalletCode: recognises both balance types', () => {
  assert.deepEqual(parseWalletCode('WALLET:acct_123:SPEND'), {
    accountId: 'acct_123',
    balanceType: 'SPEND',
  });
  assert.deepEqual(parseWalletCode('WALLET:acct_123:CASH'), {
    accountId: 'acct_123',
    balanceType: 'CASH',
  });
});

test('parseWalletCode: round-trips whatever ACCT.wallet builds', () => {
  for (const type of [BALANCE.SPEND, BALANCE.CASH]) {
    const code = ACCT.wallet(ALICE, type);
    assert.deepEqual(parseWalletCode(code), { accountId: ALICE, balanceType: type });
  }
});

test('parseWalletCode: non-wallet accounts return null (they have no balance row)', () => {
  const notWallets = [
    ACCT.clearing(RAIL.BLU),
    ACCT.feeRevenue('SEND'),
    ACCT.commissionRevenue('AIRTIME'),
    ACCT.providerExpense(RAIL.PAYAT),
    ACCT.PROMO_EXPENSE,
  ];
  for (const code of notWallets) {
    assert.equal(parseWalletCode(code), null, `${code} must not be treated as a wallet`);
  }
});

test('parseWalletCode: rejects malformed or unknown balance types', () => {
  assert.equal(parseWalletCode('WALLET:acct_123'), null, 'missing balance type');
  assert.equal(parseWalletCode('WALLET:acct_123:SAVINGS'), null, 'unknown balance type');
  assert.equal(parseWalletCode('WALLET:acct:123:SPEND'), null, 'colon in account id');
  assert.equal(parseWalletCode('wallet:acct_123:SPEND'), null, 'case matters');
  assert.equal(parseWalletCode(''), null);
});

// ---------------------------------------------------------------------------
// Posting -> wallet delta mapping
// ---------------------------------------------------------------------------

function deltaFor(entry, accountId, balanceType = BALANCE.SPEND) {
  const hit = walletDeltas(entry.postings).find(
    (d) => d.accountId === accountId && d.balanceType === balanceType
  );
  return hit ? hit.deltaCents : 0;
}

test('a load credits the customer exactly what we received', () => {
  const e = buildLoad({ accountId: ALICE, rail: RAIL.BLU, faceCents: 10000, idemKey: 'l1' });
  assert.equal(deltaFor(e, ALICE), 9400, 'wallet goes up by the net amount');
  assert.equal(walletDeltas(e.postings).length, 1, 'clearing and promo are not wallets');
});

test('a spend debits the customer and touches no other wallet', () => {
  const e = buildSpend({ accountId: ALICE, category: 'AIRTIME', saleCents: 9400, idemKey: 's1' });
  assert.equal(deltaFor(e, ALICE), -9400);
  assert.equal(walletDeltas(e.postings).length, 1, 'supplier and revenue are not wallets');
});

test('a P2P send moves value between two wallets in one entry', () => {
  const e = buildSend({ fromAccountId: ALICE, toAccountId: BOB, amountCents: 5000, idemKey: 'p1' });
  const deltas = walletDeltas(e.postings);
  assert.equal(deltas.length, 2);
  assert.equal(deltaFor(e, ALICE), -5000);
  assert.equal(deltaFor(e, BOB), 5000);
});

test('a fee-bearing send debits the sender more than the recipient receives', () => {
  const e = buildSend({
    fromAccountId: ALICE,
    toAccountId: BOB,
    amountCents: 5000,
    idemKey: 'p2',
    balanceType: BALANCE.CASH,
  });
  assert.equal(deltaFor(e, ALICE, BALANCE.CASH), -5250, 'amount plus the R2.50 fee');
  assert.equal(deltaFor(e, BOB, BALANCE.CASH), 5000);
  // The fee lands in revenue, which has no wallet row.
  assert.equal(walletDeltas(e.postings).length, 2);
});

test('a cash-out only ever moves the CASH wallet', () => {
  const e = buildCashout({ accountId: ALICE, amountCents: 10000, idemKey: 'c1' });
  const deltas = walletDeltas(e.postings);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].balanceType, BALANCE.CASH);
  assert.equal(deltaFor(e, ALICE, BALANCE.SPEND), 0, 'the no-KYC balance is untouched');
  assert.equal(deltaFor(e, ALICE, BALANCE.CASH), -11200, 'amount plus the R12 fee');
});

test('the same account with two balance types is tracked separately', () => {
  const postings = [
    { accountCode: ACCT.wallet(ALICE, BALANCE.SPEND), debitCents: 5000 },
    { accountCode: ACCT.wallet(ALICE, BALANCE.CASH), creditCents: 5000 },
  ];
  const deltas = walletDeltas(postings);
  assert.equal(deltas.length, 2, 'one entry per (account, balanceType)');
  assert.equal(deltas.find((d) => d.balanceType === BALANCE.SPEND).deltaCents, -5000);
  assert.equal(deltas.find((d) => d.balanceType === BALANCE.CASH).deltaCents, 5000);
});

test('multiple lines on the same wallet are netted into one update', () => {
  const code = ACCT.wallet(ALICE, BALANCE.SPEND);
  const postings = [
    { accountCode: code, debitCents: 3000 },
    { accountCode: code, creditCents: 1000 },
    { accountCode: ACCT.clearing(RAIL.BLU), creditCents: 2000 },
  ];
  const deltas = walletDeltas(postings);
  assert.equal(deltas.length, 1, 'one wallet, one balance update');
  assert.equal(deltas[0].deltaCents, -2000, 'net of the debit and credit');
});

test('an entry with no wallet lines produces no balance updates', () => {
  const postings = [
    { accountCode: ACCT.providerExpense(RAIL.PAYAT), debitCents: 865 },
    { accountCode: ACCT.clearing(RAIL.PAYAT), creditCents: 865 },
  ];
  assert.equal(walletDeltas(postings).length, 0);
});
