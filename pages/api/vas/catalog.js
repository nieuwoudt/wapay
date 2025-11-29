/**
 * GET /api/vas/catalog
 * 
 * Returns the full VAS product catalogue grouped by category.
 * Does NOT require authentication - this is product information.
 */

import { PrismaClient } from '@prisma/client';

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
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  logStructured('vas_catalog_fetch_call', {});

  try {
    // Get all active products
    const products = await prisma.vasProduct.findMany({
      where: { isActive: true },
      orderBy: [
        { priority: 'asc' },
        { popularity: 'desc' },
        { label: 'asc' },
      ],
    });

    // Group by category
    const catalog = {
      AIRTIME: [],
      DATA: [],
      ELECTRICITY: [],
      LIFESTYLE: [],
      BILLPAY: [],
      REMITTANCE: [],
      GAMING: [],
    };

    for (const product of products) {
      const category = product.category;
      if (catalog[category]) {
        catalog[category].push({
          id: product.id,
          externalCode: product.externalCode,
          label: product.label,
          networkCode: product.networkCode,
          operatorCode: product.operatorCode,
          priceCents: product.fixedPriceCents || product.priceCents,
          minCents: product.minCents,
          maxCents: product.maxCents,
          dataMb: product.dataMb,
          periodType: product.periodType,
          validityDays: product.validityDays,
          purchaseType: product.purchaseType,
          targetType: product.targetType,
        });
      }
    }

    logStructured('vas_catalog_fetch_result', {
      success: true,
      totalProducts: products.length,
      byCategory: {
        AIRTIME: catalog.AIRTIME.length,
        DATA: catalog.DATA.length,
        ELECTRICITY: catalog.ELECTRICITY.length,
        LIFESTYLE: catalog.LIFESTYLE.length,
        BILLPAY: catalog.BILLPAY.length,
        REMITTANCE: catalog.REMITTANCE.length,
        GAMING: catalog.GAMING.length,
      },
    });

    return res.status(200).json({
      ok: true,
      catalog,
      totalProducts: products.length,
    });

  } catch (error) {
    console.error('Catalog fetch error:', error);
    logStructured('vas_catalog_fetch_result', {
      success: false,
      error: error.message,
    });
    return res.status(500).json({
      error: 'RETRYABLE',
      message: 'Failed to fetch product catalog',
    });
  }
}

