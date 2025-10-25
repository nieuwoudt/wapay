import { getPrisma } from './db';
import { YoyoClient } from '@wapay/providers-yoyo';

export async function ensureYoyoInstrument(accountId: string) {
  const prisma = getPrisma();
  let yoyoInstrument = await prisma.yoyoInstrument.findUnique({ where: { accountId } });

  if (!yoyoInstrument) {
    // Call Yoyo API to issue a new gift instrument
    const yoyoClient = new YoyoClient();
    const issued = await yoyoClient.issueGift(accountId, 0);

    yoyoInstrument = await prisma.yoyoInstrument.create({
      data: {
        accountId,
        yoyoAccountId: issued.yoyoAccountId,
        cardId: issued.cardId,
      },
    });
  }
  return yoyoInstrument;
}

export async function topupYoyoGift(accountId: string, yoyoAccountId: string, amountCents: number, journalEntryId: string) {
  const yoyoClient = new YoyoClient();
  await yoyoClient.topupGift(yoyoAccountId, amountCents, journalEntryId);
}





