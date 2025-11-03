/**
 * POST /api/vas/airtime/preview
 * 
 * Preview an airtime purchase before execution.
 * Shows customer what they're about to buy.
 */

import { PrismaClient } from '@prisma/client';
import { BluVasClient } from '@wapay/providers-blu';

const prisma = new PrismaClient();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  try {
    const { accountId, msisdn, amountCents, vendorId } = req.body;

    // Validate required fields
    if (!accountId || !msisdn || !amountCents) {
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Missing required fields: accountId, msisdn, amountCents'
      });
    }

    // Validate amount (min R5, max R1000)
    if (amountCents < 500 || amountCents > 100000) {
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Amount must be between R5 and R1000'
      });
    }

    // Get account and wallet
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      include: { wallet: true }
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

    // Check balance
    const availableBalance = account.wallet.availableCents;
    if (availableBalance < amountCents) {
      return res.status(400).json({
        error: 'USER_INPUT',
        message: `Insufficient balance. Available: R${(availableBalance / 100).toFixed(2)}`
      });
    }

    // Auto-detect network if not provided
    let detectedVendorId = vendorId;
    let detectedVendorName = null;

    if (!vendorId) {
      try {
        const bluClient = new BluVasClient();
        const networkInfo = await bluClient.checkMobileNumber(msisdn);
        detectedVendorName = networkInfo.vendorName;
        detectedVendorId = bluClient.vendorNameToId(networkInfo.vendorName);
      } catch (error) {
        console.error('Network detection failed:', error);
        // Continue without network detection
      }
    }

    // Create preview
    const previewId = `preview-air-${Date.now()}-${accountId}`;
    const feeCents = 0; // No fee for now
    const totalCents = amountCents + feeCents;

    // Store preview in database (expires in 5 minutes)
    await prisma.providerRequest.create({
      data: {
        id: previewId,
        idemKey: previewId,
        route: 'airtime-preview',
        status: 'PENDING',
        accountId: accountId,
        metadata: {
          msisdn,
          amountCents,
          vendorId: detectedVendorId,
          vendorName: detectedVendorName,
          feeCents,
          totalCents,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
        }
      }
    });

    // Return preview
    return res.status(200).json({
      ok: true,
      previewId,
      preview: {
        type: 'airtime',
        msisdn,
        amountCents,
        vendorId: detectedVendorId,
        vendorName: detectedVendorName || (detectedVendorId ? detectedVendorId.toUpperCase() : 'Unknown'),
        feeCents,
        totalCents,
        availableBalance: availableBalance,
        newBalance: availableBalance - totalCents,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
      }
    });

  } catch (error) {
    console.error('Airtime preview error:', error);
    return res.status(500).json({
      error: 'RETRYABLE',
      message: 'An error occurred while creating preview'
    });
  }
}

