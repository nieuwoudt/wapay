/**
 * WaPay Ledger — the single database writer for money.
 *
 * RULE: no other module may mutate Wallet.availableCents / pendingCents or
 * create JournalEntry / JournalLine rows. Everything goes through postEntry(),
 * reserveHold(), settleHold() and releaseHold() here.
 *
 * Division of labour:
 *   lib/ledger-core.js  builds balanced postings (pure, no I/O, unit-tested)
 *   lib/ledger-post.js  persists them atomically (this file)
 *
 * Every write is a single Prisma transaction keyed on a deterministic idemKey,
 * so a replay returns the original entry rather than posting a second one.
 */

import prisma from './prisma.js';
import { ACCT, BALANCE, validateBalanced } from './ledger-core.js';

/** Thrown when a customer does not have the funds for an operation. */
export class InsufficientFundsError extends Error {
  constructor({ accountId, balanceType, requiredCents, availableCents }) {
    super(
      `Insufficient ${balanceType} balance for ${accountId}: need ${requiredCents}, have ${availableCents}`
    );
    this.name = 'InsufficientFundsError';
    this.code = 'INSUFFICIENT_FUNDS';
    this.accountId = accountId;
    this.balanceType = balanceType;
    this.requiredCents = requiredCents;
    this.availableCents = availableCents;
  }
}

/** Thrown when an account code names a wallet that does not exist. */
export class WalletNotFoundError extends Error {
  constructor(accountCode) {
    super(`No wallet for account code ${accountCode}`);
    this.name = 'WalletNotFoundError';
    this.code = 'WALLET_NOT_FOUND';
    this.accountCode = accountCode;
  }
}

const WALLET_CODE = /^WALLET:([^:]+):(SPEND|CASH)$/;

/**
 * Parse `WALLET:{accountId}:{SPEND|CASH}` into its parts.
 * Returns null for any non-wallet account code (clearing, revenue, expense),
 * which have no balance row to maintain — the journal IS their balance.
 */
export function parseWalletCode(accountCode) {
  const m = WALLET_CODE.exec(accountCode);
  if (!m) return null;
  return { accountId: m[1], balanceType: m[2] };
}

/**
 * Net effect of an entry on each wallet, in cents.
 * Wallets are liabilities: a credit increases what the customer holds.
 * Exported so the mapping can be unit-tested without a database.
 */
export function walletDeltas(postings) {
  const deltas = new Map();
  for (const p of postings) {
    const parsed = parseWalletCode(p.accountCode);
    if (!parsed) continue;
    const delta = (p.creditCents ?? 0) - (p.debitCents ?? 0);
    const key = `${parsed.accountId}:${parsed.balanceType}`;
    const prev = deltas.get(key) ?? { ...parsed, deltaCents: 0 };
    prev.deltaCents += delta;
    deltas.set(key, prev);
  }
  return [...deltas.values()];
}

/** Shape a stored entry into the value callers get back. */
function toResult(entry, replayed) {
  return {
    journalEntryId: entry.id,
    idemKey: entry.idemKey,
    source: entry.source,
    replayed,
    postings: (entry.lines ?? []).map((l) => ({
      accountCode: l.accountCode,
      debitCents: l.debitCents ?? undefined,
      creditCents: l.creditCents ?? undefined,
    })),
  };
}

/**
 * Persist a balanced journal entry and apply its wallet effects atomically.
 *
 * @param {object} entry - normally the output of a lib/ledger-core.js builder
 * @param {string} entry.idemKey - deterministic; a replay returns the original
 * @param {string} entry.source - e.g. LOAD_BLU, SPEND_AIRTIME, P2P_SEND
 * @param {Array} entry.postings - balanced debit/credit lines
 * @param {object} [entry.meta] - stored as JournalEntry.metadata
 * @param {string} [entry.externalRef] - provider reference, if known
 * @param {object} [opts]
 * @param {boolean} [opts.allowNegative=false] - escape hatch for corrections
 * @param {object} [opts.tx] - run inside an existing Prisma transaction
 * @returns {Promise<{journalEntryId: string, replayed: boolean, postings: Array}>}
 */
export async function postEntry(entry, opts = {}) {
  const { idemKey, source, postings, meta, externalRef } = entry;

  if (!idemKey) throw new Error('postEntry requires a deterministic idemKey');
  if (!source) throw new Error('postEntry requires a source');
  validateBalanced(postings);

  const run = async (tx) => {
    // Replay check first: an already-posted key must never post twice.
    const existing = await tx.journalEntry.findUnique({
      where: { idemKey },
      include: { lines: true },
    });
    if (existing) return toResult(existing, true);

    const created = await tx.journalEntry.create({
      data: {
        idemKey,
        source,
        externalRef: externalRef ?? null,
        metadata: meta ?? undefined,
        lines: {
          create: postings.map((p) => ({
            accountCode: p.accountCode,
            debitCents: p.debitCents ?? null,
            creditCents: p.creditCents ?? null,
          })),
        },
      },
      include: { lines: true },
    });

    for (const { accountId, balanceType, deltaCents } of walletDeltas(postings)) {
      if (deltaCents === 0) continue;

      if (deltaCents > 0) {
        const updated = await tx.wallet.updateMany({
          where: { accountId, balanceType },
          data: { availableCents: { increment: deltaCents } },
        });
        if (updated.count === 0) {
          throw new WalletNotFoundError(ACCT.wallet(accountId, balanceType));
        }
        continue;
      }

      // Debit: conditional update is the atomic check-and-decrement that
      // closes the check-then-write race in the old spend paths. If another
      // request spent the funds first, count is 0 and we abort the whole
      // transaction rather than driving the balance negative.
      const required = -deltaCents;
      const where = { accountId, balanceType };
      if (!opts.allowNegative) where.availableCents = { gte: required };

      const updated = await tx.wallet.updateMany({
        where,
        data: { availableCents: { decrement: required } },
      });

      if (updated.count === 0) {
        const wallet = await tx.wallet.findFirst({
          where: { accountId, balanceType },
          select: { availableCents: true },
        });
        if (!wallet) throw new WalletNotFoundError(ACCT.wallet(accountId, balanceType));
        throw new InsufficientFundsError({
          accountId,
          balanceType,
          requiredCents: required,
          availableCents: wallet.availableCents,
        });
      }
    }

    return toResult(created, false);
  };

  if (opts.tx) return run(opts.tx);

  try {
    return await prisma.$transaction(run);
  } catch (err) {
    // Two concurrent posts of the same key: the loser hits the unique
    // constraint. That is success — the entry exists; return the winner's.
    if (err?.code === 'P2002') {
      const winner = await prisma.journalEntry.findUnique({
        where: { idemKey },
        include: { lines: true },
      });
      if (winner) return toResult(winner, true);
    }
    throw err;
  }
}

/**
 * Reserve funds before calling a provider.
 *
 * Moves value from available to pending in one atomic step, so the customer
 * cannot spend it twice while the provider call is in flight. No journal
 * entry is posted yet — a hold is not a transaction, it is a promise.
 */
export async function reserveHold({ accountId, amountCents, idemKey, balanceType = BALANCE.SPEND, reason }) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`reserveHold requires a positive integer amountCents, got ${amountCents}`);
  }
  if (!idemKey) throw new Error('reserveHold requires a deterministic idemKey');

  return prisma.$transaction(async (tx) => {
    const existing = await tx.hold.findUnique({ where: { idemKey } });
    if (existing) return { holdId: existing.id, status: existing.status, replayed: true };

    const wallet = await tx.wallet.findFirst({ where: { accountId, balanceType } });
    if (!wallet) throw new WalletNotFoundError(ACCT.wallet(accountId, balanceType));

    const moved = await tx.wallet.updateMany({
      where: { id: wallet.id, availableCents: { gte: amountCents } },
      data: {
        availableCents: { decrement: amountCents },
        pendingCents: { increment: amountCents },
      },
    });
    if (moved.count === 0) {
      throw new InsufficientFundsError({
        accountId,
        balanceType,
        requiredCents: amountCents,
        availableCents: wallet.availableCents,
      });
    }

    const hold = await tx.hold.create({
      data: { walletId: wallet.id, idemKey, amountCents, status: 'ACTIVE', reason: reason ?? null },
    });
    return { holdId: hold.id, status: 'ACTIVE', replayed: false };
  });
}

/**
 * The provider call succeeded: convert the hold into a real journal entry.
 *
 * Mechanics, all inside one transaction: return the held funds to available
 * and clear pending (undoing the reserve), then post the entry normally so
 * its wallet debit applies exactly once. Net effect on available is the
 * entry's amount, never twice, and postEntry needs no special case.
 *
 * The settled entry may be for LESS than was held (e.g. the final price came
 * in lower); the difference simply stays with the customer.
 */
export async function settleHold({ idemKey, entry }) {
  return prisma.$transaction(async (tx) => {
    const hold = await tx.hold.findUnique({ where: { idemKey } });
    if (!hold) throw new Error(`No hold for idemKey ${idemKey}`);

    if (hold.status === 'ACTIVE') {
      await tx.wallet.update({
        where: { id: hold.walletId },
        data: {
          availableCents: { increment: hold.amountCents },
          pendingCents: { decrement: hold.amountCents },
        },
      });
      await tx.hold.update({
        where: { id: hold.id },
        data: { status: 'SETTLED', resolvedAt: new Date() },
      });
    }

    if (!entry) return { settled: true, journalEntryId: null, replayed: false };

    const result = await postEntry(entry, { tx });
    return { settled: true, journalEntryId: result.journalEntryId, replayed: result.replayed };
  });
}

/**
 * The provider call failed: give the money back.
 * Returns pending to available and marks the hold released. No journal entry
 * is posted because, as far as the books are concerned, nothing happened.
 */
export async function releaseHold({ idemKey, reason }) {
  return prisma.$transaction(async (tx) => {
    const hold = await tx.hold.findUnique({ where: { idemKey } });
    if (!hold) throw new Error(`No hold for idemKey ${idemKey}`);
    if (hold.status !== 'ACTIVE') return { released: false, status: hold.status };

    await tx.wallet.update({
      where: { id: hold.walletId },
      data: {
        availableCents: { increment: hold.amountCents },
        pendingCents: { decrement: hold.amountCents },
      },
    });
    await tx.hold.update({
      where: { id: hold.id },
      data: { status: 'RELEASED', reason: reason ?? hold.reason, resolvedAt: new Date() },
    });
    return { released: true, status: 'RELEASED' };
  });
}

/**
 * Record a WhatsApp message as processed. Returns false if it was already
 * seen, in which case the caller must not process it again.
 *
 * Uniqueness in the database is the guard — not an in-memory Set, which does
 * not survive serverless invocations.
 */
export async function claimMessage({ waMessageId, accountId }) {
  if (!waMessageId) throw new Error('claimMessage requires a waMessageId');
  try {
    await prisma.processedMessage.create({ data: { waMessageId, accountId: accountId ?? null } });
    return true;
  } catch (err) {
    if (err?.code === 'P2002') return false;
    throw err;
  }
}

/**
 * Ensure a customer has the wallet a flow is about to use.
 * Idempotent, so it is safe to call on every inbound message.
 */
export async function ensureWallet({ accountId, balanceType = BALANCE.SPEND, currency = 'ZAR' }) {
  const existing = await prisma.wallet.findFirst({ where: { accountId, balanceType } });
  if (existing) return existing;
  try {
    return await prisma.wallet.create({ data: { accountId, balanceType, currency } });
  } catch (err) {
    if (err?.code === 'P2002') return prisma.wallet.findFirst({ where: { accountId, balanceType } });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reconciliation — proving the books are right
// ---------------------------------------------------------------------------

/**
 * Balance derived from journal lines, independent of the stored wallet row.
 * The whole point: if this disagrees with the wallet, something is wrong.
 */
export async function deriveBalanceFromJournal({ accountId, balanceType = BALANCE.SPEND }) {
  const code = ACCT.wallet(accountId, balanceType);
  const agg = await prisma.journalLine.aggregate({
    where: { accountCode: code },
    _sum: { debitCents: true, creditCents: true },
  });
  const credits = Number(agg._sum.creditCents ?? 0);
  const debits = Number(agg._sum.debitCents ?? 0);
  return credits - debits;
}

/**
 * Compare every wallet's stored balance against its derived balance.
 * Any mismatch is a bug or a bypass of postEntry() and must be investigated.
 */
export async function reconcileWallets({ limit = 500 } = {}) {
  const wallets = await prisma.wallet.findMany({
    take: limit,
    select: { id: true, accountId: true, balanceType: true, availableCents: true, pendingCents: true },
  });

  const mismatches = [];
  for (const w of wallets) {
    const derived = await deriveBalanceFromJournal({
      accountId: w.accountId,
      balanceType: w.balanceType,
    });
    // Held funds have left `available` but no journal entry exists yet.
    const expected = derived - w.pendingCents;
    if (expected !== w.availableCents) {
      mismatches.push({
        walletId: w.id,
        accountId: w.accountId,
        balanceType: w.balanceType,
        storedCents: w.availableCents,
        derivedCents: expected,
        differenceCents: w.availableCents - expected,
      });
    }
  }
  return { checked: wallets.length, mismatches };
}

/**
 * Global trial balance. Across every journal line ever written, total debits
 * must equal total credits. If this is not zero, the ledger is broken.
 */
export async function trialBalance() {
  const agg = await prisma.journalLine.aggregate({
    _sum: { debitCents: true, creditCents: true },
  });
  const debits = Number(agg._sum.debitCents ?? 0);
  const credits = Number(agg._sum.creditCents ?? 0);
  return { debitCents: debits, creditCents: credits, differenceCents: debits - credits, balanced: debits === credits };
}
