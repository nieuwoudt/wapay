import { getPrisma } from './db';
import { validateBalanced, JournalPosting } from '@wapay/ledger';

export async function postBluDeposit(args: {
  accountId: string;
  amountCents: number;
  providerRef: string;
  idemKey: string;
}): Promise<{ journalEntryId: string }> {
  const prisma = getPrisma();
  const postings: JournalPosting[] = [
    { accountCode: 'Clearing:Blu', debitCents: args.amountCents },
    { accountCode: 'Wallet:MAIN', creditCents: args.amountCents },
  ];
  validateBalanced(postings);

  const entry = await prisma.$transaction(async (tx) => {
    const je = await tx.journalEntry.create({
      data: {
        externalRef: args.providerRef,
        source: 'BLU_DEPOSIT',
        lines: {
          create: postings.map((p) => ({
            accountCode: p.accountCode,
            debitCents: p.debitCents ?? null,
            creditCents: p.creditCents ?? null,
          })),
        },
      },
    });

    await tx.wallet.updateMany({
      where: { accountId: args.accountId },
      data: { availableCents: { increment: args.amountCents } },
    });

    return je;
  });

  return { journalEntryId: entry.id };
}


