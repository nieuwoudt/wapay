/**
 * Ledger database verification — run this against a REAL database after the
 * 20260810_ledger_core migration to prove the guarantees unit tests can't reach:
 *
 *   1. Replay safety   — posting the same idemKey twice credits money once
 *   2. Race safety     — concurrent spends cannot overdraw a wallet
 *   3. Hold lifecycle  — reserve/settle and reserve/release both balance
 *   4. Webhook dedupe  — the same message id can only be claimed once
 *   5. Reconciliation  — derived balances match stored balances, books balance
 *
 * Usage (against a scratch/staging database, NOT production):
 *   DATABASE_URL="postgresql://..." node scripts/verify-ledger-db.mjs
 *
 * It creates a throwaway account, exercises it, then deletes everything it made.
 */

import prisma from '../lib/prisma.js';
import {
  BALANCE,
  RAIL,
  buildLoad,
  buildSend,
  buildSpend,
} from '../lib/ledger-core.js';
import {
  claimMessage,
  deriveBalanceFromJournal,
  ensureWallet,
  postEntry,
  releaseHold,
  reserveHold,
  settleHold,
  trialBalance,
} from '../lib/ledger-post.js';

const RUN = `verify_${process.pid}`;
let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function balanceOf(accountId, balanceType = BALANCE.SPEND) {
  const w = await prisma.wallet.findFirst({ where: { accountId, balanceType } });
  return w ? w.availableCents : null;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Point it at a scratch database and retry.');
    process.exit(2);
  }

  console.log(`\nLedger DB verification (run id ${RUN})\n`);

  // Two throwaway accounts.
  const alice = await prisma.account.create({
    data: { waId: `${RUN}_alice`, msisdn: '27000000001', displayName: 'Verify Alice' },
  });
  const bob = await prisma.account.create({
    data: { waId: `${RUN}_bob`, msisdn: '27000000002', displayName: 'Verify Bob' },
  });
  await ensureWallet({ accountId: alice.id, balanceType: BALANCE.SPEND });
  await ensureWallet({ accountId: bob.id, balanceType: BALANCE.SPEND });

  try {
    // -----------------------------------------------------------------------
    console.log('1. Replay safety');
    // -----------------------------------------------------------------------
    const load = buildLoad({
      accountId: alice.id,
      rail: RAIL.BLU,
      faceCents: 10000,
      idemKey: `${RUN}:load`,
    });

    const first = await postEntry(load);
    const second = await postEntry(load);

    check('first post is not a replay', first.replayed === false);
    check('second post is detected as a replay', second.replayed === true);
    check(
      'replay returns the same journal entry',
      first.journalEntryId === second.journalEntryId,
      `${first.journalEntryId} vs ${second.journalEntryId}`
    );
    const afterLoad = await balanceOf(alice.id);
    check('money credited exactly once', afterLoad === 9400, `balance=${afterLoad}, expected 9400`);

    // Concurrent replays of the same key.
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () => postEntry(load).catch((e) => ({ error: e.message })))
    );
    const errors = concurrent.filter((r) => r.error);
    check('concurrent replays do not error', errors.length === 0, JSON.stringify(errors));
    const afterConcurrent = await balanceOf(alice.id);
    check(
      'concurrent replays do not multiply the credit',
      afterConcurrent === 9400,
      `balance=${afterConcurrent}`
    );

    // -----------------------------------------------------------------------
    console.log('\n2. Race safety (no overdraw)');
    // -----------------------------------------------------------------------
    // Alice has 9400. Fire five concurrent 5000c spends; at most one may win.
    const spends = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        postEntry(
          buildSpend({
            accountId: alice.id,
            category: 'AIRTIME',
            saleCents: 5000,
            idemKey: `${RUN}:race:${i}`,
          })
        )
          .then(() => 'ok')
          .catch((e) => e.code ?? e.message)
      )
    );
    const wins = spends.filter((s) => s === 'ok').length;
    const rejected = spends.filter((s) => s === 'INSUFFICIENT_FUNDS').length;

    check('exactly one concurrent spend succeeded', wins === 1, `wins=${wins}, results=${spends}`);
    check('the rest were rejected for insufficient funds', rejected === 4, `rejected=${rejected}`);

    const afterRace = await balanceOf(alice.id);
    check('balance never went negative', afterRace >= 0, `balance=${afterRace}`);
    check('balance is exactly one spend down', afterRace === 4400, `balance=${afterRace}`);

    // -----------------------------------------------------------------------
    console.log('\n3. Hold lifecycle');
    // -----------------------------------------------------------------------
    const beforeHold = await balanceOf(alice.id);
    await reserveHold({
      accountId: alice.id,
      amountCents: 2000,
      idemKey: `${RUN}:hold:settle`,
      reason: 'verify',
    });
    const heldWallet = await prisma.wallet.findFirst({
      where: { accountId: alice.id, balanceType: BALANCE.SPEND },
    });
    check('reserve moves funds out of available', heldWallet.availableCents === beforeHold - 2000);
    check('reserve moves funds into pending', heldWallet.pendingCents === 2000);

    // Reserving more than is available must fail.
    const overReserve = await reserveHold({
      accountId: alice.id,
      amountCents: 99999999,
      idemKey: `${RUN}:hold:over`,
    })
      .then(() => 'ok')
      .catch((e) => e.code);
    check('cannot reserve more than available', overReserve === 'INSUFFICIENT_FUNDS', String(overReserve));

    // Settle: the held funds become a real spend, debited exactly once.
    await settleHold({
      idemKey: `${RUN}:hold:settle`,
      entry: buildSpend({
        accountId: alice.id,
        category: 'AIRTIME',
        saleCents: 2000,
        idemKey: `${RUN}:hold:settle:entry`,
      }),
    });
    const afterSettle = await prisma.wallet.findFirst({
      where: { accountId: alice.id, balanceType: BALANCE.SPEND },
    });
    check(
      'settle debits the customer exactly once',
      afterSettle.availableCents === beforeHold - 2000,
      `balance=${afterSettle.availableCents}, expected ${beforeHold - 2000}`
    );
    check('settle clears pending', afterSettle.pendingCents === 0, `pending=${afterSettle.pendingCents}`);

    // Release: a failed provider call gives the money back.
    const beforeRelease = afterSettle.availableCents;
    await reserveHold({ accountId: alice.id, amountCents: 1500, idemKey: `${RUN}:hold:release` });
    await releaseHold({ idemKey: `${RUN}:hold:release`, reason: 'provider timeout' });
    const afterRelease = await prisma.wallet.findFirst({
      where: { accountId: alice.id, balanceType: BALANCE.SPEND },
    });
    check(
      'release returns the money',
      afterRelease.availableCents === beforeRelease,
      `balance=${afterRelease.availableCents}, expected ${beforeRelease}`
    );
    check('release clears pending', afterRelease.pendingCents === 0);

    // -----------------------------------------------------------------------
    console.log('\n4. Webhook dedupe');
    // -----------------------------------------------------------------------
    const msgId = `wamid.${RUN}`;
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => claimMessage({ waMessageId: msgId, accountId: alice.id }))
    );
    check(
      'a message can only be claimed once, even concurrently',
      claims.filter(Boolean).length === 1,
      `claims=${claims}`
    );

    // -----------------------------------------------------------------------
    console.log('\n5. Reconciliation');
    // -----------------------------------------------------------------------
    await postEntry(
      buildSend({
        fromAccountId: alice.id,
        toAccountId: bob.id,
        amountCents: 1000,
        idemKey: `${RUN}:send`,
      })
    );

    for (const [label, acct] of [['alice', alice], ['bob', bob]]) {
      const stored = await balanceOf(acct.id);
      const derived = await deriveBalanceFromJournal({ accountId: acct.id });
      check(
        `${label}: stored balance matches the journal`,
        stored === derived,
        `stored=${stored} derived=${derived}`
      );
    }

    const tb = await trialBalance();
    check('global trial balance is zero', tb.balanced, JSON.stringify(tb));
  } finally {
    // -----------------------------------------------------------------------
    console.log('\nCleaning up');
    // -----------------------------------------------------------------------
    const accountIds = [alice.id, bob.id];
    const wallets = await prisma.wallet.findMany({
      where: { accountId: { in: accountIds } },
      select: { id: true },
    });
    await prisma.hold.deleteMany({ where: { walletId: { in: wallets.map((w) => w.id) } } });
    await prisma.processedMessage.deleteMany({ where: { accountId: { in: accountIds } } });
    const entries = await prisma.journalEntry.findMany({
      where: { idemKey: { startsWith: RUN } },
      select: { id: true },
    });
    await prisma.journalLine.deleteMany({ where: { entryId: { in: entries.map((e) => e.id) } } });
    await prisma.journalEntry.deleteMany({ where: { idemKey: { startsWith: RUN } } });
    await prisma.wallet.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    console.log('  removed all verification data');
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nVerification crashed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
