/**
 * GET /api/vas/bundles/data
 * 
 * Returns data bundles for a specific network.
 * 
 * Query params:
 * - network: VODACOM | MTN | CELLC | TELKOM (optional, returns all if omitted)
 * - period: DAILY | WEEKLY | MONTHLY (optional filter)
 * - limit: number (default 20)
 */

import { PrismaClient } from '@prisma/client';
import { BluVasClient } from '@wapay/providers-blu';

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
 * Normalize network name to code
 */
function normalizeNetwork(input) {
  if (!input) return null;
  const normalized = input.toUpperCase().trim();
  
  const mappings = {
    'VODACOM': 'VODACOM',
    'VODA': 'VODACOM',
    'MTN': 'MTN',
    'CELLC': 'CELLC',
    'CELL C': 'CELLC',
    'CELL-C': 'CELLC',
    'TELKOM': 'TELKOM',
    'TELK': 'TELKOM',
  };
  
  return mappings[normalized] || normalized;
}

/**
 * Format bundle for display
 */
function formatBundle(product) {
  let sizeLabel = '';
  if (product.dataMb) {
    if (product.dataMb >= 1024) {
      sizeLabel = `${(product.dataMb / 1024).toFixed(product.dataMb % 1024 === 0 ? 0 : 1)}GB`;
    } else {
      sizeLabel = `${product.dataMb}MB`;
    }
  }
  
  return {
    id: product.id,
    externalCode: product.externalCode,
    label: product.label,
    network: product.networkCode,
    size: sizeLabel,
    dataMb: product.dataMb,
    priceCents: product.fixedPriceCents || product.priceCents,
    priceRands: ((product.fixedPriceCents || product.priceCents) / 100).toFixed(2),
    periodType: product.periodType,
    validityDays: product.validityDays,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  const { network, period, limit = '20' } = req.query;
  const networkCode = normalizeNetwork(network);
  const periodType = period?.toUpperCase();
  const maxResults = Math.min(parseInt(limit, 10) || 20, 100);

  logStructured('vas_bundles_fetch_call', {
    endpoint: 'data',
    networkCode,
    periodType,
    limit: maxResults,
  });

  try {
    // Build query
    const where = {
      category: 'DATA',
      isActive: true,
    };
    
    if (networkCode) {
      where.networkCode = networkCode;
    }
    
    if (periodType && ['DAILY', 'WEEKLY', 'MONTHLY'].includes(periodType)) {
      where.periodType = periodType;
    }

    // Try to get from database first
    let products = await prisma.vasProduct.findMany({
      where,
      orderBy: [
        { periodType: 'asc' },
        { dataMb: 'asc' },
        { fixedPriceCents: 'asc' },
      ],
      take: maxResults,
    });

    // If no products in DB for this network, try Blu API
    if (products.length === 0 && networkCode) {
      logStructured('vas_bundles_db_empty', {
        networkCode,
        tryingBluApi: true,
      });
      
      try {
        const bluClient = new BluVasClient();
        const bluProducts = await bluClient.getDataProducts(networkCode.toLowerCase());
        
        // Format Blu products
        products = bluProducts.map(p => ({
          id: p.id,
          externalCode: p.id,
          label: p.name,
          networkCode: networkCode,
          dataMb: null, // Blu doesn't always provide this
          fixedPriceCents: p.amountCents,
          priceCents: p.amountCents,
          periodType: null,
          validityDays: null,
        }));
        
        logStructured('vas_bundles_blu_fetch', {
          networkCode,
          count: products.length,
        });
      } catch (bluError) {
        console.error('Blu API fetch failed:', bluError);
        logStructured('vas_bundles_blu_error', {
          networkCode,
          error: bluError.message,
        });
      }
    }

    // Format response
    const bundles = products.map(formatBundle);

    logStructured('vas_bundles_fetch_result', {
      endpoint: 'data',
      networkCode,
      periodType,
      count: bundles.length,
      success: true,
    });

    return res.status(200).json({
      ok: true,
      network: networkCode,
      period: periodType,
      bundles,
      count: bundles.length,
    });

  } catch (error) {
    console.error('Data bundles fetch error:', error);
    logStructured('vas_bundles_fetch_result', {
      endpoint: 'data',
      networkCode,
      success: false,
      error: error.message,
    });
    return res.status(500).json({
      error: 'RETRYABLE',
      message: 'Failed to fetch data bundles',
    });
  }
}

