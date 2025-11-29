/**
 * GET /api/vas/bundles/airtime
 * 
 * Returns airtime denominations for a specific network.
 * 
 * Query params:
 * - network: VODACOM | MTN | CELLC | TELKOM (optional, returns all if omitted)
 * - limit: number (default 20)
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
 * Format airtime for display
 */
function formatAirtime(product) {
  const priceCents = product.fixedPriceCents || product.priceCents;
  return {
    id: product.id,
    externalCode: product.externalCode,
    label: product.label,
    network: product.networkCode,
    priceCents,
    priceRands: (priceCents / 100).toFixed(0),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  const { network, limit = '20' } = req.query;
  const networkCode = normalizeNetwork(network);
  const maxResults = Math.min(parseInt(limit, 10) || 20, 100);

  logStructured('vas_bundles_fetch_call', {
    endpoint: 'airtime',
    networkCode,
    limit: maxResults,
  });

  try {
    // Build query
    const where = {
      category: 'AIRTIME',
      isActive: true,
    };
    
    if (networkCode) {
      where.networkCode = networkCode;
    }

    // Get from database
    const products = await prisma.vasProduct.findMany({
      where,
      orderBy: [
        { fixedPriceCents: 'asc' },
      ],
      take: maxResults,
    });

    // Format response
    const bundles = products.map(formatAirtime);

    logStructured('vas_bundles_fetch_result', {
      endpoint: 'airtime',
      networkCode,
      count: bundles.length,
      success: true,
    });

    return res.status(200).json({
      ok: true,
      network: networkCode,
      bundles,
      count: bundles.length,
    });

  } catch (error) {
    console.error('Airtime bundles fetch error:', error);
    logStructured('vas_bundles_fetch_result', {
      endpoint: 'airtime',
      networkCode,
      success: false,
      error: error.message,
    });
    return res.status(500).json({
      error: 'RETRYABLE',
      message: 'Failed to fetch airtime options',
    });
  }
}

