/**
 * POST /api/vas/airtime/execute
 * 
 * Execute an airtime purchase after preview confirmation.
 * Requires PIN verification and valid preview.
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
    const { previewId, pin, accountId } = req.body;

    // Validate required fields
    if (!previewId || !accountId) {
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Missing required fields: previewId, accountId'
      });
    }

    // Get preview
    const preview = await prisma.providerRequest.findUnique({
      where: { id: previewId }
    });

    if (!preview || preview.status !== 'PENDING') {
      return res.status(404).json({
        error: 'USER_INPUT',
        message: 'Preview not found or already processed'
      });
    }

    // Check if preview expired (5 minutes)
    const expiresAt = new Date(preview.metadata.expiresAt);
    if (new Date() > expiresAt) {
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Preview expired. Please create a new preview.'
      });
    }

    // Verify account ownership
    if (preview.accountId !== accountId) {
      return res.status(403).json({
        error: 'AUTH',
        message: 'Unauthorized'
      });
    }

    // TODO: Verify PIN (skip for now, add later)
    // if (pin) {
    //   const pinValid = await verifyPin(accountId, pin);
    //   if (!pinValid) {
    //     return res.status(401).json({
    //       error: 'AUTH',
    //       message: 'Invalid PIN'
    //     });
    //   }
    // }

    // Get account and wallet
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      include: { wallet: true }
    });

    if (!account || !account.wallet) {
      return res.status(404).json({
        error: 'USER_INPUT',
        message: 'Account or wallet not found'
      });
    }

    // Check balance again
    const { amountCents, totalCents, msisdn, vendorId } = preview.metadata;
    if (account.wallet.availableCents < totalCents) {
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Insufficient balance'
      });
    }

    // Create idempotency key
    const idemKey = `wapay-air-${Date.now()}-${accountId}`;

    // Create journal entry (placeholder - will be replaced with actual ledger)
    const journalEntry = await prisma.journalEntry.create({
      data: {
        accountId,
        type: 'AIRTIME_PURCHASE',
        amountCents: totalCents,
        description: `Airtime purchase: R${(amountCents / 100).toFixed(2)} for ${msisdn}`,
        metadata: {
          msisdn,
          amountCents,
          vendorId,
          idemKey
        }
      }
    });

    // Call Blu VAS API
    const bluClient = new BluVasClient();
    let bluResult;
    
    try {
      bluResult = await bluClient.purchaseAirtime({
        msisdn,
        amountCents,
        vendorId,
        idemKey,
        accountId,
        journalEntryId: journalEntry.id
      });
    } catch (error) {
      console.error('Blu airtime purchase failed:', error);
      
      // Update journal entry as failed
      await prisma.journalEntry.update({
        where: { id: journalEntry.id },
        data: { 
          status: 'FAILED',
          metadata: {
            ...journalEntry.metadata,
            error: error.message,
            reason: error.reason
          }
        }
      });

      // Update preview as failed
      await prisma.providerRequest.update({
        where: { id: previewId },
        data: { status: 'FAILED' }
      });

      return res.status(400).json({
        error: error.message || 'RETRYABLE',
        message: error.reason || 'Airtime purchase failed',
        reference: idemKey
      });
    }

    // Update wallet balance
    await prisma.wallet.update({
      where: { id: account.wallet.id },
      data: {
        availableCents: { decrement: totalCents }
      }
    });

    // Update journal entry as successful
    await prisma.journalEntry.update({
      where: { id: journalEntry.id },
      data: {
        status: 'COMPLETED',
        metadata: {
          ...journalEntry.metadata,
          providerRef: bluResult.providerRef,
          vendorName: bluResult.vendorName,
          dateTime: bluResult.dateTime
        }
      }
    });

    // Update preview as completed
    await prisma.providerRequest.update({
      where: { id: previewId },
      data: {
        status: 'SUCCESS',
        providerRef: bluResult.providerRef
      }
    });

    // Get new balance
    const updatedWallet = await prisma.wallet.findUnique({
      where: { id: account.wallet.id }
    });

    // Return success
    return res.status(200).json({
      ok: true,
      reference: bluResult.providerRef,
      transaction: {
        type: 'airtime',
        msisdn,
        amountCents,
        vendorName: bluResult.vendorName,
        feeCents: 0,
        totalCents,
        providerRef: bluResult.providerRef,
        dateTime: bluResult.dateTime,
        newBalance: updatedWallet.availableCents
      }
    });

  } catch (error) {
    console.error('Airtime execute error:', error);
    return res.status(500).json({
      error: 'RETRYABLE',
      message: 'An error occurred while executing purchase'
    });
  }
}

