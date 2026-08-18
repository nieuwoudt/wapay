import prisma from './prisma.js';
import {
  buildSearchTokens,
  inferAppTagsFromName,
  inferPeriodTypeFromName,
  inferValidityDaysFromName,
} from './vas-normalize.js';
import { semanticProductSearch } from './vas-embeddings.js';

function priceOf(product) {
  return product.fixedPriceCents || product.priceCents || 0;
}

function computeValueScore(product) {
  const normalized = product.metadata?.normalized;
  if (normalized?.valueScore) return normalized.valueScore;
  const mb = product.dataMb || normalized?.dataMb;
  const priceCents = priceOf(product);
  if (!mb || !priceCents) return 0;
  return mb / (priceCents / 100);
}

export function rankProducts(products, { queryText, appTags = [], periodType } = {}) {
  const queryTokens = queryText ? buildSearchTokens({ name: queryText }) : [];
  const queryHasNight = queryText ? /night|off\s*peak/i.test(queryText) : false;

  return products
    .filter((p) => priceOf(p) > 0)
    .map((p) => {
      const normalized = p.metadata?.normalized || {};
      let score = 0;

      const name = String(p.label || '').toLowerCase();
      const isNight = /night|off\s*peak/.test(name);
      const isRetired = /(decommissioned|discontinued|retired)/i.test(name);

      if (isRetired) score -= 5;

      // Intent / app match
      if (appTags.length && Array.isArray(normalized.appTags)) {
        const matches = normalized.appTags.filter((t) => appTags.includes(t));
        if (matches.length) score += 2 * matches.length;
      }

      // Query token match
      if (queryTokens.length && Array.isArray(normalized.searchTokens)) {
        const hits = normalized.searchTokens.filter((t) => queryTokens.includes(t));
        score += 0.5 * hits.length;
      }

      // Period fit
      if (periodType && normalized.periodType === periodType) score += 1.25;
      else if (periodType && normalized.periodType && normalized.periodType !== periodType) score -= 0.25;

      // Value score
      const valueScore = computeValueScore(p);
      const valueContribution = valueScore ? Math.min(valueScore / 50, 1.5) : 0;
      score += valueContribution;

      // Night/off-peak penalty unless user asked for it
      if (isNight && !queryHasNight) score -= 1.5;

      return { product: p, score, valueScore };
    })
    .sort((a, b) => b.score - a.score || (b.valueScore || 0) - (a.valueScore || 0));
}

export async function searchProducts({
  category,
  networkCode,
  queryText,
  appTags = [],
  periodType,
  limit = 50,
} = {}) {
  const where = {
    active: true,
    ...(category ? { category } : {}),
    ...(networkCode ? { networkCode } : {}),
  };

  const products = await prisma.vasProduct.findMany({
    where,
    take: Math.min(limit * 2, 200),
  });

  const ranked = rankProducts(products, { queryText, appTags, periodType });
  return ranked.slice(0, limit).map((r) => r.product);
}

/**
 * Semantic-first product search with lexical fallback.
 *
 * Tries semanticProductSearch (pgvector cosine over embedded catalogue text);
 * when that returns [] (no API key, table missing/empty) or throws, falls back
 * to the existing lexical ranking (rankProducts, as used by searchProducts)
 * over the active products for the network.
 *
 * @param {{ prisma?: object, query: string, networkCode?: string|null, limit?: number }} args
 *   prisma is injectable for tests; defaults to the shared client.
 * @returns {Promise<Array<object>>} VasProduct rows (semantic hits carry a `distance` field)
 */
export async function hybridProductSearch({
  prisma: prismaClient = prisma,
  query = '',
  networkCode = null,
  limit = 8,
} = {}) {
  let semantic = [];
  try {
    semantic = await semanticProductSearch({ prisma: prismaClient, query, networkCode, limit });
  } catch (e) {
    console.error(JSON.stringify({
      type: 'hybrid_search_semantic_failed',
      error: e?.message || String(e),
      timestamp: new Date().toISOString(),
    }));
    semantic = [];
  }
  if (Array.isArray(semantic) && semantic.length > 0) {
    return semantic.slice(0, limit);
  }

  // Lexical fallback: same ranking as searchProducts over active products.
  const products = await prismaClient.vasProduct.findMany({
    where: {
      active: true,
      ...(networkCode ? { networkCode } : {}),
    },
    take: 200,
  });

  const appTags = inferAppTagsFromName(query);
  const validityDays = inferValidityDaysFromName(query);
  const periodType = inferPeriodTypeFromName(query, validityDays);
  const ranked = rankProducts(products, { queryText: query, appTags, periodType });
  return ranked.slice(0, limit).map((r) => r.product);
}

