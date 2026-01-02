/**
 * POST /api/vas/electricity/execute
 * 
 * Execute an electricity purchase after preview confirmation.
 * Requires PIN verification and valid preview.
 * 
 * Features:
 * - PIN verification with lockout protection
 * - Double-entry ledger
 * - Returns electricity token
 * - Structured logging
 */

import { PrismaClient } from '@prisma/client';
import { BluVasExtendedClient } from '@wapay/providers-blu';
import { verifyPIN } from '@wapay/auth';
import { isCategoryEnabledForWaId } from '../../../../lib/vas-config.js';

const prisma = new PrismaClient();

// Account codes for double-entry ledger
const ACCOUNT_CODES = {
  CUSTOMER_WALLET: (accountId) => `WALLET:${accountId}`,
  VAS_CLEARING: 'LIABILITY:VAS_CLEARING',
  VAS_REVENUE: 'REVENUE:VAS_FEES',
};

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
  const startTime = Date.now();
  
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  const { previewId, pin, accountId } = req.body;

  // Log the execute call
  logStructured('vas_electricity_execute_call', {
    previewId,
    accountId,
    hasPin: !!pin,
  });

  try {
    // Check if electricity is enabled (optionally allowlisted by waId)
    const accountForGate = await prisma.account.findUnique({
      where: { id: accountId },
      select: { waId: true },
    });
    const waId = accountForGate?.waId || null;
    if (!isCategoryEnabledForWaId('ELECTRICITY', waId)) {
      return res.status(400).json({
        ok: false,
        error: 'USER_INPUT',
        message: 'Electricity purchases are not available yet.'
      });
    }

    // Validate required fields
    if (!previewId || !accountId) {
      logStructured('vas_electricity_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'MISSING_FIELDS',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Missing required fields: previewId, accountId'
      });
    }

    // PIN Verification
    if (!pin) {
      logStructured('vas_electricity_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'MISSING_PIN',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'PIN is required for VAS purchases',
      });
    }

    const pinResult = await verifyPIN({ accountId, pin });
    
    if (!pinResult.ok) {
      logStructured('vas_electricity_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'PIN_FAILED',
        pinError: pinResult.error,
      });
      
      if (pinResult.error === 'HARD_LOCKOUT' || pinResult.error === 'SOFT_LOCKOUT') {
        return res.status(403).json({
          error: 'AUTH',
          message: 'Account is locked due to too many failed attempts',
          lockedUntil: pinResult.lockedUntil?.toISOString(),
        });
      }
      
      return res.status(401).json({
        error: 'AUTH',
        message: 'Invalid PIN',
      });
    }

    // Get and Validate Preview
    const preview = await prisma.providerRequest.findUnique({
      where: { id: previewId }
    });

    if (!preview || preview.status !== 'PENDING') {
      logStructured('vas_electricity_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'PREVIEW_NOT_FOUND',
      });
      return res.status(404).json({
        error: 'USER_INPUT',
        message: 'Preview not found or already processed'
      });
    }

    // Check if preview expired (5 minutes)
    const metadata = preview.metadata || {};
    const expiresAt = new Date(metadata.expiresAt);
    if (new Date() > expiresAt) {
      logStructured('vas_electricity_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'PREVIEW_EXPIRED',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Preview expired. Please start again.'
      });
    }

    // Verify account ownership
    if (metadata.accountId !== accountId) {
      return res.status(403).json({
        error: 'AUTH',
        message: 'Not authorized to execute this preview'
      });
    }

    // Extract purchase details from preview
    const { meterNumber, amountCents, serviceFee, totalCents, reference } = metadata;

    // Get wallet and verify balance again
    const wallet = await prisma.wallet.findFirst({
      where: { accountId }
    });

    if (!wallet || wallet.availableCents < totalCents) {
      logStructured('vas_electricity_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'INSUFFICIENT_BALANCE',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Insufficient balance'
      });
    }

    // Create idempotency key (stable per preview)
    const idemKey = `wapay-elec-exec-${previewId}`;

    // Create journal entry (debit customer, credit VAS clearing)
    const journalEntry = await prisma.journalEntry.create({
      data: {
        id: `je_elec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        debitAccountCode: ACCOUNT_CODES.CUSTOMER_WALLET(accountId),
        creditAccountCode: ACCOUNT_CODES.VAS_CLEARING,
        amountCents: totalCents,
        source: 'VAS_ELECTRICITY',
        referenceId: previewId,
        metadata: {
          meterNumber,
          amountCents,
          serviceFee,
          idemKey,
        },
      }
    });

    // Debit wallet
    await prisma.wallet.update({
      where: { id: wallet.id },
      data: {
        availableCents: { decrement: totalCents },
      }
    });

    // Call Blu to purchase electricity
    const bluClient = new BluVasExtendedClient();
    let bluResult;
    
    try {
      const bluStartTime = Date.now();
      
      // Check if stub mode is enabled
      if (process.env.BLU_VAS_STUB_MODE === 'true') {
        console.log('⚠️ BLU_VAS_STUB_MODE enabled - simulating electricity purchase');
        bluResult = {
          providerRef: `STUB-ELEC-${Date.now()}`,
          amountCents,
          token: `${Math.floor(Math.random() * 9000000000000000) + 1000000000000000}`, // 16-digit token
          tokenType: 'STS_1',
          units: Number((amountCents / 100 * 10).toFixed(2)), // ~10 units per Rand (estimate)
          meterNumber,
          municipalityName: 'STUB Municipality',
        };
      } else {
        if (!reference) {
          const err = new Error('UPSTREAM_FAILURE');
          // JS-safe attachment of extra context (this file is .js, not .ts)
          err.reason = 'Missing electricity reference from preview';
          throw err;
        }
        bluResult = await bluClient.purchaseElectricity({
          reference,
          idemKey,
          accountId,
          journalEntryId: journalEntry.id,
        });
      }
      
      const bluLatency = Date.now() - bluStartTime;
      logStructured('vas_electricity_blu_success', {
        previewId,
        accountId,
        bluLatency,
        providerRef: bluResult.providerRef,
      });
      
    } catch (error) {
      console.error('Blu electricity purchase failed:', error);
      
      // Reverse the wallet debit
      await prisma.wallet.update({
        where: { id: wallet.id },
        data: {
          availableCents: { increment: totalCents },
        }
      });

      // Mark journal entry as failed
      await prisma.journalEntry.update({
        where: { id: journalEntry.id },
        data: { source: 'VAS_ELECTRICITY_FAILED' }
      });

      // Update preview as failed
      await prisma.providerRequest.update({
        where: { id: previewId },
        data: { status: 'FAILED' }
      });

      const reason = error?.reason || error?.message || 'Electricity purchase failed';
      const friendly =
        String(reason || '').toLowerCase().includes('invalid transaction type')
          ? 'Electricity is not enabled for this environment yet.'
          : (error?.userMessage || 'Failed to purchase electricity. Please try again.');

      logStructured('vas_electricity_execute_result', {
        previewId,
        accountId,
        success: false,
        error: error.message,
        reason,
      });

      return res.status(400).json({
        ok: false,
        error: error.message || 'UPSTREAM_FAILURE',
        message: friendly,
        reference: idemKey,
      });
    }

    // Update preview as completed
    await prisma.providerRequest.update({
      where: { id: previewId },
      data: {
        status: 'COMPLETED',
        responseJson: JSON.stringify(bluResult),
      }
    });

    // Get new balance
    const updatedWallet = await prisma.wallet.findFirst({
      where: { accountId }
    });

    const totalTime = Date.now() - startTime;
    
    logStructured('vas_electricity_execute_result', {
      previewId,
      accountId,
      meterNumber,
      amountCents,
      token: bluResult.token,
      providerRef: bluResult.providerRef,
      success: true,
      totalTime,
    });

    return res.status(200).json({
      ok: true,
      reference: bluResult.providerRef,
      transaction: {
        type: 'ELECTRICITY',
        meterNumber,
        amountCents,
        serviceFee,
        totalCents,
        token: bluResult.token,
        tokenType: bluResult.tokenType,
        units: bluResult.units,
        municipalityName: bluResult.municipalityName,
        newBalance: updatedWallet?.availableCents || 0,
        providerRef: bluResult.providerRef,
      }
    });

  } catch (error) {
    console.error('Electricity execute error:', error);
    logStructured('vas_electricity_execute_error', {
      previewId,
      accountId,
      error: error.message,
    });

    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'An error occurred. Please try again.'
    });
  }
}

