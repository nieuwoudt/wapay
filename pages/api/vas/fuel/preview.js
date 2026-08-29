/**
 * POST /api/vas/fuel/preview
 *
 * Preview a fuel wiCode purchase ("buy R200 fuel") before execution.
 * Mirrors the voucher preview: internal-auth gate, integer-cents bounds,
 * friendly balance check, and a UUID previewId that execute derives its
 * ledger idemKeys from (never Date.now-shaped — ledger-core rejects those).
 *
 * The wiCode is issued by UniFuel (service-to-service) against the Yoyo
 * environment; UniFuel re-validates the amount against its product bounds
 * at issue time, so these env bounds only need to be honest defaults.
 */

import { randomUUID } from 'crypto';
import prisma from '../../../../lib/prisma.js';
import { BALANCE } from '../../../../lib/ledger-core.js';
import { requireInternalAuth } from '../../../../lib/internal-auth.js';

const PREVIEW_TTL_MS = 5 * 60 * 1000;

/**
 * Fuel voucher bounds (integer cents); env-tunable to track UniFuel's
 * product rows. Default max matches the live UniFuel/Yoyo product cap
 * (R500 — verified against the test catalogue 2026-08-29) so a quote is
 * never given for an amount the supplier will reject.
 */
const MIN_AMOUNT_CENTS = Number(process.env.WAPAY_FUEL_MIN_CENTS) || 5000; // R50
const MAX_AMOUNT_CENTS = Number(process.env.WAPAY_FUEL_MAX_CENTS) || 50000; // R500

/** Customer-facing fee: fee-free at launch (spend earns commission, not fees). */
const FLAT_FEE_CENTS = Number(process.env.WAPAY_FUEL_FLAT_FEE_CENTS) || 0;

function logStructured(type, data) {
  console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }
  if (!requireInternalAuth(req, res)) return;

  const { accountId, amountCents } = req.body;

  try {
    if (!accountId || !amountCents) {
      return res.status(400).json({ error: 'USER_INPUT', message: 'Missing required fields: accountId, amountCents' });
    }
    if (!Number.isInteger(amountCents)) {
      return res.status(400).json({ error: 'USER_INPUT', message: 'Amount must be a whole number of cents' });
    }
    if (amountCents < MIN_AMOUNT_CENTS || amountCents > MAX_AMOUNT_CENTS) {
      return res.status(400).json({
        error: 'USER_INPUT',
        message: `Fuel voucher amount must be between R${MIN_AMOUNT_CENTS / 100} and R${MAX_AMOUNT_CENTS / 100}`,
        minCents: MIN_AMOUNT_CENTS,
        maxCents: MAX_AMOUNT_CENTS,
      });
    }

    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account) {
      return res.status(404).json({ error: 'USER_INPUT', message: 'Account not found' });
    }

    const feeCents = Number.isInteger(FLAT_FEE_CENTS) && FLAT_FEE_CENTS > 0 ? FLAT_FEE_CENTS : 0;
    const totalCents = amountCents + feeCents;

    const wallet = await prisma.wallet.findFirst({
      where: { accountId, balanceType: BALANCE.SPEND },
    });
    if (!wallet) {
      return res.status(404).json({ error: 'USER_INPUT', message: 'Wallet not found' });
    }
    if (wallet.availableCents < totalCents) {
      logStructured('vas_fuel_preview_result', {
        accountId, amountCents, totalCents, availableBalance: wallet.availableCents,
        success: false, error: 'INSUFFICIENT_BALANCE',
      });
      return res.status(400).json({
        error: 'INSUFFICIENT_FUNDS',
        message: `Insufficient balance. Available: R${(wallet.availableCents / 100).toFixed(2)}`,
        totalCents,
        availableBalance: wallet.availableCents,
      });
    }

    // UUID id, NOT Date.now(): execute derives ledger idemKeys from this id.
    const previewId = `preview-fuel-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();

    await prisma.providerRequest.create({
      data: {
        id: previewId,
        idemKey: previewId,
        route: 'fuel-preview',
        status: 'PENDING',
        accountId,
        provider: 'YOYO',
        metadata: { amountCents, feeCents, totalCents, expiresAt },
      },
    });

    logStructured('vas_fuel_preview_result', {
      accountId, previewId, amountCents, feeCents, totalCents, success: true,
    });

    return res.status(200).json({ ok: true, previewId, amountCents, feeCents, totalCents });
  } catch (error) {
    console.error('Fuel preview error:', error);
    logStructured('vas_fuel_preview_fail', { accountId, error: error.message });
    return res.status(500).json({ error: 'RETRYABLE', message: 'An error occurred while creating preview' });
  }
}
