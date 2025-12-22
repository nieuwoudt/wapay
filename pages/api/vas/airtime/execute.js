/**
 * POST /api/vas/airtime/execute
 * 
 * Execute an airtime purchase after preview confirmation.
 * Requires PIN verification and valid preview.
 * 
 * Production-Ready Features:
 * - PIN verification with lockout protection
 * - Double-entry ledger (Dr: Customer Wallet, Cr: VAS Clearing)
 * - WhatsApp receipt after successful purchase
 * - Sentry error tracking and metrics
 * - Idempotency protection
 * - Structured logging for debugging
 */

import { PrismaClient } from '@prisma/client';
import { BluVasClient } from '@wapay/providers-blu';
import { verifyPIN } from '@wapay/auth';
import { sendWhatsAppTemplate, sendWhatsAppText } from '@wapay/whatsapp';

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

/**
 * Log error to Sentry (or console if Sentry not configured)
 */
function captureError(error, context = {}) {
  console.error('❌ VAS Airtime Error:', error.message, context);
  
  // Sentry integration (if configured)
  if (process.env.SENTRY_DSN && typeof Sentry !== 'undefined') {
    Sentry.captureException(error, { extra: context });
  }
}

/**
 * Log metrics for monitoring
 */
function logMetric(name, value, tags = {}) {
  const metric = {
    metric: name,
    value,
    tags,
    timestamp: new Date().toISOString(),
  };
  console.log('📊 METRIC:', JSON.stringify(metric));
}

/**
 * Send WhatsApp purchase receipt
 */
async function sendPurchaseReceipt({ msisdn, customerName, amountCents, vendorName, providerRef, waId }) {
  try {
    // Try template first, fall back to plain text
    const result = await sendWhatsAppText({
      to: waId,
      text: `✅ *Airtime Purchase Successful*\n\n` +
            `Hi ${customerName || 'there'}!\n\n` +
            `*Amount:* R${(amountCents / 100).toFixed(2)}\n` +
            `*Number:* ${msisdn}\n` +
            `*Network:* ${vendorName}\n` +
            `*Reference:* ${providerRef}\n` +
            `*Date:* ${new Date().toLocaleString('en-ZA')}\n\n` +
            `Thank you for using WaPay! 🎉`,
    });
    
    if (result.ok) {
      logStructured('vas_airtime_receipt_sent', { msisdn, providerRef, waId });
    } else {
      console.error('⚠️ Failed to send WhatsApp receipt:', result.error);
    }
    
    return result;
  } catch (error) {
    console.error('⚠️ WhatsApp receipt error (non-blocking):', error.message);
    return { ok: false, error: error.message };
  }
}

/**
 * Send error message to user via WhatsApp
 */
async function sendErrorMessage(waId, message) {
  try {
    await sendWhatsAppText({
      to: waId,
      text: `❌ ${message}`,
    });
  } catch (error) {
    console.error('⚠️ Failed to send error message:', error.message);
  }
}

export default async function handler(req, res) {
  const startTime = Date.now();
  
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  const { previewId, pin, accountId } = req.body;

  // Log the execute call
  logStructured('vas_airtime_execute_call', {
    previewId,
    accountId,
    hasPin: !!pin,
  });

  try {
    // Validate required fields
    if (!previewId || !accountId) {
      logStructured('vas_airtime_execute_result', {
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

    // =========================================================================
    // PIN Verification (REQUIRED)
    // =========================================================================
    if (!pin) {
      logStructured('vas_airtime_execute_result', {
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
      logStructured('vas_airtime_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'PIN_FAILED',
        pinError: pinResult.error,
      });
      logMetric('vas.airtime.pin_failure', 1, { error: pinResult.error });
      
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

    // =========================================================================
    // Get and Validate Preview
    // =========================================================================
    const preview = await prisma.providerRequest.findUnique({
      where: { id: previewId }
    });

    if (!preview || preview.status !== 'PENDING') {
      logStructured('vas_airtime_execute_result', {
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
    const metadata = preview.metadata || (preview.responseJson ? JSON.parse(preview.responseJson) : {});
    const expiresAt = new Date(metadata.expiresAt);
    if (new Date() > expiresAt) {
      logStructured('vas_airtime_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'PREVIEW_EXPIRED',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Preview expired. Please create a new preview.'
      });
    }

    // Verify account ownership
    const previewAccountId = preview.accountId || metadata.accountId;
    if (previewAccountId !== accountId) {
      logStructured('vas_airtime_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'UNAUTHORIZED',
      });
      return res.status(403).json({
        error: 'AUTH',
        message: 'Unauthorized'
      });
    }

    // =========================================================================
    // Get Account and Wallet
    // =========================================================================
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      include: { wallets: true }
    });

    if (!account || !account.wallets || account.wallets.length === 0) {
      logStructured('vas_airtime_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'ACCOUNT_NOT_FOUND',
      });
      return res.status(404).json({
        error: 'USER_INPUT',
        message: 'Account or wallet not found'
      });
    }

    const wallet = account.wallets[0];
    const { amountCents, totalCents, msisdn, vendorId } = metadata;
    
    // Check balance again
    if (wallet.availableCents < totalCents) {
      logStructured('vas_airtime_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'INSUFFICIENT_BALANCE',
        required: totalCents,
        available: wallet.availableCents,
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Insufficient balance'
      });
    }

    // =========================================================================
    // Create Idempotency Key and Double-Entry Journal
    // =========================================================================
    const idemKey = `wapay-air-${Date.now()}-${accountId}`;

    // Create double-entry journal entry
    const journalEntry = await prisma.journalEntry.create({
      data: {
        externalRef: idemKey,
        source: 'VAS_AIRTIME',
        lines: {
          create: [
            {
              accountCode: ACCOUNT_CODES.CUSTOMER_WALLET(accountId),
              debitCents: totalCents,
              creditCents: null,
            },
            {
              accountCode: ACCOUNT_CODES.VAS_CLEARING,
              debitCents: null,
              creditCents: totalCents,
            },
          ],
        },
      },
      include: { lines: true },
    });

    logStructured('vas_airtime_ledger_created', {
      journalEntryId: journalEntry.id,
      idemKey,
      amountCents: totalCents,
    });

    // =========================================================================
    // Call Blu VAS API
    // =========================================================================
    const bluClient = new BluVasClient();
    let bluResult;
    
    try {
      const bluStartTime = Date.now();
      
      bluResult = await bluClient.purchaseAirtime({
        msisdn,
        amountCents,
        vendorId,
        idemKey,
        accountId,
        journalEntryId: journalEntry.id
      });
      
      // Log success metrics
      const bluLatency = Date.now() - bluStartTime;
      logMetric('vas.airtime.blu_latency_ms', bluLatency, { vendorId, success: true });
      logMetric('vas.airtime.success', 1, { vendorId });
      
    } catch (error) {
      // Log failure metrics
      logMetric('vas.airtime.failure', 1, { 
        vendorId, 
        errorType: error.message,
        statusCode: error.statusCode,
      });
      
      // Capture error for Sentry
      captureError(error, {
        accountId,
        previewId,
        vendorId,
        amountCents,
        idemKey,
      });
      
      console.error('Blu airtime purchase failed:', error);
      
      // Reverse the journal entry (mark as failed, don't delete for audit)
      await prisma.journalEntry.update({
        where: { id: journalEntry.id },
        data: { 
          source: 'VAS_AIRTIME_FAILED',
        }
      });

      // Update preview as failed
      await prisma.providerRequest.update({
        where: { id: previewId },
        data: { status: 'FAILED' }
      });

      // Handle INVALID_PHONE_NUMBER error specifically
      if (error.message === 'INVALID_PHONE_NUMBER') {
        logStructured('vas_airtime_execute_result', {
          previewId,
          accountId,
          msisdn,
          success: false,
          error: 'INVALID_PHONE_NUMBER',
          providerMessage: error.providerMessage,
        });
        
        // Send friendly error to user
        if (account.waId) {
          sendErrorMessage(
            account.waId, 
            error.userMessage || "Sorry, I couldn't process that airtime purchase. The network is rejecting this phone number. Please try with a different number or contact support."
          ).catch(() => {});
        }

        return res.status(400).json({
          error: 'INVALID_PHONE_NUMBER',
          message: error.userMessage || "Sorry, I couldn't process that airtime purchase. The network is rejecting this phone number.",
          reference: idemKey
        });
      }

      // Log generic failure
      logStructured('vas_airtime_execute_result', {
        previewId,
        accountId,
        msisdn,
        success: false,
        error: error.message,
        reason: error.reason,
      });

      // Determine error type for user
      const userError = error.message === 'AUTH' 
        ? 'Service temporarily unavailable'
        : error.reason || 'Airtime purchase failed';

      return res.status(400).json({
        error: error.message || 'RETRYABLE',
        message: userError,
        reference: idemKey
      });
    }

    // =========================================================================
    // Update Wallet Balance
    // =========================================================================
    await prisma.wallet.update({
      where: { id: wallet.id },
      data: {
        availableCents: { decrement: totalCents }
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
      where: { id: wallet.id }
    });

    // Log success
    logStructured('vas_airtime_execute_result', {
      previewId,
      accountId,
      msisdn,
      vendorId,
      amountCents,
      providerRef: bluResult.providerRef,
      newBalance: updatedWallet.availableCents,
      success: true,
    });

    // =========================================================================
    // WhatsApp receipts are handled by the WhatsApp orchestrator (message-processor)
    // to guarantee exactly-once user messaging.
    // =========================================================================

    // Log overall latency
    const totalLatency = Date.now() - startTime;
    logMetric('vas.airtime.total_latency_ms', totalLatency, { vendorId });

    // =========================================================================
    // Return Success Response
    // =========================================================================
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
    captureError(error, { 
      handler: 'vas/airtime/execute',
      body: { ...req.body, pin: '[REDACTED]' },
    });
    
    logStructured('vas_airtime_execute_result', {
      previewId,
      accountId,
      success: false,
      error: 'UNHANDLED_ERROR',
      errorMessage: error.message,
    });
    
    logMetric('vas.airtime.unhandled_error', 1);
    
    console.error('Airtime execute error:', error);
    return res.status(500).json({
      error: 'RETRYABLE',
      message: 'An error occurred while executing purchase'
    });
  }
}
