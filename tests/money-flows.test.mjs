/**
 * Mission Control's money flows (lib/money-flows.js): what counts as money in, spend, a transfer and money out,
 * and what a reversal takes off. The entries come from the real ledger builders, aggregated the way the two
 * routes' SQL aggregates them, so a change to a builder or to the reading shows here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { flowBucket, flowOfRow, FLOW_LINE_PATTERNS } from '../lib/money-flows.js';
import { RAIL, buildLoad, buildSpend, buildSend, buildReversal, buildChargeback } from '../lib/ledger-core.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const ALICE = 'acc_alice';
const BOB = 'acc_bob';

// What the routes' SQL does: per entry source, sum the credit and the debit of the counted lines.
const likeToRe = (p) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`);
const COUNTED = FLOW_LINE_PATTERNS.map(likeToRe);

function aggregate(entries) {
  const rows = new Map();
  for (const e of entries) {
    const row = rows.get(e.source) || { source: e.source, credit: 0, debit: 0 };
    for (const p of e.postings) {
      if (!COUNTED.some((re) => re.test(p.accountCode))) continue;
      row.credit += p.creditCents || 0;
      row.debit += p.debitCents || 0;
    }
    rows.set(e.source, row);
  }
  return [...rows.values()];
}

function totals(entries) {
  const t = { in: 0, spend: 0, transfer: 0, out: 0 };
  for (const row of aggregate(entries)) {
    const { bucket, cents } = flowOfRow(row);
    if (bucket !== 'other') t[bucket] += cents;
  }
  return t;
}

const walletCredit = (entry) => entry.postings.filter((p) => p.accountCode.startsWith('WALLET:')).reduce((n, p) => n + (p.creditCents || 0), 0);

test('a source is read as money in, spend, a transfer, money out or nothing', () => {
  assert.equal(flowBucket('LOAD_PAYFAST'), 'in');
  assert.equal(flowBucket('SPEND_AIRTIME'), 'spend');
  assert.equal(flowBucket('VOUCHER_GIFT_OTT'), 'spend');
  assert.equal(flowBucket('P2P_SEND'), 'transfer');
  assert.equal(flowBucket('CASHOUT_PAYSHAP'), 'out');
  assert.equal(flowBucket('FLOAT_LOAD'), 'other');
  assert.equal(flowBucket(null), 'other');
  assert.deepEqual(flowOfRow({ source: 'FLOAT_LOAD', credit: 500, debit: 500 }), { bucket: 'other', cents: 0 });
  assert.deepEqual(flowOfRow({ source: null, credit: 500, debit: 0 }), { bucket: 'other', cents: 0 });
});

test('the database hands back bigint sums and they are read as numbers', () => {
  assert.deepEqual(flowOfRow({ source: 'LOAD_PAYFAST', credit: 287170n, debit: 0n }), { bucket: 'in', cents: 287170 });
  assert.deepEqual(flowOfRow({ source: 'REVERSAL_LOAD_PAYFAST', credit: 0n, debit: 287170n }), { bucket: 'in', cents: -287170 });
  assert.deepEqual(flowOfRow({ source: 'LOAD_PAYFAST', credit: null, debit: null }), { bucket: 'in', cents: 0 });
});

test('a card load counts as money in by what reached the wallet, and a refund takes all of it off', () => {
  const load = buildLoad({ accountId: ALICE, rail: RAIL.PAYFAST, faceCents: 300000, idemKey: 'load-a', customerFeeCents: 12830 });
  const credited = walletCredit(load);
  assert.ok(credited > 0);
  assert.equal(totals([load]).in, credited);

  const refund = buildReversal({ original: load, idemKey: 'card-refund-load-a', reason: 'refund' });
  assert.equal(refund.source, 'REVERSAL_LOAD_PAYFAST');
  assert.equal(totals([load, refund]).in, 0, 'a refunded card payment is no longer money in');
});

test('a reversal takes off only the load it reverses', () => {
  const a = buildLoad({ accountId: ALICE, rail: RAIL.PAYFAST, faceCents: 300000, idemKey: 'load-a', customerFeeCents: 12830 });
  const b = buildLoad({ accountId: BOB, rail: RAIL.PAYFAST, faceCents: 50000, idemKey: 'load-b', customerFeeCents: 2200 });
  const refund = buildReversal({ original: a, idemKey: 'card-refund-load-a', reason: 'refund' });
  assert.equal(totals([a, b, refund]).in, walletCredit(b));
});

test('a chargeback takes the whole load off money in, whatever part the wallet still held', () => {
  const load = buildLoad({ accountId: ALICE, rail: RAIL.PAYFAST, faceCents: 300000, idemKey: 'load-a', customerFeeCents: 12830 });
  const credited = walletCredit(load);
  for (const walletDebitCents of [0, 70, credited]) {
    const chargeback = buildChargeback({ original: load, idemKey: `card-chargeback-load-a-${walletDebitCents}`, walletDebitCents, reason: 'chargeback' });
    assert.equal(chargeback.source, 'REVERSAL_LOAD_PAYFAST');
    assert.equal(totals([load, chargeback]).in, 0, `wallet part ${walletDebitCents}`);
  }
});

test('the part of a chargeback WaPay absorbs is counted only because its line is on the list', () => {
  const load = buildLoad({ accountId: ALICE, rail: RAIL.PAYFAST, faceCents: 300000, idemKey: 'load-a', customerFeeCents: 12830 });
  const chargeback = buildChargeback({ original: load, idemKey: 'card-chargeback-load-a', walletDebitCents: 70, reason: 'chargeback' });
  const lossLines = chargeback.postings.filter((p) => p.accountCode.startsWith('EXPENSE:CHARGEBACK:'));
  assert.equal(lossLines.length, 1);
  assert.ok(COUNTED.some((re) => re.test(lossLines[0].accountCode)), 'FLOW_LINE_PATTERNS covers the chargeback loss line');
  assert.deepEqual([...FLOW_LINE_PATTERNS], ['WALLET:%', 'EXPENSE:CHARGEBACK:%']);
});

test('a reversed purchase comes off spend and a reversed send comes off transfers', () => {
  const spend = buildSpend({ accountId: ALICE, category: 'AIRTIME', saleCents: 9400, idemKey: 'spend-a' });
  assert.equal(totals([spend]).spend, 9400);
  const spendBack = buildReversal({ original: spend, idemKey: 'reversal-spend-a', reason: 'supplier failed' });
  assert.equal(totals([spend, spendBack]).spend, 0);

  const send = buildSend({ fromAccountId: ALICE, toAccountId: BOB, amountCents: 5000, idemKey: 'send-a' });
  assert.equal(totals([send]).transfer, 5000);
  const sendBack = buildReversal({ original: send, idemKey: 'reversal-send-a', reason: 'operator' });
  assert.equal(totals([send, sendBack]).transfer, 0);
});

test('the Dashboard and the Growth tab both read flows through the shared helper and count the same lines', () => {
  for (const rel of ['../pages/api/admin/metrics.js', '../pages/api/admin/growth.js']) {
    const src = read(rel);
    assert.match(src, /import \{ flowOfRow \} from '\.\.\/\.\.\/\.\.\/lib\/money-flows\.js';/, `${rel} imports the helper`);
    assert.ok(/flowOfRow\(/.test(src.replace(/import[^\n]+\n/g, '')), `${rel} uses the helper`);
    assert.ok(!/function bucketOf\(/.test(src), `${rel} keeps no private copy of the buckets`);
    assert.ok(!/sign \* /.test(src), `${rel} keeps no private reading of a reversal`);
    for (const pattern of FLOW_LINE_PATTERNS) {
      assert.ok(src.includes(`jl."accountCode" LIKE '${pattern}'`), `${rel} counts ${pattern} lines`);
    }
  }
});
