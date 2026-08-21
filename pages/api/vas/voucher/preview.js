/**
 * POST /api/vas/voucher/preview
 *
 * Preview a WaPay voucher gift ("Send R50 to 084…") before execution.
 *
 * REGULATORY NOTE: this flow sells a GOODS voucher (OTT-issued behind the
 * scenes) — it is never a money transfer. The sender buys a voucher; the
 * recipient can spend it online or cash it out via OTT's own rails. Keep all
 * copy and metadata in voucher language.
 *
 * The preview creates a short-lived ProviderRequest row that execute.js later
 * consumes. Its id is a UUID on purpose: the execute route derives its ledger
 * idemKeys from this previewId, and lib/ledger-core.js rejects idemKeys that
 * embed epoch timestamps (Date.now()-shaped ids would poison every derived
 * key).
 */

import { randomUUID } from 'crypto';
import prisma from '../../../../lib/prisma.js';
import { BALANCE, FEES } from '../../../../lib/ledger-core.js';
import { isValidSaMsisdn, normaliseMsisdn } from '../../../../lib/msisdn.js';
import { requireInternalAuth } from '../../../../lib/internal-auth.js';

/** Preview validity window, matching the other VAS previews. */
const PREVIEW_TTL_MS = 5 * 60 * 1000;

/** Voucher gift bounds: R10 minimum, R1000 maximum (integer cents). */
const MIN_AMOUNT_CENTS = 1000;
const MAX_AMOUNT_CENTS = 100000;

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

  // Internal-only route: leaks wallet balance to any caller without this.
  if (!requireInternalAuth(req, res)) return;

  const { accountId, amountCents, recipientMsisdn } = req.body;
  const normalisedRecipient = normaliseMsisdn(recipientMsisdn || '');

  logStructured('vas_voucher_preview_start', {
    accountId,
    amountCents,
    recipientMsisdn: normalisedRecipient,
  });

  try {
    // Validate required fields
    if (!accountId || !amountCents || !recipientMsisdn) {
      logStructured('vas_voucher_preview_result', {
        accountId,
        success: false,
        error: 'MISSING_FIELDS',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Missing required fields: accountId, amountCents, recipientMsisdn',
      });
    }

    // Money is always integer cents.
    if (!Number.isInteger(amountCents)) {
      logStructured('vas_voucher_preview_result', {
        accountId,
        amountCents,
        success: false,
        error: 'INVALID_AMOUNT',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Amount must be a whole number of cents',
      });
    }

    // Validate amount (min R10, max R1000)
    if (amountCents < MIN_AMOUNT_CENTS || amountCents > MAX_AMOUNT_CENTS) {
      logStructured('vas_voucher_preview_result', {
        accountId,
        amountCents,
        success: false,
        error: 'INVALID_AMOUNT',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Voucher amount must be between R10 and R1000',
      });
    }

    // Validate recipient MSISDN
    if (!isValidSaMsisdn(recipientMsisdn)) {
      logStructured('msisdn_validation_failed', {
        type: 'msisdn_validation_failed',
        accountId,
        rawInput: recipientMsisdn,
        normalisedMsisdn: normalisedRecipient,
        reason: 'format_validation_failed',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Invalid phone number format. Please use a valid SA mobile number (e.g., 0781234567)',
      });
    }

    // The customer-facing flat gift fee lives in the business model config,
    // never inline here.
    const flatFeeCents = FEES.voucherGift?.flatFeeCents;
    if (!Number.isInteger(flatFeeCents) || flatFeeCents < 0) {
      logStructured('vas_voucher_preview_result', {
        accountId,
        success: false,
        error: 'FEE_CONFIG_MISSING',
      });
      return res.status(500).json({
        error: 'RETRYABLE',
        message: 'Voucher gifting is temporarily unavailable',
      });
    }

    // Get account and SPEND wallet (gifts always draw the no-KYC SPEND balance)
    const account = await prisma.account.findUnique({ where: { id: accountId } });

    // SELF-purchase ("buy an OTT voucher") carries NO facilitation fee —
    // fees sit on money-IN (deposit payment fee) and on sending to OTHERS
    // (flat R3), never on converting your own balance to a voucher (founder
    // decision 2026-08-20; WaPay still earns the OTT issuing commission).
    const isSelfPurchase =
      account && normaliseMsisdn(account.msisdn || '') === normaliseMsisdn(recipientMsisdn);
    const feeCents = isSelfPurchase ? 0 : flatFeeCents;
    const totalCents = amountCents + feeCents;
    if (!account) {
      logStructured('vas_voucher_preview_result', {
        accountId,
        success: false,
        error: 'ACCOUNT_NOT_FOUND',
      });
      return res.status(404).json({
        error: 'USER_INPUT',
        message: 'Account not found',
      });
    }

    const wallet = await prisma.wallet.findFirst({
      where: { accountId, balanceType: BALANCE.SPEND },
    });
    if (!wallet) {
      logStructured('vas_voucher_preview_result', {
        accountId,
        success: false,
        error: 'WALLET_NOT_FOUND',
      });
      return res.status(404).json({
        error: 'USER_INPUT',
        message: 'Wallet not found',
      });
    }

    // Check balance against the full cost (amount + fee). The execute route's
    // reserveHold is the real atomic gate; this is the friendly early check.
    const availableBalance = wallet.availableCents;
    if (availableBalance < totalCents) {
      logStructured('vas_voucher_preview_result', {
        accountId,
        amountCents,
        totalCents,
        availableBalance,
        success: false,
        error: 'INSUFFICIENT_BALANCE',
      });
      return res.status(400).json({
        error: 'INSUFFICIENT_FUNDS',
        message: `Insufficient balance. Available: R${(availableBalance / 100).toFixed(2)}`,
        totalCents,
        availableBalance,
      });
    }

    // UUID id, NOT Date.now(): execute derives ledger idemKeys from this id
    // and ledger-core rejects timestamp-shaped keys.
    const previewId = `preview-vgift-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();

    // Store preview in database (expires in 5 minutes)
    await prisma.providerRequest.create({
      data: {
        id: previewId,
        idemKey: previewId,
        route: 'voucher-preview',
        status: 'PENDING',
        accountId: accountId,
        provider: 'OTT',
        metadata: {
          amountCents,
          feeCents,
          totalCents,
          recipientMsisdn: normalisedRecipient,
          expiresAt,
        },
      },
    });

    logStructured('vas_voucher_preview_result', {
      accountId,
      previewId,
      amountCents,
      feeCents,
      totalCents,
      recipientMsisdn: normalisedRecipient,
      success: true,
    });

    return res.status(200).json({
      ok: true,
      previewId,
      amountCents,
      feeCents,
      totalCents,
      recipientMsisdn: normalisedRecipient,
    });
  } catch (error) {
    console.error('Voucher preview error:', error);
    logStructured('vas_voucher_preview_fail', {
      accountId,
      recipientMsisdn: normalisedRecipient,
      success: false,
      error: 'UNHANDLED_ERROR',
      errorMessage: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'RETRYABLE',
      message: 'An error occurred while creating preview',
    });
  }
}
