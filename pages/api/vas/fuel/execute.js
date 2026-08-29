/**
 * POST /api/vas/fuel/execute
 *
 * Execute a fuel wiCode purchase after preview confirmation ("buy R200
 * fuel" → confirm → wallet PIN → here). The wiCode is issued by UniFuel
 * (service-to-service) against Yoyo; WaPay owns the wallet debit and the
 * delivery (design: docs/UNIFUEL_INTEGRATION.md).
 *
 * Money safety (voucher-execute pattern + the cross-service indeterminacy
 * discipline of BUGLOG #28, hardened by the 2026-08-29 adversarial review):
 * - CONCURRENCY GATE: an atomic PENDING/RECONCILE → EXECUTING flip on the
 *   preview row means exactly one invocation owns a purchase at a time; a
 *   second PIN tap gets a friendly "already in progress", never a second
 *   provider call. A crashed owner's row is taken over after 120s.
 * - reserveHold BEFORE the UniFuel call; release ONLY on definitive
 *   failure. The moment the outcome is ISSUED the crash guard is DISARMED:
 *   a settle failure can never refund a customer whose wiCode exists —
 *   the row goes to RECONCILE and the idempotent settlement retries.
 * - UNKNOWN keeps the hold: one immediate reconcile via the order endpoint
 *   (UniFuel settles the truth against Yoyo's userRef and age-gates the
 *   not-found→failed verdict so an in-flight mint is never misread as
 *   failure); still unknown → RECONCILE + ops alert; the customer's next
 *   message retries via lib/fuel-settlement.js reconcileFuelPurchases.
 * - A FAILED verdict is trustworthy by construction: UniFuel inserts the
 *   order BEFORE calling Yoyo, so not_found means Yoyo was never asked.
 * - Deterministic idemKeys and issue reference derived from previewId.
 *
 * SECRET HANDLING: the wiCode is a bearer secret — its only sink is
 * createPendingGift (inside settleIssuedFuelPurchase). Never logged, never
 * stored on the ProviderRequest row, never in the HTTP response.
 */

import prisma from '../../../../lib/prisma.js';
import { verifyPIN } from '@wapay/auth';
import { BALANCE } from '../../../../lib/ledger-core.js';
import { reserveHold, releaseHold, ensureWallet } from '../../../../lib/ledger-post.js';
import { requireInternalAuth } from '../../../../lib/internal-auth.js';
import { issueWicode, orderStatus } from '../../../../lib/unifuel-client.js';
import {
  settleIssuedFuelPurchase,
  fuelReference,
} from '../../../../lib/fuel-settlement.js';
import { sendOpsAlert } from '../../../../lib/email.js';
// IMPORTANT: this route must NEVER send WhatsApp messages directly — the
// message processor orchestrates all customer messaging exactly-once.

function logStructured(type, data) {
  console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));
}

const TAKEOVER_MS = 120_000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }
  if (!requireInternalAuth(req, res)) return;

  const { previewId, pin, accountId } = req.body;
  let holdIdemKey = null;
  let owned = false; // we won the EXECUTING flip

  logStructured('vas_fuel_execute_call', {
    previewId,
    accountId,
    hasPin: typeof pin === 'string' && pin.length > 0,
  });

  try {
    if (!previewId || !accountId) {
      return res.status(400).json({ error: 'USER_INPUT', message: 'Missing required fields: previewId, accountId' });
    }
    if (!pin) {
      return res.status(400).json({ error: 'USER_INPUT', message: 'PIN is required for fuel purchases' });
    }

    const pinResult = await verifyPIN({ accountId, pin });
    if (!pinResult.ok) {
      logStructured('vas_fuel_execute_result', {
        previewId, accountId, success: false, error: 'PIN_FAILED', pinError: pinResult.error,
      });
      if (pinResult.error === 'HARD_LOCKOUT' || pinResult.error === 'SOFT_LOCKOUT') {
        return res.status(403).json({
          error: 'AUTH',
          message: 'Account is locked due to too many failed attempts',
          lockedUntil: pinResult.lockedUntil?.toISOString(),
        });
      }
      return res.status(401).json({ error: 'AUTH', message: 'Invalid PIN' });
    }

    const preview = await prisma.providerRequest.findUnique({ where: { id: previewId } });
    const metadata = preview?.metadata || {};
    const staleExecuting =
      preview?.status === 'EXECUTING' &&
      Date.now() - (Date.parse(metadata.executingAt || '') || 0) > TAKEOVER_MS;
    if (!preview || !(['PENDING', 'RECONCILE'].includes(preview.status) || staleExecuting)) {
      if (preview?.status === 'EXECUTING') {
        return res.status(409).json({
          error: 'IN_PROGRESS',
          message: 'That purchase is already being processed. One moment please.',
        });
      }
      return res.status(404).json({ error: 'USER_INPUT', message: 'Preview not found or already processed' });
    }
    if (preview.status === 'PENDING' && new Date() > new Date(metadata.expiresAt)) {
      return res.status(400).json({ error: 'USER_INPUT', message: 'Preview expired. Please start again.' });
    }
    if ((preview.accountId || metadata.accountId) !== accountId) {
      return res.status(403).json({ error: 'AUTH', message: 'Unauthorized' });
    }

    // The concurrency gate: exactly one invocation may own this purchase.
    const flipped = await prisma.providerRequest.updateMany({
      where: { id: previewId, status: preview.status },
      data: {
        status: 'EXECUTING',
        metadata: { ...metadata, executingAt: new Date().toISOString() },
      },
    });
    if (flipped.count !== 1) {
      return res.status(409).json({
        error: 'IN_PROGRESS',
        message: 'That purchase is already being processed. One moment please.',
      });
    }
    owned = true;

    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account) {
      await prisma.providerRequest.update({ where: { id: previewId }, data: { status: 'FAILED' } });
      return res.status(404).json({ error: 'USER_INPUT', message: 'Account not found' });
    }

    const { amountCents, feeCents, totalCents } = metadata;

    await ensureWallet({ accountId, balanceType: BALANCE.SPEND });

    // Deterministic keys per purchase: retries replay, never double-charge.
    const idemKey = `wapay-fuel-exec-${previewId}`;
    try {
      await reserveHold({
        accountId,
        amountCents: totalCents,
        idemKey,
        balanceType: BALANCE.SPEND,
        reason: 'fuel wiCode purchase',
      });
      holdIdemKey = idemKey;
    } catch (error) {
      if (error.code === 'INSUFFICIENT_FUNDS') {
        await prisma.providerRequest.update({ where: { id: previewId }, data: { status: 'FAILED' } });
        return res.status(400).json({ error: 'INSUFFICIENT_FUNDS', message: 'Insufficient balance' });
      }
      throw error;
    }

    // Idempotent on the UniFuel side too: a retry maps onto the SAME
    // UniFuel order and Yoyo userRef (fuelReference is deterministic).
    const reference = fuelReference(previewId);
    let outcome = await issueWicode({ reference, amountCents, productType: 'FUEL' });

    // One immediate reconcile on an indeterminate answer. UniFuel age-gates
    // the not-found verdict, so a still-in-flight mint comes back UNKNOWN
    // here, never a false FAILED.
    if (outcome.outcome === 'UNKNOWN') {
      outcome = await orderStatus(reference);
    }

    if (outcome.outcome === 'FAILED') {
      await releaseHold({ idemKey, reason: `unifuel_failed:${outcome.code || 'FAILED'}` });
      await prisma.providerRequest.update({ where: { id: previewId }, data: { status: 'FAILED' } });
      logStructured('vas_fuel_execute_result', {
        previewId, accountId, success: false, error: outcome.code || 'FAILED',
      });
      const friendly = outcome.code === 'AMOUNT_OUT_OF_RANGE'
        ? 'That amount is outside the fuel voucher range right now. Please try a different amount.'
        : 'The fuel voucher service could not complete your purchase. You have not been charged. Please try again shortly.';
      return res.status(400).json({ error: 'RETRYABLE', message: friendly, reference });
    }

    if (outcome.outcome === 'UNKNOWN' || !outcome.wicode) {
      // Still indeterminate (or issued with the code not yet minted): the
      // voucher may exist. The hold STAYS, the row goes to RECONCILE, and
      // the customer's next message retries via reconcileFuelPurchases.
      holdIdemKey = null; // the crash-release guard must NOT release it
      await prisma.providerRequest.update({
        where: { id: previewId },
        data: { status: 'RECONCILE', providerRef: reference },
      });
      logStructured('vas_fuel_execute_result', {
        previewId, accountId, success: false, error: 'PENDING_CONFIRMATION', reference,
      });
      sendOpsAlert({
        subject: 'Fuel wiCode issuance needs reconciliation',
        detailsHtml: `Reference <b>${reference}</b> is indeterminate at UniFuel. The customer hold is kept; the customer's next message retries automatically. Manual check: /api/partner/wapay/order.`,
      }).catch(() => {});
      return res.status(202).json({
        error: 'PENDING_CONFIRMATION',
        message: 'We are confirming your fuel voucher with the network. Your money is safely reserved and nothing has been lost. It will finish up automatically in a moment.',
        reference,
      });
    }

    // ISSUED — the voucher EXISTS, so from here the customer must never be
    // refunded by a crash: disarm the release guard BEFORE settling. The
    // settlement (settle + gift + SUCCESS) is idempotent; if any part of it
    // fails the row goes to RECONCILE and the reconciler finishes the job.
    holdIdemKey = null;
    try {
      await settleIssuedFuelPurchase({
        previewId,
        accountId,
        msisdn: account.msisdn,
        amountCents,
        feeCents,
        wicode: outcome.wicode,
        giftcardId: outcome.giftcardId,
        reference,
      });
    } catch (settleError) {
      await prisma.providerRequest.update({
        where: { id: previewId },
        data: { status: 'RECONCILE', providerRef: reference },
      }).catch(() => {});
      logStructured('vas_fuel_execute_result', {
        previewId, accountId, success: false, error: 'SETTLE_RETRY_QUEUED', detail: settleError?.message,
      });
      sendOpsAlert({
        subject: 'Fuel settlement retry queued',
        detailsHtml: `Reference <b>${reference}</b>: the wiCode is issued but settlement hit an error (${String(settleError?.message || '').slice(0, 120)}). The hold is kept and the idempotent settlement retries on the customer's next message.`,
      }).catch(() => {});
      return res.status(202).json({
        error: 'PENDING_CONFIRMATION',
        message: 'Your fuel voucher is issued and being finalised. It will arrive here automatically in a moment.',
        reference,
      });
    }

    const updatedWallet = await prisma.wallet.findFirst({
      where: { accountId, balanceType: BALANCE.SPEND },
    });

    // Identifiers only — NEVER the wiCode.
    logStructured('vas_fuel_execute_result', {
      previewId,
      accountId,
      amountCents,
      feeCents,
      totalCents,
      giftcardId: outcome.giftcardId,
      reference,
      testMode: outcome.testMode === true,
      newBalance: updatedWallet.availableCents,
      success: true,
    });

    return res.status(200).json({
      ok: true,
      reference,
      amountCents,
      feeCents: feeCents || 0,
      expiryDate: outcome.expiryDate || null,
      testMode: outcome.testMode === true,
      newBalance: updatedWallet.availableCents,
    });
  } catch (error) {
    // Crash guard: give reserved money back ONLY while the outcome was
    // still undetermined (status-guarded no-op after settle). Deliberately
    // disarmed the moment the voucher is known to exist.
    if (holdIdemKey) {
      try {
        await releaseHold({
          idemKey: holdIdemKey,
          reason: `execute_crashed:${String(error?.message || error).slice(0, 80)}`,
        });
        await prisma.providerRequest.update({ where: { id: previewId }, data: { status: 'FAILED' } }).catch(() => {});
      } catch (releaseError) {
        logStructured('vas_fuel_crash_release_failed', {
          previewId, idemKey: holdIdemKey, error: releaseError?.message,
        });
      }
    } else if (owned) {
      // Crashed while indeterminate or post-issue: keep everything and let
      // the reconciler finish; an EXECUTING row goes stale after 120s.
      await prisma.providerRequest.update({ where: { id: previewId }, data: { status: 'RECONCILE' } }).catch(() => {});
    }
    logStructured('vas_fuel_execute_result', {
      previewId, accountId, success: false, error: 'UNHANDLED_ERROR', errorMessage: error.message,
    });
    console.error('Fuel execute error:', error);
    return res.status(500).json({ error: 'RETRYABLE', message: 'An error occurred while executing purchase' });
  }
}
