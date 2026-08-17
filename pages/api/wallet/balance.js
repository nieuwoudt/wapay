/**
 * GET /api/wallet/balance
 *
 * Get customer's WaPay balance (single balance view).
 *
 * Invariants:
 * - Customer sees ONE balance: the SPEND wallet's availableCents.
 *   A customer holds one wallet PER balance type (unique (accountId, balanceType)),
 *   so the SPEND wallet must be selected explicitly — Account.wallets is plural.
 * - Money is integer cents everywhere; rand formatting is display-only.
 * - A DB failure is 503 BALANCE_UNAVAILABLE. It must never surface as a
 *   200 with a zero/placeholder balance: callers would show "R0.00" during
 *   an outage and customers would think their money is gone.
 */

import prisma from '../../../lib/prisma.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  // Next.js may parse repeated query params as arrays; only a single string is valid input.
  const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined;

  if (!accountId) {
    return res.status(400).json({
      error: 'USER_INPUT',
      message: 'Missing required field: accountId'
    });
  }

  let account;
  let wallet;
  try {
    account = await prisma.account.findUnique({
      where: { id: accountId }
    });

    if (account) {
      // SPEND is the customer-visible balance; CASH (KYC, withdrawable) is separate.
      wallet = await prisma.wallet.findFirst({
        where: { accountId: account.id, balanceType: 'SPEND' }
      });
    }
  } catch (error) {
    // DB unreachable/failed: the balance is unknown, not zero.
    console.error('Balance check error:', error);
    return res.status(503).json({
      error: 'BALANCE_UNAVAILABLE',
      message: 'Balance is temporarily unavailable'
    });
  }

  // null from a successful query means the record genuinely does not exist.
  if (!account) {
    return res.status(404).json({
      error: 'USER_INPUT',
      message: 'Account not found'
    });
  }

  if (!wallet) {
    return res.status(404).json({
      error: 'USER_INPUT',
      message: 'Wallet not found'
    });
  }

  const totalBalance = wallet.availableCents;

  const response = {
    ok: true,
    balance: {
      totalCents: totalBalance,
      displayAmount: `R${(totalBalance / 100).toFixed(2)}`,
      currency: 'ZAR'
    },
    // Internal tracking (not shown to customer)
    _internal: {
      walletCents: totalBalance
    }
  };

  // If waId is provided, describe the WhatsApp template for the caller to send;
  // this endpoint never sends messages itself (exactly-once delivery lives in the orchestrator).
  const { waId, sendTemplate } = req.query;
  if (waId && sendTemplate === 'true') {
    response._template = {
      name: 'balance_summary',
      waId: waId,
      parameters: [
        account.displayName || 'Customer',
        (totalBalance / 100).toFixed(2)
      ]
    };
  }

  return res.status(200).json(response);
}
