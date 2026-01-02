/**
 * POST /api/vas/electricity/preview
 * 
 * Preview an electricity purchase before execution.
 * Validates meter number and shows purchase details.
 */

import { PrismaClient } from '@prisma/client';
import { isCategoryEnabledForWaId } from '../../../../lib/vas-config.js';
import { BluVasExtendedClient } from '@wapay/providers-blu';

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

/**
 * Validate meter number format
 * SA electricity meters are typically 10-14 digits
 */
function isValidMeterNumber(meterNumber) {
  if (!meterNumber || typeof meterNumber !== 'string') return false;
  const cleaned = meterNumber.replace(/\D/g, '');
  return /^\d{8,14}$/.test(cleaned);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  const { accountId, meterNumber, amountCents, municipalityCode } = req.body;

  // Log the preview call
  logStructured('vas_electricity_preview_call', {
    accountId,
    meterNumber,
    amountCents,
    municipalityCode,
  });

  try {
    // Check if electricity is enabled (optionally allowlisted by waId)
    const accountForGate = await prisma.account.findUnique({
      where: { id: accountId },
      select: { waId: true },
    });
    const waId = accountForGate?.waId || null;
    if (!isCategoryEnabledForWaId('ELECTRICITY', waId)) {
      logStructured('vas_electricity_preview_result', {
        accountId,
        success: false,
        error: 'CATEGORY_DISABLED',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Electricity purchases are not available yet. Please try again later.'
      });
    }

    // Validate required fields
    if (!accountId || !meterNumber || !amountCents) {
      logStructured('vas_electricity_preview_result', {
        accountId,
        success: false,
        error: 'MISSING_FIELDS',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Missing required fields: accountId, meterNumber, amountCents'
      });
    }

    // Validate meter number format
    if (!isValidMeterNumber(meterNumber)) {
      logStructured('vas_electricity_preview_result', {
        accountId,
        meterNumber,
        success: false,
        error: 'INVALID_METER_NUMBER',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Invalid meter number. Please enter a valid 10-14 digit meter number.'
      });
    }

    // Validate amount (min R10, max R5000)
    if (amountCents < 1000 || amountCents > 500000) {
      logStructured('vas_electricity_preview_result', {
        accountId,
        amountCents,
        success: false,
        error: 'INVALID_AMOUNT',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Amount must be between R10 and R5000'
      });
    }

    // Get account and wallet
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      include: { wallets: true }
    });

    if (!account) {
      logStructured('vas_electricity_preview_result', {
        accountId,
        success: false,
        error: 'ACCOUNT_NOT_FOUND',
      });
      return res.status(404).json({
        error: 'USER_INPUT',
        message: 'Account not found'
      });
    }

    const wallet = account.wallets?.[0];
    if (!wallet) {
      logStructured('vas_electricity_preview_result', {
        accountId,
        success: false,
        error: 'WALLET_NOT_FOUND',
      });
      return res.status(404).json({
        error: 'USER_INPUT',
        message: 'Wallet not found'
      });
    }

    // Check balance (electricity amount + R1 service fee)
    const serviceFee = 100; // R1 service fee
    const totalCents = amountCents + serviceFee;
    const availableBalance = wallet.availableCents;
    
    if (availableBalance < totalCents) {
      logStructured('vas_electricity_preview_result', {
        accountId,
        amountCents,
        totalCents,
        availableBalance,
        success: false,
        error: 'INSUFFICIENT_BALANCE',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: `Insufficient balance. You need R${(totalCents / 100).toFixed(2)} (R${(amountCents / 100).toFixed(2)} + R${(serviceFee / 100).toFixed(2)} fee). Available: R${(availableBalance / 100).toFixed(2)}`
      });
    }

    // Confirm meter / get provider reference from Blu (required for sale)
    let info;
    try {
      const bluClient = new BluVasExtendedClient();
      info = await bluClient.getElectricityInfo({
        meterNumber: meterNumber.replace(/\D/g, ''),
        amountCents,
        freeBasicElectricity: false,
      });
      logStructured('vas_electricity_info_ok', {
        accountId,
        meterNumber,
        amountCents,
        reference: info?.reference,
      });
      if (!info?.reference) {
        return res.status(502).json({
          error: 'UPSTREAM_FAILURE',
          message: 'Electricity service unavailable. Please try again later.',
        });
      }
    } catch (e) {
      const reason = e?.reason || e?.message || 'Electricity info lookup failed';
      logStructured('vas_electricity_info_failed', {
        accountId,
        meterNumber,
        amountCents,
        error: e?.message,
        reason,
        statusCode: e?.statusCode,
      });
      // Blu sometimes returns AUTH with message like "Invalid transaction type" for disabled flows.
      const friendly =
        String(reason || '').toLowerCase().includes('invalid transaction type')
          ? 'Electricity is not enabled for this environment yet.'
          : 'Electricity service unavailable. Please try again later.';
      return res.status(502).json({
        error: 'UPSTREAM_FAILURE',
        message: friendly,
      });
    }

    // Create preview record
    const preview = await prisma.providerRequest.create({
      data: {
        id: `elec_prev_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        provider: 'BLU',
        type: 'ELECTRICITY_PREVIEW',
        status: 'PENDING',
        accountId: accountId,
        requestJson: JSON.stringify({
          meterNumber,
          amountCents,
          municipalityCode: municipalityCode || 'AUTO',
          serviceFee,
          totalCents,
          reference: info.reference,
        }),
        metadata: {
          meterNumber,
          amountCents,
          municipalityCode: municipalityCode || 'AUTO',
          serviceFee,
          totalCents,
          reference: info.reference,
          customerName: info.customerName,
          customerAddress: info.customerAddress,
          municipalityName: info.municipalityName,
          municipalityCodeFromInfo: info.municipalityCode,
          accountId,
          waId: account.waId,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 min expiry
        },
      }
    });

    logStructured('vas_electricity_preview_result', {
      accountId,
      previewId: preview.id,
      meterNumber,
      amountCents,
      serviceFee,
      totalCents,
      success: true,
    });

    return res.status(200).json({
      ok: true,
      previewId: preview.id,
      preview: {
        meterNumber,
        amountCents,
        serviceFee,
        totalCents,
        availableBalance,
        newBalance: availableBalance - totalCents,
        customerName: info.customerName,
        municipalityName: info.municipalityName,
      }
    });

  } catch (error) {
    console.error('Electricity preview error:', error);
    logStructured('vas_electricity_preview_error', {
      accountId,
      meterNumber,
      error: error.message,
    });

    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'An error occurred. Please try again.'
    });
  }
}

