/**
 * POST /api/vas/voucher/execute
 *
 * Execute a WaPay voucher gift after preview confirmation.
 * "Send R50 to 084…" — the sender buys a GOODS voucher (OTT-issued behind the
 * scenes) and WaPay delivers it to the recipient's phone number. This is a
 * voucher SALE, never a money transfer.
 *
 * Money safety:
 * - PIN verification with lockout protection (sender's wallet PIN)
 * - reserveHold BEFORE the OTT call, settleHold/releaseHold after — the
 *   customer is debited exactly once, or not at all
 * - Deterministic idempotency keys derived from previewId, so retries replay
 *   instead of double-charging
 * - GetVoucher timeout follows OTT's mandated recovery: CheckVoucher, then
 *   Confirm (success) or Reject (failure). NEVER blind-retry GetVoucher.
 *
 * SECRET HANDLING: the OTT voucher PIN is a bearer secret. It is handed to
 * createPendingGift for the claim flow and NOWHERE else — never logged (not
 * even masked), never stored on the ProviderRequest row, never returned in
 * the HTTP response. tests/vas-execute-ledger-pattern.test.mjs enforces this
 * statically.
 */

import prisma from '../../../../lib/prisma.js';
import { OttClient } from '@wapay/providers-ott';
import { verifyPIN } from '@wapay/auth';
import { BALANCE, RAIL, buildVoucherGift } from '../../../../lib/ledger-core.js';
import { reserveHold, settleHold, releaseHold, ensureWallet } from '../../../../lib/ledger-post.js';
import { createPendingGift } from '../../../../lib/pending-gifts.js';
import { requireInternalAuth } from '../../../../lib/internal-auth.js';
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
  console.error('❌ VAS Voucher Gift Error:', error.message, context);

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

  // Internal-only route: without this, any caller could burn PIN attempts and
  // read wallet balances.
  if (!requireInternalAuth(req, res)) return;

  const { previewId, pin, accountId } = req.body;

  logStructured('vas_voucher_execute_call', {
    previewId,
    accountId,
    hasPin: typeof pin === 'string' && pin.length > 0,
  });

  try {
    // Validate required fields
    if (!previewId || !accountId) {
      logStructured('vas_voucher_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'MISSING_FIELDS',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Missing required fields: previewId, accountId',
      });
    }

    // =========================================================================
    // PIN Verification (REQUIRED) — the sender's wallet PIN, not the voucher.
    // =========================================================================
    if (!pin) {
      logStructured('vas_voucher_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'MISSING_PIN',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'PIN is required for voucher gifts',
      });
    }

    const pinResult = await verifyPIN({ accountId, pin });

    if (!pinResult.ok) {
      logStructured('vas_voucher_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'PIN_FAILED',
        pinError: pinResult.error,
      });
      logMetric('vas.voucher_gift.pin_failure', 1, { error: pinResult.error });

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
      where: { id: previewId },
    });

    if (!preview || preview.status !== 'PENDING') {
      logStructured('vas_voucher_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'PREVIEW_NOT_FOUND',
      });
      return res.status(404).json({
        error: 'USER_INPUT',
        message: 'Preview not found or already processed',
      });
    }

    // Check if preview expired (5 minutes)
    const metadata = preview.metadata || (preview.responseJson ? JSON.parse(preview.responseJson) : {});
    const expiresAt = new Date(metadata.expiresAt);
    if (new Date() > expiresAt) {
      logStructured('vas_voucher_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'PREVIEW_EXPIRED',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Preview expired. Please create a new preview.',
      });
    }

    // Verify account ownership
    const previewAccountId = preview.accountId || metadata.accountId;
    if (previewAccountId !== accountId) {
      logStructured('vas_voucher_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'UNAUTHORIZED',
      });
      return res.status(403).json({
        error: 'AUTH',
        message: 'Unauthorized',
      });
    }

    // =========================================================================
    // Get Account (the SPEND wallet is ensured below, not required to pre-exist)
    // =========================================================================
    const account = await prisma.account.findUnique({ where: { id: accountId } });

    if (!account) {
      logStructured('vas_voucher_execute_result', {
        previewId,
        accountId,
        success: false,
        error: 'ACCOUNT_NOT_FOUND',
      });
      return res.status(404).json({
        error: 'USER_INPUT',
        message: 'Account not found',
      });
    }

    const { amountCents, feeCents, totalCents, recipientMsisdn } = metadata;

    // Gift flows always draw the no-KYC SPEND balance.
    await ensureWallet({ accountId, balanceType: BALANCE.SPEND });

    // =========================================================================
    // Reserve funds BEFORE calling OTT (atomic hold)
    // =========================================================================
    // Deterministic key per execution attempt, so a retry reuses the same hold
    // and the same journal entry instead of double-charging.
    const idemKey = `wapay-vgift-exec-${previewId}`;

    try {
      await reserveHold({
        accountId,
        amountCents: totalCents,
        idemKey,
        balanceType: BALANCE.SPEND,
        reason: `voucher gift ${recipientMsisdn}`,
      });
    } catch (error) {
      if (error.code === 'INSUFFICIENT_FUNDS') {
        logStructured('vas_voucher_execute_result', {
          previewId, accountId, success: false, error: 'INSUFFICIENT_BALANCE',
          required: totalCents, available: error.availableCents,
        });
        return res.status(400).json({ error: 'USER_INPUT', message: 'Insufficient balance' });
      }
      throw error;
    }

    logStructured('vas_voucher_hold_reserved', { idemKey, amountCents: totalCents });

    // =========================================================================
    // Call OTT GetVoucher
    // =========================================================================
    // uniqueReference is OTT's idempotency handle (varchar 50): deterministic
    // from the previewId so a WaPay retry maps to the same OTT sale, and the
    // key OTT support needs for any reconciliation.
    const ottClient = new OttClient();
    const uniqueReference = `wapay-vg-${previewId}`.slice(0, 50);
    let voucher;

    try {
      const ottStartTime = Date.now();

      voucher = await ottClient.getVoucher({
        branch: 'WAPAY',
        cashier: 'WHATSAPP',
        uniqueReference,
        valueCents: amountCents,
        vendorCode: Number(process.env.OTT_VENDOR_CODE || 11),
        mobileForSMS: recipientMsisdn,
      });

      const ottLatency = Date.now() - ottStartTime;
      logMetric('vas.voucher_gift.ott_latency_ms', ottLatency, { success: true });
    } catch (error) {
      if (error.message === 'TIMEOUT_CHECK_REQUIRED') {
        // OTT mandates: never blind-retry GetVoucher after a timeout — the
        // voucher may already be issued and debited. Probe with CheckVoucher.
        logStructured('vas_voucher_timeout_check_required', {
          previewId, accountId, uniqueReference,
        });
        try {
          voucher = await ottClient.checkVoucher(uniqueReference);
          logStructured('vas_voucher_timeout_recovered', {
            previewId, accountId, uniqueReference, voucherId: voucher.voucherId,
          });
          logMetric('vas.voucher_gift.timeout_recovered', 1);
          // Fall through to the shared success path below.
        } catch (checkError) {
          // No voucher found (or unknowable): reject so any half-issued sale
          // is reversed on OTT's side, then give the money back.
          logStructured('vas_voucher_timeout_not_recovered', {
            previewId, accountId, uniqueReference, checkError: checkError.message,
          });
          logMetric('vas.voucher_gift.timeout_failed', 1);
          try {
            await ottClient.rejectVoucher(uniqueReference);
          } catch (rejectError) {
            logStructured('vas_voucher_reject_failed', {
              previewId, accountId, uniqueReference, rejectError: rejectError.message,
            });
          }
          await releaseHold({ idemKey, reason: `ott_timeout_unrecovered:${checkError.message}` });
          await prisma.providerRequest.update({ where: { id: previewId }, data: { status: 'FAILED' } });
          logStructured('vas_voucher_execute_result', {
            previewId, accountId, success: false, error: 'TIMEOUT_CHECK_REQUIRED',
          });
          return res.status(400).json({
            error: 'RETRYABLE',
            message: "The voucher service didn't respond in time. You have not been charged — please try again.",
            reference: uniqueReference,
          });
        }
      } else {
        // Provider failed outright: reject best-effort (reverses the sale if
        // anything was half-issued), give the money back, record the failure.
        logMetric('vas.voucher_gift.failure', 1, { errorType: error.message });
        captureError(error, { accountId, previewId, uniqueReference, amountCents, idemKey });
        console.error('OTT voucher issue failed:', error);

        try {
          await ottClient.rejectVoucher(uniqueReference);
        } catch (rejectError) {
          logStructured('vas_voucher_reject_failed', {
            previewId, accountId, uniqueReference, rejectError: rejectError.message,
          });
        }
        await releaseHold({ idemKey, reason: `ott_failed:${error.message}` });
        await prisma.providerRequest.update({ where: { id: previewId }, data: { status: 'FAILED' } });

        logStructured('vas_voucher_execute_result', {
          previewId, accountId, success: false, error: error.message, reason: error.reason,
        });
        const userError = error.message === 'AUTH'
          ? 'Service temporarily unavailable'
          : error.reason || 'Voucher purchase failed';
        return res.status(400).json({
          error: error.message === 'AUTH' || error.message === 'USER_INPUT' || error.message === 'RETRYABLE'
            ? error.message
            : 'RETRYABLE',
          message: userError,
          reference: uniqueReference,
        });
      }
    }

    // =========================================================================
    // Voucher issued: confirm receipt (best-effort), then settle the hold.
    // =========================================================================
    // Confirm failure is deliberately non-fatal: the voucher exists and the
    // customer must be charged for it; an unconfirmed sale is a reconciliation
    // item with OTT, not a reason to double-issue or refund.
    try {
      await ottClient.confirmVoucher(uniqueReference);
    } catch (confirmError) {
      logStructured('vas_voucher_confirm_failed', {
        previewId,
        accountId,
        uniqueReference,
        confirmError: confirmError.message,
      });
      logMetric('vas.voucher_gift.confirm_failed', 1);
    }

    // buildVoucherGift books: Dr WALLET:{acct}:SPEND (amount + fee), Cr
    // CLEARING:OTT (supplier cost), Cr fee revenue. settleHold clears the hold
    // and posts the entry in one transaction — the customer is debited exactly
    // once.
    // buildVoucherGift derives the fee from FEES.voucherGift itself; the
    // preview's feeCents is display-only and must match by construction.
    const giftEntry = buildVoucherGift({
      senderAccountId: accountId,
      amountCents,
      idemKey: `wapay-vgift-spend-${previewId}`,
      rail: RAIL.OTT,
      recipientMsisdn,
    });
    await settleHold({ idemKey, entry: giftEntry });

    // Store the gift for the claim flow. This is the ONLY sink for the
    // voucher PIN — it must never appear in logs, metrics, the ProviderRequest
    // row, or the HTTP response.
    await createPendingGift({
      senderAccountId: accountId,
      recipientMsisdn,
      amountCents,
      voucherPin: voucher.pin,
      voucherSerial: voucher.serialNumber != null ? String(voucher.serialNumber) : null,
      rail: RAIL.OTT,
      idemKey: `wapay-vgift-gift-${previewId}`,
    });

    await prisma.providerRequest.update({
      where: { id: previewId },
      data: { status: 'SUCCESS', providerRef: String(voucher.voucherId) },
    });

    const updatedWallet = await prisma.wallet.findFirst({
      where: { accountId, balanceType: BALANCE.SPEND },
    });

    // Log success — voucher identifiers only, NEVER the voucher secret.
    logStructured('vas_voucher_execute_result', {
      previewId,
      accountId,
      recipientMsisdn,
      amountCents,
      feeCents,
      totalCents,
      voucherId: voucher.voucherId,
      saleId: voucher.saleId,
      uniqueReference,
      newBalance: updatedWallet.availableCents,
      success: true,
    });
    logMetric('vas.voucher_gift.success', 1);

    // =========================================================================
    // WhatsApp receipts are handled by the WhatsApp orchestrator (message-processor)
    // to guarantee exactly-once user messaging.
    // =========================================================================

    const totalLatency = Date.now() - startTime;
    logMetric('vas.voucher_gift.total_latency_ms', totalLatency);

    // =========================================================================
    // Return Success Response — no voucher secret, ever.
    // =========================================================================
    return res.status(200).json({
      ok: true,
      reference: uniqueReference,
      amountCents,
      feeCents,
      recipientMsisdn,
      newBalance: updatedWallet.availableCents,
    });
  } catch (error) {
    captureError(error, {
      handler: 'vas/voucher/execute',
      body: { ...req.body, pin: '[REDACTED]' },
    });

    logStructured('vas_voucher_execute_result', {
      previewId,
      accountId,
      success: false,
      error: 'UNHANDLED_ERROR',
      errorMessage: error.message,
    });

    logMetric('vas.voucher_gift.unhandled_error', 1);

    console.error('Voucher execute error:', error);
    return res.status(500).json({
      error: 'RETRYABLE',
      message: 'An error occurred while executing purchase',
    });
  }
}
