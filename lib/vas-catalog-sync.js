/**
 * Blu -> DB VAS catalogue sync.
 *
 * Purpose:
 * - Populate Prisma `VasProduct` from Blu catalog endpoints (esp. DATA bundles).
 * - Keep catalogue fresh via cron so WhatsApp "show <network> bundles" never depends on manual seeding.
 */

import prisma from './prisma.js';
import { BluVasClient } from '@wapay/providers-blu';

function inferPeriodType({ name = '', category = '', validityDays = null }) {
  const s = `${String(name).toLowerCase()} ${String(category).toLowerCase()}`;
  if (s.includes('weekly') || /\bweek\b/.test(s)) return 'WEEKLY';
  if (s.includes('monthly') || /\bmonth\b/.test(s)) return 'MONTHLY';
  if (s.includes('daily') || /\bday\b/.test(s)) return 'DAILY';
  if (s.includes('night')) return 'NIGHT';
  if (typeof validityDays === 'number') {
    if (validityDays <= 1) return 'DAILY';
    if (validityDays <= 7) return 'WEEKLY';
    if (validityDays <= 31) return 'MONTHLY';
  }
  return null;
}

export async function syncBluDataCatalogue({ vendors = ['vodacom', 'mtn', 'cellc', 'telkom'] } = {}) {
  const blu = new BluVasClient();
  const results = [];

  for (const vendorId of vendors) {
    const networkCode = String(vendorId).toUpperCase(); // vodacom -> VODACOM
    const startedAt = Date.now();
    let products = [];
    let error = null;

    try {
      products = await blu.getDataProducts(vendorId);
    } catch (e) {
      error = e?.message || String(e);
    }

    if (error) {
      results.push({ vendorId, networkCode, ok: false, error, count: 0, ms: Date.now() - startedAt });
      continue;
    }

    let upserted = 0;
    for (const p of products) {
      const externalCode = String(p.id);
      const fixedPriceCents = Number(p.amountCents || 0);
      const dataMb = p.sizeMb != null ? Number(p.sizeMb) : null;
      const validityDays = p.validityDays != null ? Number(p.validityDays) : null;
      const periodType = inferPeriodType({ name: p.name, category: p.category, validityDays });

      await prisma.vasProduct.upsert({
        where: {
          provider_category_externalCode: {
            provider: 'BLU',
            category: 'DATA',
            externalCode,
          },
        },
        update: {
          networkCode,
          label: p.name,
          fixedPriceCents,
          priceCents: fixedPriceCents,
          dataMb,
          validityDays,
          periodType,
          active: true,
          metadata: {
            source: 'blu',
            vendorId: p.vendorId,
            bluCategory: p.category,
          },
        },
        create: {
          provider: 'BLU',
          category: 'DATA',
          subcategory: p.category || null,
          networkCode,
          externalCode,
          label: p.name,
          fixedPriceCents,
          priceCents: fixedPriceCents,
          dataMb,
          validityDays,
          periodType,
          purchaseType: 'INSTANT_VEND',
          targetType: 'MSISDN',
          priority: 50,
          popularity: 0,
          active: true,
          metadata: {
            source: 'blu',
            vendorId: p.vendorId,
            bluCategory: p.category,
          },
        },
      });
      upserted++;
    }

    results.push({
      vendorId,
      networkCode,
      ok: true,
      count: products.length,
      upserted,
      ms: Date.now() - startedAt,
    });
  }

  return { ok: true, results };
}


