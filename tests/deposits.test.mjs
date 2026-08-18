/**
 * Deposit intents (lib/deposits.js) — stubbed prisma, no database — plus
 * static guards over the PayFast ITN route (pages/api/payfast/itn.js).
 *
 * What must hold:
 *   * an intent's idemKey is 'wapay-pfdep-' + its row id, and that key
 *     survives ledger-core's timestamp-lookalike guard (a key buildLoad
 *     accepts is a key postEntry can replay on ITN redelivery)
 *   * amount guards: R10 min, R3000 max, integer cents only
 *   * SUCCESS is terminal — a late FAILED mark cannot flip it
 *   * the ITN route verifies BEFORE it credits, credits from the intent (not
 *     from PayFast's amount_gross), and posts with the intent's idemKey
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createDepositIntent,
  getDepositIntent,
  markDeposit,
  recordItnDebug,
  centsToRandString,
  DEPOSIT_IDEM_PREFIX,
  MIN_DEPOSIT_CENTS,
  MAX_DEPOSIT_CENTS,
} from '../lib/deposits.js';
import { buildLoad, RAIL } from '../lib/ledger-core.js';

const ACCOUNT = 'acct_test_1';
const WA_ID = '27840000000';

/** Yield the event loop so calls interleave like real queries. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Minimal in-memory prisma.providerRequest mirroring the store's semantics:
 * unique id and idemKey (P2002), update throws P2025 on a missing row, and
 * updateMany with a `status: { not: ... }` filter is an atomic check-and-set.
 */
function makeStubPrisma() {
  const rows = [];
  const clone = (r) => ({ ...r, metadata: r.metadata ? { ...r.metadata } : r.metadata });

  return {
    _rows: rows,
    providerRequest: {
      async create({ data }) {
        await tick();
        if (rows.some((r) => r.id === data.id || r.idemKey === data.idemKey)) {
          const err = new Error('Unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        const row = {
          providerRef: null,
          responseJson: null,
          redactedPayload: null,
          accountId: null,
          metadata: null,
          requestTs: new Date(),
          ...data,
        };
        rows.push(row);
        return clone(row);
      },
      async findUnique({ where }) {
        await tick();
        const hit = rows.find((r) =>
          where.id !== undefined ? r.id === where.id : r.idemKey === where.idemKey
        );
        return hit ? clone(hit) : null;
      },
      async update({ where, data }) {
        await tick();
        const hit = rows.find((r) => r.id === where.id);
        if (!hit) {
          const err = new Error('Record not found');
          err.code = 'P2025';
          throw err;
        }
        for (const [k, v] of Object.entries(data)) {
          if (v !== undefined) hit[k] = v;
        }
        return clone(hit);
      },
      async updateMany({ where, data }) {
        await tick();
        // Atomic from here down: no await between the check and the write.
        let count = 0;
        for (const r of rows) {
          if (r.id !== where.id) continue;
          if (where.status?.not !== undefined && r.status === where.status.not) continue;
          for (const [k, v] of Object.entries(data)) {
            if (v !== undefined) r[k] = v;
          }
          count += 1;
        }
        return { count };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// createDepositIntent
// ---------------------------------------------------------------------------

test('createDepositIntent creates a PENDING PAYFAST row with a derived idemKey', async () => {
  const prisma = makeStubPrisma();
  const { paymentId, idemKey } = await createDepositIntent({
    prisma,
    accountId: ACCOUNT,
    waId: WA_ID,
    amountCents: 5000,
  });

  assert.equal(idemKey, DEPOSIT_IDEM_PREFIX + paymentId);

  const row = prisma._rows[0];
  assert.equal(row.id, paymentId);
  assert.equal(row.provider, 'PAYFAST');
  assert.equal(row.route, 'deposit');
  assert.equal(row.status, 'PENDING');
  assert.equal(row.idemKey, idemKey);
  assert.equal(row.accountId, ACCOUNT);
  assert.deepEqual(row.metadata, { accountId: ACCOUNT, waId: WA_ID, amountCents: 5000 });
});

test('the intent idemKey is accepted by buildLoad and credits full face on PAYFAST', async () => {
  const prisma = makeStubPrisma();
  const { idemKey } = await createDepositIntent({
    prisma,
    accountId: ACCOUNT,
    waId: WA_ID,
    amountCents: 5000,
  });

  // If ledger-core's timestamp-lookalike guard rejected this key, the real
  // ITN credit would throw — so the entry must build cleanly.
  const entry = buildLoad({ accountId: ACCOUNT, rail: RAIL.PAYFAST, faceCents: 5000, idemKey });
  assert.equal(entry.idemKey, idemKey);
  assert.equal(entry.source, 'LOAD_PAYFAST');

  // FEES.load.PAYFAST is creditPolicy FACE with 0 discount: the customer is
  // credited exactly what they paid.
  const walletLine = entry.postings.find((p) => p.accountCode === `WALLET:${ACCOUNT}:SPEND`);
  assert.equal(walletLine.creditCents, 5000);
});

test('amount guards: R10 min, R3000 max, integers only', async () => {
  const prisma = makeStubPrisma();
  const attempt = (amountCents) =>
    createDepositIntent({ prisma, accountId: ACCOUNT, waId: WA_ID, amountCents });

  // Boundaries are inclusive.
  await attempt(MIN_DEPOSIT_CENTS);
  await attempt(MAX_DEPOSIT_CENTS);

  await assert.rejects(() => attempt(MIN_DEPOSIT_CENTS - 1), /between R10\.00 and R3000\.00/);
  await assert.rejects(() => attempt(MAX_DEPOSIT_CENTS + 1), /between R10\.00 and R3000\.00/);
  await assert.rejects(() => attempt(0), /between/);
  await assert.rejects(() => attempt(-5000), /between/);
  await assert.rejects(() => attempt(50.5), /integer/);
  await assert.rejects(() => attempt('5000'), /integer/);
  await assert.rejects(() => attempt(undefined), /integer/);
});

test('createDepositIntent requires accountId and waId', async () => {
  const prisma = makeStubPrisma();
  await assert.rejects(
    () => createDepositIntent({ prisma, waId: WA_ID, amountCents: 5000 }),
    /accountId is required/
  );
  await assert.rejects(
    () => createDepositIntent({ prisma, accountId: ACCOUNT, amountCents: 5000 }),
    /waId is required/
  );
});

test('intent ids never look like epoch timestamps (ledger-core idemKey guard)', async () => {
  const prisma = makeStubPrisma();
  const lookalike = /(?<!\d)1\d{12}(?!\d)|(?<!\d)1[6-9]\d{8}(?!\d)/;
  for (let i = 0; i < 50; i += 1) {
    const { idemKey } = await createDepositIntent({
      prisma,
      accountId: ACCOUNT,
      waId: WA_ID,
      amountCents: 1000 + i,
    });
    assert.ok(!lookalike.test(idemKey), `idemKey looks timestamp-based: ${idemKey}`);
  }
});

// ---------------------------------------------------------------------------
// getDepositIntent / markDeposit / recordItnDebug
// ---------------------------------------------------------------------------

test('getDepositIntent returns the row, and null for an unknown id', async () => {
  const prisma = makeStubPrisma();
  const { paymentId } = await createDepositIntent({
    prisma,
    accountId: ACCOUNT,
    waId: WA_ID,
    amountCents: 2500,
  });

  const intent = await getDepositIntent({ prisma, paymentId });
  assert.equal(intent.id, paymentId);
  assert.equal(intent.metadata.amountCents, 2500);

  assert.equal(await getDepositIntent({ prisma, paymentId: 'nope' }), null);
});

test('markDeposit SUCCESS stores the providerRef', async () => {
  const prisma = makeStubPrisma();
  const { paymentId } = await createDepositIntent({
    prisma,
    accountId: ACCOUNT,
    waId: WA_ID,
    amountCents: 2500,
  });

  const row = await markDeposit({ prisma, paymentId, status: 'SUCCESS', providerRef: 'pf_123' });
  assert.equal(row.status, 'SUCCESS');
  assert.equal(row.providerRef, 'pf_123');
});

test('markDeposit FAILED works on a PENDING intent', async () => {
  const prisma = makeStubPrisma();
  const { paymentId } = await createDepositIntent({
    prisma,
    accountId: ACCOUNT,
    waId: WA_ID,
    amountCents: 2500,
  });

  const row = await markDeposit({ prisma, paymentId, status: 'FAILED' });
  assert.equal(row.status, 'FAILED');
});

test('SUCCESS is terminal: a late FAILED mark cannot flip it', async () => {
  const prisma = makeStubPrisma();
  const { paymentId } = await createDepositIntent({
    prisma,
    accountId: ACCOUNT,
    waId: WA_ID,
    amountCents: 2500,
  });

  await markDeposit({ prisma, paymentId, status: 'SUCCESS', providerRef: 'pf_123' });
  const row = await markDeposit({ prisma, paymentId, status: 'FAILED' });
  assert.equal(row.status, 'SUCCESS', 'a credited deposit must never be re-marked FAILED');
});

test('markDeposit rejects unknown statuses and unknown payments', async () => {
  const prisma = makeStubPrisma();
  await assert.rejects(
    () => markDeposit({ prisma, paymentId: 'x', status: 'COMPLETE' }),
    /SUCCESS or FAILED/
  );
  await assert.rejects(() => markDeposit({ prisma, paymentId: 'missing', status: 'SUCCESS' }));
  await assert.rejects(
    () => markDeposit({ prisma, paymentId: 'missing', status: 'FAILED' }),
    /No deposit intent/
  );
});

test('recordItnDebug merges the raw ITN into metadata without touching status', async () => {
  const prisma = makeStubPrisma();
  const { paymentId } = await createDepositIntent({
    prisma,
    accountId: ACCOUNT,
    waId: WA_ID,
    amountCents: 2500,
  });

  const rawItn = { m_payment_id: paymentId, payment_status: 'COMPLETE', amount_gross: '99.00' };
  const row = await recordItnDebug({
    prisma,
    paymentId,
    rawItn,
    reason: 'AMOUNT_MISMATCH',
    sourceIp: '197.97.145.144',
  });

  assert.equal(row.status, 'PENDING', 'a rejected ITN must not change the intent status');
  // Original metadata survives the merge.
  assert.equal(row.metadata.accountId, ACCOUNT);
  assert.equal(row.metadata.amountCents, 2500);
  assert.deepEqual(row.metadata.lastItn, rawItn);
  assert.equal(row.metadata.lastItnReason, 'AMOUNT_MISMATCH');
  assert.equal(row.metadata.lastItnSourceIp, '197.97.145.144');

  assert.equal(await recordItnDebug({ prisma, paymentId: 'missing', rawItn }), null);
});

// ---------------------------------------------------------------------------
// centsToRandString — PayFast wire amounts, integer math only
// ---------------------------------------------------------------------------

test('centsToRandString converts with exact integer math', () => {
  assert.equal(centsToRandString(0), '0.00');
  assert.equal(centsToRandString(5), '0.05');
  assert.equal(centsToRandString(1000), '10.00');
  assert.equal(centsToRandString(12345), '123.45');
  assert.equal(centsToRandString(300000), '3000.00');
  // The classic float trap: 19.99 * 100 === 1998.9999999999998.
  assert.equal(centsToRandString(1999), '19.99');
  assert.throws(() => centsToRandString(10.5), /integer/);
  assert.throws(() => centsToRandString(-1), /integer/);
});

// ---------------------------------------------------------------------------
// Static guards over pages/api/payfast/itn.js
// ---------------------------------------------------------------------------

const ROUTE_PATH = 'pages/api/payfast/itn.js';

async function routeText() {
  return readFile(path.join(process.cwd(), ROUTE_PATH), 'utf8');
}

test('ITN route: raw body only — bodyParser disabled, readRawBody used', async () => {
  const text = await routeText();
  assert.match(text, /bodyParser:\s*false/, 'must export config with bodyParser: false');
  assert.ok(text.includes('readRawBody('), 'must read the raw body (signature is over raw bytes)');
  assert.ok(!text.includes('new PrismaClient'), 'must use the lib/prisma singleton');
});

test('ITN route: verifyItn runs before any money movement', async () => {
  const text = await routeText();

  const verifyCall = text.search(/await verifyItn\s*\(/);
  const postCall = text.search(/await postEntry\s*\(/);
  const ensureCall = text.search(/await ensureWallet\s*\(/);
  const markCall = text.search(/markDeposit\s*\(\s*\{\s*paymentId,\s*status:\s*'SUCCESS'/);

  assert.ok(verifyCall !== -1, 'must call verifyItn');
  assert.ok(postCall !== -1, 'must call postEntry');
  assert.ok(ensureCall !== -1, 'must call ensureWallet');
  assert.ok(markCall !== -1, 'must markDeposit SUCCESS with a providerRef');

  assert.ok(verifyCall < ensureCall, 'verifyItn must run before ensureWallet');
  assert.ok(verifyCall < postCall, 'verifyItn must run before postEntry');
  assert.ok(ensureCall < postCall, 'ensureWallet must run before postEntry');
  assert.ok(postCall < markCall, 'the credit must land before the intent is marked SUCCESS');

  const postCalls = text.match(/await postEntry\s*\(/g);
  assert.equal(postCalls.length, 1, 'exactly one postEntry call site');
});

test('ITN route: postEntry uses the intent idemKey and the intent amount', async () => {
  const text = await routeText();

  // The idempotency that makes ITN redeliveries credit exactly once.
  assert.ok(text.includes('idemKey: intent.idemKey'), 'postEntry must use the intent idemKey');

  // The credit amount comes from OUR intent, never from PayFast's wire fields.
  assert.ok(text.includes('faceCents: amountCents'), 'must credit the intent amountCents');
  assert.ok(!text.includes('faceCents: params'), 'must not credit from ITN wire fields');
  assert.ok(text.includes('rail: RAIL.PAYFAST'), 'must load on the PAYFAST rail');

  // No float conversion of wire amounts on the money path.
  assert.ok(!text.includes('parseFloat'), 'no float parsing of amounts');
  assert.ok(!/\*\s*100\b/.test(text), 'no float rand->cents multiplication');

  // Deterministic keys only.
  for (const line of text.split('\n')) {
    if (line.includes('Date.now()') && (line.includes('idemKey') || line.includes('wapay-'))) {
      assert.fail(`non-deterministic idempotency key: ${line.trim()}`);
    }
  }
});

test('ITN route: rejection stores the raw ITN and never credits; send failure never fails the ACK', async () => {
  const text = await routeText();

  // Rejected ITNs are logged with a reason and kept for forensics.
  assert.ok(text.includes('payfast_itn_rejected'), 'must log payfast_itn_rejected with a reason');
  assert.ok(text.includes('recordItnDebug('), 'must store the raw ITN on the intent');

  // The WhatsApp confirmation is best-effort, after the credit, inside the
  // handler's own try/catch — and skipped on a replayed (redelivered) entry.
  const sendCall = text.search(/await sendWhatsAppText\s*\(/);
  const postCall = text.search(/await postEntry\s*\(/);
  assert.ok(sendCall !== -1, 'must send the payer a WhatsApp confirmation');
  assert.ok(postCall < sendCall, 'confirmation only after the credit');
  assert.ok(text.includes('posted.replayed'), 'a redelivered ITN must not message the customer twice');

  const between = text.slice(postCall, sendCall);
  assert.ok(/try\s*\{[^]*$/.test(between), 'the send must sit inside its own try block');

  // Once verified and credited, PayFast always gets its 200.
  assert.match(text, /status\(200\)\.send\('OK'\)/, "must ACK 200 'OK'");
});
