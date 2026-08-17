/**
 * POST /api/vas/data/execute
 *
 * Execute a data bundle purchase after preview confirmation.
 * Requires PIN verification and valid preview.
 *
 * Production-Ready Features:
 * - PIN verification with lockout protection
 * - Atomic ledger: reserveHold -> provider -> settleHold/releaseHold
 * - WhatsApp receipt after successful purchase
 * - Sentry error tracking and metrics
 * - Idempotency protection (deterministic keys — safe to retry)
 * - Structured logging for debugging
 */

import prisma from '../../../../lib/prisma.js';
import { BluVasClient } from '@wapay/providers-blu';
import { verifyPIN } from '@wapay/auth';
import { BALANCE, RAIL, buildSpend } from '../../../../lib/ledger-core.js';
import { reserveHold, settleHold, releaseHold, ensureWallet } from '../../../../lib/ledger-post.js';
// IMPORTANT: This API route must NEVER send WhatsApp messages directly.
// User-facing messages are orchestrated by `message-processor-v2` to guarantee exactly-once delivery.

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
  console.error('❌ VAS Data Error:', error.message, context);

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

// NOTE: receipts and errors are handled by the WhatsApp orchestrator (message-processor).

export default async function handler(req, res) {
  const startTime = Date.now();

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  const { previewId, pin, accountId } = req.body;

  // Log the execute call
  logStructured('vas_data_execute_call', {
    previewId,
    accountId,
    hasPin: !!pin,
  });

  try {
    // Validate required fields
    if (!previewId || !accountId) {
      logStructured('vas_data_execute_result', {
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
      logStructured('vas_data_execute_result', {
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
      logStructured('vas_data_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'PIN_FAILED',
        pinError: pinResult.error,
      });
      logMetric('vas.data.pin_failure', 1, { error: pinResult.error });

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
      logStructured('vas_data_execute_result', {
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
      logStructured('vas_data_execute_result', {
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
      logStructured('vas_data_execute_result', {
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
    // Get Account (the SPEND wallet is ensured below, not required to pre-exist)
    // =========================================================================
    const account = await prisma.account.findUnique({ where: { id: accountId } });

    if (!account) {
      logStructured('vas_data_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'ACCOUNT_NOT_FOUND',
      });
      return res.status(404).json({
        error: 'USER_INPUT',
        message: 'Account not found'
      });
    }

    const { totalCents, msisdn, productId, productName, vendorId, priceCents } = metadata;

    // Spend flows always draw the no-KYC SPEND balance.
    await ensureWallet({ accountId, balanceType: BALANCE.SPEND });

    // =========================================================================
    // Reserve funds BEFORE calling Blu (atomic hold)
    // =========================================================================
    // Deterministic key per execution attempt, so a retry reuses the same hold
    // and the same journal entry instead of double-charging.
    const idemKey = `wapay-data-exec-${previewId}`;

    // reserveHold does the balance check and the debit-to-pending in one atomic
    // step. If the funds aren't there (or a concurrent spend took them first) it
    // throws INSUFFICIENT_FUNDS and no money moves.
    try {
      await reserveHold({
        accountId,
        amountCents: totalCents,
        idemKey,
        balanceType: BALANCE.SPEND,
        reason: `data ${msisdn}`,
      });
    } catch (error) {
      if (error.code === 'INSUFFICIENT_FUNDS') {
        logStructured('vas_data_execute_result', {
          previewId, accountId, success: false, error: 'INSUFFICIENT_BALANCE',
          required: totalCents, available: error.availableCents,
        });
        return res.status(400).json({ error: 'USER_INPUT', message: 'Insufficient balance' });
      }
      throw error;
    }

    logStructured('vas_data_hold_reserved', { idemKey, amountCents: totalCents });

    // =========================================================================
    // Call Blu VAS API
    // =========================================================================
    const bluClient = new BluVasClient();
    let bluResult;

    try {
      const bluStartTime = Date.now();

      bluResult = await bluClient.purchaseDataBundle({
        msisdn,
        productId,
        vendorId,
        idemKey,
        accountId,
      });

      // Log success metrics
      const bluLatency = Date.now() - bluStartTime;
      logMetric('vas.data.blu_latency_ms', bluLatency, { vendorId, success: true });
      logMetric('vas.data.success', 1, { vendorId, productId });

    } catch (error) {
      // Log failure metrics
      logMetric('vas.data.failure', 1, {
        vendorId,
        productId,
        errorType: error.message,
        statusCode: error.statusCode,
      });
      captureError(error, { accountId, previewId, vendorId, productId, idemKey });
      console.error('Blu data purchase failed:', error);

      // Provider failed: give the money back and record nothing on the books.
      await releaseHold({ idemKey, reason: `blu_failed:${error.message}` });
      await prisma.providerRequest.update({ where: { id: previewId }, data: { status: 'FAILED' } });

      // Handle INVALID_PHONE_NUMBER error specifically
      if (error.message === 'INVALID_PHONE_NUMBER') {
        logStructured('vas_data_execute_result', {
          previewId, accountId, msisdn, success: false,
          error: 'INVALID_PHONE_NUMBER', providerMessage: error.providerMessage,
        });
        return res.status(400).json({
          error: 'INVALID_PHONE_NUMBER',
          message: error.userMessage || "Sorry, I couldn't process that data purchase. The network is rejecting this phone number.",
          reference: idemKey
        });
      }

      // Log generic failure
      logStructured('vas_data_execute_result', {
        previewId, accountId, msisdn, success: false, error: error.message, reason: error.reason,
      });

      // Determine error type for user
      const userError = error.message === 'AUTH'
        ? 'Service temporarily unavailable'
        : error.reason || 'Data purchase failed';

      return res.status(400).json({
        error: error.message || 'RETRYABLE',
        message: userError,
        reference: idemKey
      });
    }

    // =========================================================================
    // Provider succeeded: settle the hold and post the real double-entry.
    // =========================================================================
    // buildSpend books: Dr WALLET:{acct}:SPEND, Cr CLEARING:BLU (supplier cost),
    // Cr REVENUE:COMMISSION:DATA (our margin). settleHold clears the hold and
    // posts the entry in one transaction, so the customer is debited exactly once.
    const spendEntry = buildSpend({
      accountId,
      category: 'DATA',
      saleCents: totalCents,
      idemKey: `wapay-data-spend-${previewId}`,
      rail: RAIL.BLU,
      balanceType: BALANCE.SPEND,
    });
    await settleHold({ idemKey, entry: spendEntry });

    await prisma.providerRequest.update({
      where: { id: previewId },
      data: { status: 'SUCCESS', providerRef: bluResult.providerRef },
    });

    const updatedWallet = await prisma.wallet.findFirst({
      where: { accountId, balanceType: BALANCE.SPEND },
    });

    // Log success
    logStructured('vas_data_execute_result', {
      previewId,
      accountId,
      msisdn,
      vendorId,
      productId,
      priceCents,
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
    logMetric('vas.data.total_latency_ms', totalLatency, { vendorId });

    // =========================================================================
    // Return Success Response
    // =========================================================================
    return res.status(200).json({
      ok: true,
      reference: bluResult.providerRef,
      transaction: {
        type: 'data',
        msisdn,
        productId,
        productName: bluResult.productName,
        vendorName: bluResult.vendorName,
        priceCents,
        feeCents: 0,
        totalCents,
        providerRef: bluResult.providerRef,
        dateTime: bluResult.dateTime,
        newBalance: updatedWallet.availableCents
      }
    });

  } catch (error) {
    captureError(error, {
      handler: 'vas/data/execute',
      body: { ...req.body, pin: '[REDACTED]' },
    });

    logStructured('vas_data_execute_result', {
      previewId,
      accountId,
      success: false,
      error: 'UNHANDLED_ERROR',
      errorMessage: error.message,
    });

    logMetric('vas.data.unhandled_error', 1);

    console.error('Data execute error:', error);
    return res.status(500).json({
      error: 'RETRYABLE',
      message: 'An error occurred while executing purchase'
    });
  }
}
