/**
 * GET /api/vas/bundles/:network
 * 
 * Get available data bundles for a specific network.
 * Example: GET /api/vas/bundles/vodacom
 */

import { BluVasClient } from '@wapay/providers-blu';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  try {
    const { network } = req.query;

    // Validate network
    const validNetworks = ['vodacom', 'mtn', 'cellc', 'telkom'];
    if (!network || !validNetworks.includes(network.toLowerCase())) {
      return res.status(400).json({
        error: 'USER_INPUT',
        message: `Invalid network. Must be one of: ${validNetworks.join(', ')}`
      });
    }

    const vendorId = network.toLowerCase();

    // Get bundles from Blu
    const bluClient = new BluVasClient();
    let products;
    
    try {
      products = await bluClient.getDataProducts(vendorId);
    } catch (error) {
      console.error('Failed to get data products:', error);
      
      if (error.message === 'AUTH') {
        return res.status(500).json({
          error: 'AUTH',
          message: 'Service temporarily unavailable'
        });
      }
      
      return res.status(500).json({
        error: 'RETRYABLE',
        message: 'Failed to fetch bundles. Please try again.'
      });
    }

    // Filter data bundles only
    const dataBundles = products.filter(p => p.category === 'data');

    // Format response
    const bundles = dataBundles.map(product => ({
      id: product.id,
      name: product.name,
      priceCents: product.amountCents,
      priceDisplay: `R${(product.amountCents / 100).toFixed(2)}`,
      vendorId: product.vendorId,
      category: product.category
    }));

    // Sort by price (cheapest first)
    bundles.sort((a, b) => a.priceCents - b.priceCents);

    return res.status(200).json({
      ok: true,
      network: vendorId,
      networkDisplay: bluClient.vendorIdToName(vendorId),
      count: bundles.length,
      bundles
    });

  } catch (error) {
    console.error('Bundles catalog error:', error);
    return res.status(500).json({
      error: 'RETRYABLE',
      message: 'An error occurred while fetching bundles'
    });
  }
}

