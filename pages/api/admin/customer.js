/**
 * Customer profile lookup — the CRM view behind the admin console.
 *
 * GET ?q=<number> → identity, KYC status, balances, recent ledger activity,
 * vouchers (sent + received), payment requests, deposits.
 *
 * SECURITY INVARIANTS:
 * - Session-cookie or internal-key gated; fails closed.
 * - voucherPin is a BEARER SECRET and is NEVER selected here — an admin
 *   console must not be able to read customers' voucher PINs (the PIN-resend
 *   flow in chat is wallet-PIN-gated for the owner alone).
 * - Read-only: this route must never write anything.
 */

import prisma from '../../../lib/prisma.js';
import { requireAdmin } from '../../../lib/admin-auth.js';

export const config = { maxDuration: 25 };

function tail9(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });

  const t = tail9(req.query.q);
  if (!t) return res.status(400).json({ error: 'Give me a phone number (at least 9 digits).' });

  const candidates = await prisma.account.findMany({
    where: { OR: [{ msisdn: { endsWith: t } }, { waId: { endsWith: t } }] },
    take: 3,
  });
  const account = candidates.find((a) => tail9(a.msisdn) === t || tail9(a.waId) === t);
  if (!account) return res.status(404).json({ error: 'No account with that number.' });

  const walletCode = `WALLET:${account.id}:SPEND`;

  const [wallets, holds, journal, sentGifts, receivedGifts, requests, deposits] =
    await Promise.all([
      prisma.wallet.findMany({
        where: { accountId: account.id },
        select: { balanceType: true, availableCents: true, pendingCents: true, updatedAt: true },
      }),
      prisma.hold.findMany({
        where: { wallet: { accountId: account.id }, status: 'ACTIVE' },
        select: { amountCents: true, reason: true, createdAt: true },
      }),
      prisma.journalLine.findMany({
        where: { accountCode: walletCode },
        select: {
          debitCents: true,
          creditCents: true,
          entry: { select: { source: true, createdAt: true, externalRef: true } },
        },
        orderBy: { id: 'desc' },
        take: 40,
      }),
      prisma.pendingGift.findMany({
        where: { senderAccountId: account.id },
        // voucherPin DELIBERATELY not selected — bearer secret.
        select: {
          amountCents: true, rail: true, recipientMsisdn: true, status: true,
          voucherSerial: true, createdAt: true, deliveredAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
      prisma.pendingGift.findMany({
        where: { recipientMsisdn: { endsWith: t } },
        select: {
          amountCents: true, rail: true, status: true, voucherSerial: true,
          createdAt: true, deliveredAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
      prisma.paymentRequest.findMany({
        where: { accountId: account.id },
        select: {
          id: true, amountCents: true, status: true, payerRef: true,
          createdAt: true, paidAt: true, expiresAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
      prisma.providerRequest.findMany({
        where: { accountId: account.id, provider: 'PAYFAST' },
        select: { status: true, providerRef: true, requestTs: true, metadata: true },
        orderBy: { requestTs: 'desc' },
        take: 15,
      }),
    ]);

  const profile = account.profile && typeof account.profile === 'object' ? account.profile : {};

  return res.status(200).json({
    account: {
      id: account.id,
      waId: account.waId,
      msisdn: account.msisdn,
      displayName: account.displayName,
      status: account.status,
      onboardingState: account.onboardingState,
      conversationState: account.conversationState,
      createdAt: account.createdAt,
      language: profile.language || 'en',
      depositMethod: profile.depositMethod || null,
      interests: profile.interests || [],
    },
    kyc: {
      status: profile.kyc?.status || 'NOT_VERIFIED',
      provider: profile.kyc?.provider || 'didit (planned)',
      verifiedAt: profile.kyc?.verifiedAt || null,
    },
    wallets,
    activeHolds: holds,
    journal: journal.map((l) => ({
      when: l.entry.createdAt,
      source: l.entry.source,
      ref: l.entry.externalRef,
      creditCents: l.creditCents || 0,
      debitCents: l.debitCents || 0,
    })),
    vouchers: { sent: sentGifts, received: receivedGifts },
    requests,
    deposits: deposits.map((d) => ({
      status: d.status,
      providerRef: d.providerRef,
      when: d.requestTs,
      amountCents: d.metadata?.amountCents ?? d.metadata?.grossCents ?? null,
    })),
  });
}
