import { getPrisma } from './db';
import { YoyoClient } from '@wapay/providers-yoyo';

export async function ensureYoyoInstrument(accountId: string): Promise<{ cardId: string }>{
  const prisma = getPrisma();
  const existing = await prisma.yoyoInstrument.findUnique({ where: { accountId } });
  if (existing) return { cardId: existing.cardId };

  const yoyo = new YoyoClient();
  const issued = await yoyo.issueGift(accountId, 0);
  const created = await prisma.yoyoInstrument.create({
    data: {
      accountId,
      yoyoAccountId: issued.yoyoAccountId,
      cardId: issued.cardId,
    },
  });
  return { cardId: created.cardId };
}

export async function topupYoyoGift(accountId: string, amountCents: number, idemKey: string): Promise<{ providerRef: string }>{
  const { cardId } = await ensureYoyoInstrument(accountId);
  const yoyo = new YoyoClient();
  return yoyo.topupGift(cardId, amountCents, idemKey);
}





