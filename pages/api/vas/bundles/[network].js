/**
 * GET /api/vas/bundles/:network
 *
 * Data bundles for one network, from WaPay's own catalogue table (synced
 * daily from Blu by /api/cron/daily-vas-sync). Example: GET /api/vas/bundles/vodacom
 *
 * 2026-10-14: this route used to be PUBLIC and fetched the list live from
 * Blu's API on every request, so any crawler, scanner or monitor that found
 * the URL produced supplier traffic from our credentials with nothing in our
 * own records (Blu reported "unusually high volumes" the night of 13 October).
 * It is now internal-only and never calls the supplier; listing is a read of
 * our table, like /api/vas/bundles/data.
 */

import prisma from '../../../../lib/prisma.js';
import { requireInternalAuth } from '../../../../lib/internal-auth.js';

const NETWORKS = { vodacom: 'Vodacom', mtn: 'MTN', cellc: 'Cell C', telkom: 'Telkom' };

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  // Internal-only: a public listing that reaches a supplier is a supplier
  // load problem waiting for a crawler.
  if (!requireInternalAuth(req, res)) return;

  try {
    const network = String(req.query?.network || '').toLowerCase();
    if (!NETWORKS[network]) {
      return res.status(400).json({
        error: 'USER_INPUT',
        message: `Invalid network. Must be one of: ${Object.keys(NETWORKS).join(', ')}`,
      });
    }

    const rows = await prisma.vasProduct.findMany({
      where: { active: true, category: 'DATA', networkCode: network.toUpperCase() },
      orderBy: [{ fixedPriceCents: 'asc' }, { priceCents: 'asc' }, { label: 'asc' }],
    });

    const bundles = rows.map((p) => {
      const priceCents = p.fixedPriceCents || p.priceCents || 0;
      return {
        id: p.externalCode,
        name: p.label,
        priceCents,
        priceDisplay: `R${(priceCents / 100).toFixed(2)}`,
        vendorId: network,
        category: 'data',
        dataMb: p.dataMb ?? null,
        periodType: p.periodType ?? null,
      };
    });

    return res.status(200).json({
      ok: true,
      network,
      networkDisplay: NETWORKS[network],
      count: bundles.length,
      source: 'catalogue',
      bundles,
    });
  } catch (error) {
    console.error('Bundles catalog error:', error);
    return res.status(500).json({ error: 'RETRYABLE', message: 'An error occurred while fetching bundles' });
  }
}
