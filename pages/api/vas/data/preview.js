/**
 * POST /api/vas/data/preview
 * 
 * Preview a data bundle purchase before execution.
 * Shows customer bundle details and pricing.
 * Includes structured logging for debugging.
 */

import { PrismaClient } from '@prisma/client';
import { BluVasClient } from '@wapay/providers-blu';
import { isValidSaMsisdn, normaliseMsisdn } from '../../../../lib/msisdn.js';
import { requireInternalAuth } from '../../../../lib/internal-auth.js';

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

  // Internal-only route: leaks wallet balance to any caller without this.
  if (!requireInternalAuth(req, res)) return;

    const { accountId, msisdn, productId, vendorId } = req.body;
    const normalisedMsisdn = normaliseMsisdn(msisdn || '');

  // Log the preview call
  logStructured('vas_data_preview_call', {
    accountId,
    msisdn: normalisedMsisdn,
    productId,
    vendorId,
  });

  try {
    // Validate required fields
    if (!accountId || !msisdn || !productId || !vendorId) {
      logStructured('vas_data_preview_result', {
        accountId,
        success: false,
        error: 'MISSING_FIELDS',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Missing required fields: accountId, msisdn, productId, vendorId'
      });
    }

    if (!isValidSaMsisdn(msisdn)) {
      logStructured('msisdn_validation_failed', {
        type: 'msisdn_validation_failed',
        accountId,
        rawInput: msisdn,
        normalisedMsisdn,
        reason: 'format_validation_failed',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Invalid phone number format. Please use a valid SA mobile number (e.g., 0781234567)'
      });
    }

    // Get account and wallet
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      include: { wallets: true }
    });

    if (!account) {
      logStructured('vas_data_preview_result', {
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
      logStructured('vas_data_preview_result', {
        accountId,
        success: false,
        error: 'WALLET_NOT_FOUND',
      });
      return res.status(404).json({
        error: 'USER_INPUT',
        message: 'Wallet not found'
      });
    }

    // Get bundle details from Blu
    const bluClient = new BluVasClient();
    let products;
    
    try {
      products = await bluClient.getDataProducts(vendorId);
      logStructured('vas_data_products_fetched', {
        vendorId,
        productCount: products.length,
      });
    } catch (error) {
      console.error('Failed to get data products:', error);
      logStructured('vas_data_preview_result', {
        accountId,
        vendorId,
        success: false,
        error: 'PRODUCTS_FETCH_FAILED',
        errorMessage: error.message,
      });
      return res.status(400).json({
        error: 'RETRYABLE',
        message: 'Failed to fetch bundle details'
      });
    }

    // Find the specific product
    const product = products.find(p => p.id === productId);
    
    if (!product) {
      logStructured('vas_data_preview_result', {
        accountId,
        productId,
        success: false,
        error: 'PRODUCT_NOT_FOUND',
      });
      return res.status(404).json({
        error: 'USER_INPUT',
        message: 'Bundle not found'
      });
    }

    // Check balance
    const availableBalance = wallet.availableCents;
    const feeCents = 0; // No fee for now
    const totalCents = product.amountCents + feeCents;

    if (availableBalance < totalCents) {
      logStructured('vas_data_preview_result', {
        accountId,
        totalCents,
        availableBalance,
        success: false,
        error: 'INSUFFICIENT_BALANCE',
      });
      return res.status(400).json({
        error: 'USER_INPUT',
        message: `Insufficient balance. Available: R${(availableBalance / 100).toFixed(2)}, Required: R${(totalCents / 100).toFixed(2)}`
      });
    }

    // Create preview
    const previewId = `preview-data-${Date.now().toString(36)}-${accountId}`;

    // Store preview in database (expires in 5 minutes)
    await prisma.providerRequest.create({
      data: {
        id: previewId,
        idemKey: previewId,
        route: 'data-preview',
        status: 'PENDING',
        accountId: accountId,
        metadata: {
          msisdn: normalisedMsisdn,
          productId,
          productName: product.name,
          vendorId,
          priceCents: product.amountCents,
          feeCents,
          totalCents,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
        }
      }
    });

    // Log success
    logStructured('vas_data_preview_result', {
      accountId,
      previewId,
      msisdn: normalisedMsisdn,
      productId,
      productName: product.name,
      vendorId,
      totalCents,
      success: true,
    });

    // Return preview
    return res.status(200).json({
      ok: true,
      previewId,
      preview: {
        type: 'data',
        msisdn: normalisedMsisdn,
        productId,
        productName: product.name,
        vendorId,
        priceCents: product.amountCents,
        feeCents,
        totalCents,
        availableBalance: availableBalance,
        newBalance: availableBalance - totalCents,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
      }
    });

  } catch (error) {
    console.error('Data preview error:', error);
    logStructured('vas_data_preview_result', {
      accountId,
      msisdn: normalisedMsisdn,
      productId,
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
