/**
 * GET /api/vas/top-products
 * 
 * Returns the top VAS products/services available on WaPay.
 * Used for "What VAS products can I buy on WaPay?" queries.
 * 
 * Query params:
 * - limit: number (default 10)
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

/**
 * Category display names
 */
const CATEGORY_NAMES = {
  AIRTIME: 'Mobile Airtime',
  DATA: 'Data Bundles',
  ELECTRICITY: 'Prepaid Electricity',
  LIFESTYLE: 'Lifestyle & OTT',
  BILLPAY: 'Bill Payments',
  REMITTANCE: 'Money Transfers',
  GAMING: 'Betting & Gaming',
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  const { limit = '10' } = req.query;
  const maxResults = Math.min(parseInt(limit, 10) || 10, 50);

  logStructured('vas_top_products_fetch_call', {
    limit: maxResults,
  });

  try {
    // Get top products by popularity
    const products = await prisma.vasProduct.findMany({
      where: { isActive: true },
      orderBy: [
        { popularity: 'desc' },
        { priority: 'asc' },
      ],
      take: maxResults,
      distinct: ['category'], // Get one per category first
    });

    // Also get category summaries
    const categoryCounts = await prisma.vasProduct.groupBy({
      by: ['category'],
      where: { isActive: true },
      _count: { id: true },
    });

    // Build response
    const topProducts = products.map(p => ({
      id: p.id,
      category: p.category,
      categoryName: CATEGORY_NAMES[p.category] || p.category,
      label: p.label,
      operatorCode: p.operatorCode,
      networkCode: p.networkCode,
      priceCents: p.fixedPriceCents || p.priceCents,
      priceDisplay: p.minCents 
        ? `From R${(p.minCents / 100).toFixed(0)}` 
        : p.fixedPriceCents 
          ? `R${(p.fixedPriceCents / 100).toFixed(0)}`
          : 'Variable',
    }));

    // Build category summary
    const categories = {};
    for (const cat of categoryCounts) {
      categories[cat.category] = {
        name: CATEGORY_NAMES[cat.category] || cat.category,
        productCount: cat._count.id,
      };
    }

    logStructured('vas_list_vas_products', {
      count: topProducts.length,
      categories: Object.keys(categories),
      success: true,
    });

    return res.status(200).json({
      ok: true,
      topProducts,
      categories,
      totalCategories: Object.keys(categories).length,
    });

  } catch (error) {
    console.error('Top products fetch error:', error);
    logStructured('vas_list_vas_products', {
      success: false,
      error: error.message,
    });
    return res.status(500).json({
      error: 'RETRYABLE',
      message: 'Failed to fetch top products',
    });
  }
}

