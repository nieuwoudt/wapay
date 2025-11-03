/**
 * GET /api/wallet/balance
 * 
 * Get customer's WaPay balance (single balance view).
 * 
 * Note: Customer sees ONE balance, regardless of internal accounting.
 * We sum wallet.availableCents + any other internal balances.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  try {
    const { accountId } = req.query;

    // Validate required fields
    if (!accountId) {
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Missing required field: accountId'
      });
    }

    // Get account and wallet
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      include: { 
        wallet: true,
        yoyo: true // Include Yoyo for internal tracking (not shown to customer)
      }
    });

    if (!account) {
      return res.status(404).json({
        error: 'USER_INPUT',
        message: 'Account not found'
      });
    }

    if (!account.wallet) {
      return res.status(404).json({
        error: 'USER_INPUT',
        message: 'Wallet not found'
      });
    }

    // Calculate total WaPay balance
    // Customer sees ONE balance (sum of all internal balances)
    const walletBalance = account.wallet.availableCents;
    
    // Note: Yoyo gift balance is for internal accounting only
    // Customer doesn't see "wallet" vs "gift" - just "WaPay Balance"
    // For now, we only show wallet balance (gift is internal)
    const totalBalance = walletBalance;

    // Return single balance
    const response = {
      ok: true,
      balance: {
        totalCents: totalBalance,
        displayAmount: `R${(totalBalance / 100).toFixed(2)}`,
        currency: 'ZAR'
      },
      // Internal tracking (not shown to customer)
      _internal: {
        walletCents: walletBalance,
        yoyoAccountId: account.yoyo?.yoyoAccountId,
        hasYoyoGift: !!account.yoyo
      }
    };

    // If waId is provided, send WhatsApp template
    const { waId, sendTemplate } = req.query;
    if (waId && sendTemplate === 'true') {
      // Template will be sent by WhatsApp handler
      // This endpoint just returns the data
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

  } catch (error) {
    console.error('Balance check error:', error);
    return res.status(200).json({
      error: 'RETRYABLE',
      message: 'An error occurred while checking balance'
    });
  }
}

