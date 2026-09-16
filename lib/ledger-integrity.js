/**
 * Nightly balance integrity (docs/AGENT_ARCHITECTURE_V2.md C17): every
 * wallet's stored balance re-derived from the journal. A mismatch means a
 * bug or a bypass of postEntry() and must be investigated. Read-only.
 */
import prisma from './prisma.js';
import { deriveBalanceFromJournal } from './ledger-post.js';

export async function checkWalletIntegrity({ prisma: prismaClient = prisma, limit = 500, deadlineMs = 20 * 1000 } = {}) {
  const startedAt = Date.now();
  const wallets = await prismaClient.wallet.findMany({
    select: { id: true, accountId: true, balanceType: true, availableCents: true, pendingCents: true },
    orderBy: { updatedAt: 'desc' },
    take: Math.min(5000, Math.max(1, Number(limit) || 500)),
  });
  const mismatches = [];
  let checked = 0;
  let stopped = false;
  for (const w of wallets) {
    if (Date.now() - startedAt > deadlineMs) { stopped = true; break; }
    const derived = await deriveBalanceFromJournal({ accountId: w.accountId, balanceType: w.balanceType });
    const stored = Number(w.availableCents || 0) + Number(w.pendingCents || 0);
    checked += 1;
    if (derived !== stored) mismatches.push({ walletId: w.id, accountId: w.accountId, balanceType: w.balanceType, storedCents: stored, derivedCents: derived, driftCents: stored - derived });
  }
  return { checked, total: wallets.length, mismatches, stopped };
}
