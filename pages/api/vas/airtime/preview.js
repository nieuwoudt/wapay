/**
 * POST /api/vas/airtime/preview
 * 
 * Preview an airtime purchase before execution.
 * Shows customer what they're about to buy.
 * Includes structured logging for debugging.
 */

import { PrismaClient } from '@prisma/client';
import { BluVasClient } from '@wapay/providers-blu';

const prisma = new PrismaClient();

/**
 * Structured logging helper
 */
function logStructured(type, data) {
  console.log(JSON.stringify({
    type,
    ...data,
    timestamp: new Date().toISOString(),
  }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  const { accountId, msisdn, amountCents, vendorId } = req.body;

  // Log the preview call
  logStructured('vas_airtime_preview_call', {
    accountId,
    msisdn,
    amountCents,
    vendorId,
  });

  try {
    // Validate required fields
    if (!accountId || !msisdn || !amountCents) {
      logStructured('vas_airtime_preview_result', {
        accountId,
        success: false,
        error: 'MISSING_FIELDS',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Missing required fields: accountId, msisdn, amountCents'
      });
    }

    // Validate amount (min R5, max R1000)
    if (amountCents < 500 || amountCents > 100000) {
      logStructured('vas_airtime_preview_result', {
        accountId,
        amountCents,
        success: false,
        error: 'INVALID_AMOUNT',
      });
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
      logStructured('vas_airtime_preview_result', {
        accountId,
        success: false,
        error: 'ACCOUNT_NOT_FOUND',
      });
      return res.status(404).json({
        error: 'USER_INPUT',
        message: 'Account not found'
      });
    }

    if (!account.wallet) {
      logStructured('vas_airtime_preview_result', {
        accountId,
        success: false,
        error: 'WALLET_NOT_FOUND',
      });
      return res.status(404).json({
        error: 'USER_INPUT',
        message: 'Wallet not found'
      });
    }

    // Check balance
    const availableBalance = account.wallet.availableCents;
    if (availableBalance < amountCents) {
      logStructured('vas_airtime_preview_result', {
        accountId,
        amountCents,
        availableBalance,
        success: false,
        error: 'INSUFFICIENT_BALANCE',
      });
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
        
        logStructured('vas_airtime_network_detected', {
          msisdn,
          vendorId: detectedVendorId,
          vendorName: detectedVendorName,
        });
      } catch (error) {
        console.error('Network detection failed:', error);
        logStructured('vas_airtime_network_detection_failed', {
          msisdn,
          error: error.message,
          reason: error.reason,
        });
        
        // Handle INVALID_PHONE_NUMBER specifically
        if (error.message === 'INVALID_PHONE_NUMBER') {
          logStructured('vas_airtime_preview_result', {
            accountId,
            msisdn,
            success: false,
            error: 'INVALID_PHONE_NUMBER',
          });
          return res.status(400).json({
            error: 'INVALID_PHONE_NUMBER',
            message: error.userMessage || "Sorry, I couldn't process that phone number. Please check the number and try again."
          });
        }
        // Continue without network detection for other errors
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

    // Log success
    logStructured('vas_airtime_preview_result', {
      accountId,
      previewId,
      msisdn,
      amountCents,
      vendorId: detectedVendorId,
      totalCents,
      success: true,
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
    logStructured('vas_airtime_preview_result', {
      accountId,
      msisdn,
      success: false,
      error: 'UNHANDLED_ERROR',
      errorMessage: error.message,
    });
    return res.status(500).json({
      error: 'RETRYABLE',
      message: 'An error occurred while creating preview'
    });
  }
}
