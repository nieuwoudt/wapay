/**
 * Blu -> DB VAS catalogue sync.
 *
 * Purpose:
 * - Populate Prisma `VasProduct` from Blu catalog endpoints (esp. DATA bundles).
 * - Keep catalogue fresh via cron so WhatsApp "show <network> bundles" never depends on manual seeding.
 */

import prisma from './prisma.js';
import { BluVasExtendedClient } from '@wapay/providers-blu';
import { normalizeBluProduct } from './vas-normalize.js';

async function ensureVasProductUniqueConstraint() {
  // Ensure composite unique exists in environments where migrations may not have run.
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'VasProduct_provider_category_externalCode_key'
      ) THEN
        ALTER TABLE "VasProduct"
          ADD CONSTRAINT "VasProduct_provider_category_externalCode_key"
          UNIQUE ("provider", "category", "externalCode");
      END IF;
    END
    $$;
  `);
}

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

async function ensureVariableAirtimeProducts() {
  const networks = ['VODACOM', 'MTN', 'CELLC', 'TELKOM'];
  for (const networkCode of networks) {
    const label = `${networkCode} Airtime (any amount)`;
    const externalCode = `${networkCode}_AIRTIME_ANY`;
    await prisma.vasProduct.upsert({
      where: {
        provider_category_externalCode: {
          provider: 'BLU',
          category: 'AIRTIME',
          externalCode,
        },
      },
      update: {
        label,
        minCents: 500,
        maxCents: 100000,
        stepCents: 100,
        priceCents: 0,
        fixedPriceCents: null,
        active: true,
        metadata: {
          source: 'blu',
          vendorId: networkCode.toLowerCase(),
          seeded: true,
          type: 'VARIABLE_AIRTIME',
        },
      },
      create: {
        provider: 'BLU',
        category: 'AIRTIME',
        subcategory: 'PINNED',
        networkCode,
        externalCode,
        label,
        minCents: 500,
        maxCents: 100000,
        stepCents: 100,
        priceCents: 0,
        fixedPriceCents: null,
        purchaseType: 'INSTANT_VEND',
        targetType: 'MSISDN',
        priority: 5,
        popularity: 60,
        active: true,
        metadata: {
          source: 'blu',
          vendorId: networkCode.toLowerCase(),
          seeded: true,
          type: 'VARIABLE_AIRTIME',
        },
      },
    });
  }
}

export async function syncBluDataCatalogue({ vendors = ['vodacom', 'mtn', 'cellc', 'telkom'] } = {}) {
  const blu = new BluVasExtendedClient();
  const results = [];
  let mismatches = 0;
  let inferredDataFromAirtime = 0;

  await ensureVasProductUniqueConstraint();
  await ensureVariableAirtimeProducts();

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

    const requestedVendor = String(vendorId || '').toLowerCase();
    const filtered = (products || []).filter(p => String(p.vendorId || '').toLowerCase() === requestedVendor);
    const discarded = (products || []).length - filtered.length;
    mismatches += discarded;

    let upserted = 0;
    for (const p of filtered) {
      const externalCode = String(p.id);
      const fixedPriceCents = Number(p.amountCents || 0);
      const dataMb = p.sizeMb != null ? Number(p.sizeMb) : null;
      const validityDays = p.validityDays != null ? Number(p.validityDays) : null;
      const periodType = inferPeriodType({ name: p.name, category: p.category, validityDays });
      const normalized = normalizeBluProduct({
        name: p.name,
        category: p.category,
        sizeMb: dataMb,
        validityDays,
        periodType,
        amountCents: fixedPriceCents,
        vendorId: p.vendorId,
      });
      const canonicalCategory = normalized.derivedCategory || 'DATA';

      await prisma.vasProduct.upsert({
        where: {
          provider_category_externalCode: {
            provider: 'BLU',
            category: canonicalCategory,
            externalCode,
          },
        },
        update: {
          networkCode,
          label: p.name,
          fixedPriceCents,
          priceCents: fixedPriceCents,
          dataMb: normalized.dataMb ?? dataMb,
          validityDays: normalized.validityDays ?? validityDays,
          periodType: normalized.periodType ?? periodType,
          active: true,
          metadata: {
            source: 'blu',
            vendorId: p.vendorId,
            bluCategory: p.category,
            raw: p,
            normalized,
          },
        },
        create: {
          provider: 'BLU',
          category: canonicalCategory,
          subcategory: p.category || null,
          networkCode,
          externalCode,
          label: p.name,
          fixedPriceCents,
          priceCents: fixedPriceCents,
          dataMb: normalized.dataMb ?? dataMb,
          validityDays: normalized.validityDays ?? validityDays,
          periodType: normalized.periodType ?? periodType,
          purchaseType: 'INSTANT_VEND',
          targetType: 'MSISDN',
          priority: 50,
          popularity: 0,
          active: true,
          metadata: {
            source: 'blu',
            vendorId: p.vendorId,
            bluCategory: p.category,
            raw: p,
            normalized,
          },
        },
      });
      upserted++;
      if (canonicalCategory !== 'DATA' && (normalized.dataMb || normalized.appTags?.length)) {
        inferredDataFromAirtime++;
      }
    }

    results.push({
      vendorId,
      networkCode,
      ok: true,
      count: filtered.length,
      discarded,
      upserted,
      ms: Date.now() - startedAt,
    });

    if (discarded > 0) {
      console.warn(JSON.stringify({
        type: 'blu_sync_vendor_mismatch',
        vendorId,
        discarded,
        received: products.length,
      }));
    }
  }

  // Consolidated log summary
  const counts = results.reduce((acc, r) => {
    acc[r.networkCode] = r.count;
    return acc;
  }, {});
  console.log(JSON.stringify({
    type: 'catalog_sync_counts',
    counts,
    inferredDataFromAirtime,
    vendorMismatchesDiscarded: mismatches,
    timestamp: new Date().toISOString(),
  }));

  return { ok: true, results };
}


