/**
 * Pending-gift claim store — stubbed prisma, no database.
 *
 * The two behaviours that must hold under fire:
 *   * create is idempotent on idemKey (webhook redeliveries must not store
 *     the same voucher twice), including the concurrent-create race
 *   * claim delivers each gift exactly ONCE even when two webhook
 *     invocations race — the status-guarded update decides the winner
 * Plus the security rule: the full voucher PIN never reaches the logs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPendingGift, claimPendingGifts, hasPendingGifts, maskPin } from '../lib/pending-gifts.js';

const SENDER = 'acct_alice';
const RECIPIENT = '0840012300';
const PIN = '1234567890123456';

/** Yield the event loop so concurrent claims interleave like real queries. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Minimal in-memory prisma.pendingGift. Mirrors the store's semantics:
 * unique idemKey (P2002), and updateMany as an atomic check-and-set —
 * the filter and the write happen with no await between them, exactly the
 * guarantee a single UPDATE ... WHERE gives in Postgres.
 */
function makeStubPrisma() {
  const rows = [];
  let seq = 0;
  const clone = (r) => ({ ...r });

  return {
    _rows: rows,
    pendingGift: {
      async findUnique({ where: { idemKey } }) {
        await tick();
        const hit = rows.find((r) => r.idemKey === idemKey);
        return hit ? clone(hit) : null;
      },
      async create({ data }) {
        await tick();
        if (rows.some((r) => r.idemKey === data.idemKey)) {
          const err = new Error('Unique constraint failed on idemKey');
          err.code = 'P2002';
          throw err;
        }
        seq += 1;
        const row = {
          id: `gift_${seq}`,
          voucherSerial: null,
          status: 'ISSUED',
          deliveredAt: null,
          createdAt: new Date(1755500000000 + seq * 1000),
          ...data,
        };
        rows.push(row);
        return clone(row);
      },
      async findMany({ where, orderBy }) {
        await tick();
        let hits = rows.filter(
          (r) =>
            (!where.recipientMsisdn || r.recipientMsisdn === where.recipientMsisdn) &&
            (!where.status || r.status === where.status)
        );
        if (orderBy?.createdAt === 'asc') {
          hits = [...hits].sort((a, b) => a.createdAt - b.createdAt);
        }
        return hits.map(clone);
      },
      async updateMany({ where, data }) {
        await tick();
        // Atomic from here down: no await between the check and the write.
        let count = 0;
        for (const r of rows) {
          if (r.id === where.id && r.status === where.status) {
            Object.assign(r, data);
            count += 1;
          }
        }
        return { count };
      },
      async findFirst({ where }) {
        await tick();
        const hit = rows.find(
          (r) => r.recipientMsisdn === where.recipientMsisdn && r.status === where.status
        );
        return hit ? { id: hit.id } : null;
      },
    },
  };
}

function giftArgs(overrides = {}) {
  return {
    senderAccountId: SENDER,
    recipientMsisdn: RECIPIENT,
    amountCents: 5000,
    rail: 'OTT',
    voucherPin: PIN,
    idemKey: 'gift:wamid.HBgLMjc4:1',
    ...overrides,
  };
}

/** Run fn with console captured; returns everything logged as one string. */
async function withCapturedLogs(fn) {
  const lines = [];
  const capture = (...args) => lines.push(args.join(' '));
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = capture;
  console.error = capture;
  console.warn = capture;
  try {
    await fn();
  } finally {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Create — idempotency
// ---------------------------------------------------------------------------

test('createPendingGift stores an ISSUED row with a normalised msisdn', async () => {
  const stub = makeStubPrisma();
  const gift = await createPendingGift({
    prisma: stub,
    ...giftArgs({ recipientMsisdn: '+27 84 001 2300' }),
  });

  assert.equal(gift.status, 'ISSUED');
  assert.equal(gift.recipientMsisdn, RECIPIENT, 'stored normalised so any claim spelling matches');
  assert.equal(gift.amountCents, 5000);
  assert.equal(gift.voucherPin, PIN, 'the row itself must carry the real PIN — delivery needs it');
  assert.equal(stub._rows.length, 1);
});

test('replaying the same idemKey returns the original row, never a second voucher', async () => {
  const stub = makeStubPrisma();
  const first = await createPendingGift({ prisma: stub, ...giftArgs() });
  const replay = await createPendingGift({ prisma: stub, ...giftArgs() });

  assert.equal(replay.id, first.id);
  assert.equal(stub._rows.length, 1, 'a redelivered webhook must not store the voucher twice');
});

test('concurrent-create race: the P2002 loser returns the winner\'s row', async () => {
  const stub = makeStubPrisma();
  await createPendingGift({ prisma: stub, ...giftArgs() });

  // Simulate the race: the replay check sees nothing (stale read), so the
  // create hits the unique constraint and must recover via re-read.
  const realFindUnique = stub.pendingGift.findUnique.bind(stub.pendingGift);
  let staleReads = 1;
  stub.pendingGift.findUnique = async (args) => {
    if (staleReads > 0) {
      staleReads -= 1;
      return null;
    }
    return realFindUnique(args);
  };

  const loser = await createPendingGift({ prisma: stub, ...giftArgs() });
  assert.equal(loser.idemKey, giftArgs().idemKey);
  assert.equal(stub._rows.length, 1);
});

test('createPendingGift validates its inputs', async () => {
  const stub = makeStubPrisma();
  await assert.rejects(createPendingGift({ prisma: stub, ...giftArgs({ idemKey: '' }) }), /idemKey/);
  await assert.rejects(createPendingGift({ prisma: stub, ...giftArgs({ voucherPin: '' }) }), /voucherPin/);
  await assert.rejects(createPendingGift({ prisma: stub, ...giftArgs({ amountCents: 0 }) }), /positive integer/);
  await assert.rejects(createPendingGift({ prisma: stub, ...giftArgs({ amountCents: 50.5 }) }), /positive integer/);
  await assert.rejects(
    createPendingGift({ prisma: stub, ...giftArgs({ recipientMsisdn: '' }) }),
    /recipientMsisdn/
  );
  assert.equal(stub._rows.length, 0, 'nothing may be stored on a rejected create');
});

// ---------------------------------------------------------------------------
// Claim — oldest first, exactly once
// ---------------------------------------------------------------------------

async function seedGifts(stub, n) {
  const gifts = [];
  for (let i = 1; i <= n; i += 1) {
    gifts.push(
      await createPendingGift({
        prisma: stub,
        ...giftArgs({ idemKey: `gift:wamid.seed:${i}`, amountCents: i * 1000 }),
      })
    );
  }
  return gifts;
}

test('claim delivers every ISSUED gift oldest-first and stamps deliveredAt', async () => {
  const stub = makeStubPrisma();
  const seeded = await seedGifts(stub, 3);

  const delivered = await claimPendingGifts({ prisma: stub, recipientMsisdn: RECIPIENT });

  assert.equal(delivered.length, 3);
  assert.deepEqual(
    delivered.map((g) => g.id),
    seeded.map((g) => g.id),
    'oldest gift first'
  );
  for (const g of delivered) {
    assert.equal(g.status, 'DELIVERED');
    assert.ok(g.deliveredAt instanceof Date);
    assert.equal(g.voucherPin, PIN, 'delivery needs the real PIN');
  }
  assert.ok(stub._rows.every((r) => r.status === 'DELIVERED'), 'store rows are updated too');
});

test('a second claim finds nothing — gifts deliver exactly once', async () => {
  const stub = makeStubPrisma();
  await seedGifts(stub, 2);

  const first = await claimPendingGifts({ prisma: stub, recipientMsisdn: RECIPIENT });
  const second = await claimPendingGifts({ prisma: stub, recipientMsisdn: RECIPIENT });

  assert.equal(first.length, 2);
  assert.deepEqual(second, []);
});

test('two CONCURRENT claims never deliver the same gift twice', async () => {
  const stub = makeStubPrisma();
  const seeded = await seedGifts(stub, 3);

  // Both invocations read the same ISSUED snapshot (the stub awaits between
  // queries, so they interleave); the status-guarded update decides each row.
  const [a, b] = await Promise.all([
    claimPendingGifts({ prisma: stub, recipientMsisdn: RECIPIENT }),
    claimPendingGifts({ prisma: stub, recipientMsisdn: RECIPIENT }),
  ]);

  const ids = [...a, ...b].map((g) => g.id);
  assert.equal(ids.length, seeded.length, 'every gift delivered, none dropped');
  assert.equal(new Set(ids).size, seeded.length, 'no gift delivered by both claimers');
});

test('claim matches any spelling of the recipient number', async () => {
  const stub = makeStubPrisma();
  await seedGifts(stub, 1);
  const delivered = await claimPendingGifts({ prisma: stub, recipientMsisdn: '+27840012300' });
  assert.equal(delivered.length, 1);
});

test('claim ignores CANCELLED and already-DELIVERED rows', async () => {
  const stub = makeStubPrisma();
  const [keep] = await seedGifts(stub, 1);
  stub._rows.push(
    { ...stub._rows[0], id: 'gift_cancelled', idemKey: 'k-cancelled', status: 'CANCELLED' },
    { ...stub._rows[0], id: 'gift_done', idemKey: 'k-done', status: 'DELIVERED' }
  );

  const delivered = await claimPendingGifts({ prisma: stub, recipientMsisdn: RECIPIENT });
  assert.deepEqual(delivered.map((g) => g.id), [keep.id]);
});

test('claim for a number with nothing waiting returns []', async () => {
  const stub = makeStubPrisma();
  assert.deepEqual(await claimPendingGifts({ prisma: stub, recipientMsisdn: '0830012300' }), []);
});

// ---------------------------------------------------------------------------
// hasPendingGifts
// ---------------------------------------------------------------------------

test('hasPendingGifts flips from true to false once claimed, and claims nothing itself', async () => {
  const stub = makeStubPrisma();
  await seedGifts(stub, 1);

  assert.equal(await hasPendingGifts({ prisma: stub, recipientMsisdn: RECIPIENT }), true);
  assert.equal(stub._rows[0].status, 'ISSUED', 'a read-only check must not deliver');

  await claimPendingGifts({ prisma: stub, recipientMsisdn: RECIPIENT });
  assert.equal(await hasPendingGifts({ prisma: stub, recipientMsisdn: RECIPIENT }), false);
});

// ---------------------------------------------------------------------------
// The security rule: full PINs never reach the logs
// ---------------------------------------------------------------------------

test('the full voucher PIN never appears in any log line', async () => {
  const stub = makeStubPrisma();
  const output = await withCapturedLogs(async () => {
    await createPendingGift({ prisma: stub, ...giftArgs() });
    await claimPendingGifts({ prisma: stub, recipientMsisdn: RECIPIENT });
  });

  assert.ok(output.length > 0, 'the flows do log (structured JSON)');
  assert.ok(!output.includes(PIN), 'a bearer secret in the logs is a stolen voucher');
  assert.ok(output.includes(maskPin(PIN)), 'the masked hint is what gets logged');
  assert.ok(!output.includes(RECIPIENT), 'recipient msisdn is masked in logs too');
});

test('maskPin masks in the maskMsisdn style and refuses short inputs', () => {
  assert.equal(maskPin('1234567890123456'), '•••3456');
  assert.equal(maskPin('123'), '', 'too short to mask safely');
  assert.equal(maskPin(''), '');
  assert.ok(!maskPin(PIN).includes(PIN.slice(0, 8)), 'the head of the PIN is gone');
});
