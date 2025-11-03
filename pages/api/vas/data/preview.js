/**
 * POST /api/vas/data/preview
 * 
 * Preview a data bundle purchase before execution.
 * Shows customer bundle details and pricing.
 */

import { PrismaClient } from '@prisma/client';
import { BluVasClient } from '@wapay/providers-blu';

const prisma = new PrismaClient();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  try {
    const { accountId, msisdn, productId, vendorId } = req.body;

    // Validate required fields
    if (!accountId || !msisdn || !productId || !vendorId) {
      return res.status(400).json({
        error: 'USER_INPUT',
        message: 'Missing required fields: accountId, msisdn, productId, vendorId'
      });
    }

    // Get account and wallet
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      include: { wallet: true }
    });

    if (!account) {
      return res.status(404).json({
        error: 'USER_INPUT',
        message: 'Account not found'
      });
    }

    if (!account.wallet) {
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
    } catch (error) {
      console.error('Failed to get data products:', error);
      return res.status(400).json({
        error: 'RETRYABLE',
        message: 'Failed to fetch bundle details'
      });
    }

    // Find the specific product
    const product = products.find(p => p.id === productId);
    
    if (!product) {
      return res.status(404).json({
        error: 'USER_INPUT',
        message: 'Bundle not found'
      });
    }

    // Check balance
    const availableBalance = account.wallet.availableCents;
    const feeCents = 0; // No fee for now
    const totalCents = product.amountCents + feeCents;

    if (availableBalance < totalCents) {
      return res.status(400).json({
        error: 'USER_INPUT',
        message: `Insufficient balance. Available: R${(availableBalance / 100).toFixed(2)}, Required: R${(totalCents / 100).toFixed(2)}`
      });
    }

    // Create preview
    const previewId = `preview-data-${Date.now()}-${accountId}`;

    // Store preview in database (expires in 5 minutes)
    await prisma.providerRequest.create({
      data: {
        id: previewId,
        idemKey: previewId,
        route: 'data-preview',
        status: 'PENDING',
        accountId: accountId,
        metadata: {
          msisdn,
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

    // Return preview
    return res.status(200).json({
      ok: true,
      previewId,
      preview: {
        type: 'data',
        msisdn,
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
    return res.status(500).json({
      error: 'RETRYABLE',
      message: 'An error occurred while creating preview'
    });
  }
}

