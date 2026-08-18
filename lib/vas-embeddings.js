/**
 * Semantic (embedding-based) search over the VAS product catalogue.
 *
 * "something cheap for TikTok that lasts a week" should find the right bundle
 * by MEANING, not by token overlap. Each active VasProduct gets one line of
 * searchable text (label, network, category, size, validity, app tags), which
 * is embedded with OpenAI text-embedding-3-small and stored in
 * vas_product_embeddings (pgvector, cosine distance).
 *
 * Design constraints:
 * - No OpenAI SDK: plain fetch against POST /v1/embeddings.
 * - No API key => everything degrades gracefully (sync skips, search returns []).
 * - Missing table / DB errors => search returns [] so callers fall back to lexical.
 * - Re-embedding is skipped for unchanged products via contentHash (sha256 of
 *   the embedding text).
 */

import crypto from 'crypto';

export const EMBEDDING_MODEL = 'text-embedding-3-small';

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

/** Friendly names so the embedded text matches how users talk about apps. */
const APP_TAG_NAMES = {
  WHATSAPP: 'WhatsApp',
  TIKTOK: 'TikTok',
  YOUTUBE: 'YouTube',
  FACEBOOK: 'Facebook',
  INSTAGRAM: 'Instagram',
  SOCIAL: 'social media',
  STREAMING: 'video streaming',
};

const CATEGORY_PHRASES = {
  AIRTIME: 'airtime top-up',
  DATA: 'mobile data bundle',
  ELECTRICITY: 'prepaid electricity token',
};

/**
 * "500MB" / "1.5GB" — deterministic, no locale formatting.
 * @param {number} dataMb
 * @returns {string}
 */
function formatDataSize(dataMb) {
  if (dataMb >= 1024) {
    const gb = Number((dataMb / 1024).toFixed(2));
    return `${gb}GB`;
  }
  return `${dataMb}MB`;
}

/**
 * "weekly (valid 7 days)" etc.
 * @param {number|null} validityDays
 * @param {string|null} periodType DAILY | WEEKLY | MONTHLY | NIGHT | ONCE_OFF
 * @returns {string|null}
 */
function formatValidity(validityDays, periodType) {
  if (validityDays != null && Number.isFinite(Number(validityDays))) {
    const days = Number(validityDays);
    if (days <= 1) return `daily (valid 1 day)`;
    if (days === 7) return `weekly (valid 7 days)`;
    if (days === 30 || days === 31) return `monthly (valid ${days} days)`;
    return `valid ${days} days`;
  }
  if (periodType) return String(periodType).toLowerCase().replace(/_/g, ' ');
  return null;
}

/**
 * One line of searchable meaning per product. Pure and deterministic: the
 * same product object always produces byte-identical output (contentHashOf
 * depends on it to decide whether to re-embed).
 *
 * @param {object} product VasProduct row (metadata.normalized honoured if present)
 * @returns {string}
 */
export function buildEmbeddingText(product = {}) {
  const normalized = product?.metadata?.normalized || {};
  const pieces = [];

  const label = String(product.label || '').replace(/\s+/g, ' ').trim();
  if (label) pieces.push(label);

  if (product.networkCode) pieces.push(`${product.networkCode} network`);

  if (product.category) {
    const phrase = CATEGORY_PHRASES[product.category] || String(product.category).toLowerCase();
    pieces.push(phrase);
  }

  const dataMb = product.dataMb ?? normalized.dataMb ?? null;
  if (dataMb != null && Number(dataMb) > 0) pieces.push(`${formatDataSize(Number(dataMb))} data`);

  const validity = formatValidity(
    product.validityDays ?? normalized.validityDays ?? null,
    product.periodType ?? normalized.periodType ?? null
  );
  if (validity) pieces.push(validity);

  const appTags = Array.isArray(normalized.appTags) ? normalized.appTags : [];
  if (appTags.length) {
    const names = appTags.map((t) => APP_TAG_NAMES[t] || String(t).toLowerCase());
    pieces.push(`for ${names.join(', ')}`);
  }

  return pieces.join(' | ');
}

/**
 * sha256 of the embedding text — used to skip re-embedding unchanged products.
 * @param {object} product
 * @returns {string} 64-char hex digest
 */
export function contentHashOf(product) {
  return crypto.createHash('sha256').update(buildEmbeddingText(product), 'utf8').digest('hex');
}

/**
 * '[0.1,0.2,...]' — pgvector accepts this as a string literal cast ::vector.
 * @param {number[]} vec
 * @returns {string}
 */
function toVectorLiteral(vec) {
  return `[${vec.join(',')}]`;
}

/**
 * Embed up to ~2048 texts in one OpenAI call (we stay well under that via
 * batchSize). Plain fetch, no SDK. Throws on HTTP/parse failure — callers
 * decide how to degrade.
 *
 * @param {{ texts: string[], apiKey: string }} args
 * @returns {Promise<number[][]>} vectors aligned with input order
 */
async function embedTexts({ texts, apiKey }) {
  const res = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    // text-embedding-3-small defaults to 1536 dimensions — matches vector(1536).
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`openai_embeddings_http_${res.status}: ${String(body).slice(0, 300)}`);
  }

  const json = await res.json();
  const out = new Array(texts.length);
  for (const item of json?.data || []) {
    out[item.index] = item.embedding;
  }
  return out;
}

/**
 * Embed every active product whose embedding is missing or whose content
 * changed. Never throws: DB or OpenAI failures are logged and counted so the
 * daily cron always completes.
 *
 * @param {{ prisma: object, batchSize?: number }} args
 * @returns {Promise<{embedded:number, skipped:number, failed:number, upToDate:number, total:number, error?:string}>}
 *   skipped = products that needed embedding but were not attempted (no API key)
 */
export async function syncProductEmbeddings({ prisma, batchSize = 96 } = {}) {
  let rows;
  try {
    rows = await prisma.$queryRaw`
      SELECT p.*, e."contentHash" AS "existingContentHash"
      FROM "VasProduct" p
      LEFT JOIN vas_product_embeddings e ON e."productId" = p.id
      WHERE p.active = true
    `;
  } catch (e) {
    // Table missing (migration not applied yet) or DB unavailable — degrade.
    console.error(JSON.stringify({
      type: 'embeddings_sync_error',
      stage: 'load_products',
      error: e?.message || String(e),
      timestamp: new Date().toISOString(),
    }));
    return { embedded: 0, skipped: 0, failed: 0, upToDate: 0, total: 0, error: e?.message || String(e) };
  }

  const pending = [];
  let upToDate = 0;
  for (const row of rows || []) {
    const text = buildEmbeddingText(row);
    if (!text) { upToDate++; continue; } // nothing meaningful to embed
    const hash = contentHashOf(row);
    if (row.existingContentHash && row.existingContentHash === hash) {
      upToDate++;
    } else {
      pending.push({ product: row, text, hash });
    }
  }

  const total = (rows || []).length;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log(JSON.stringify({
      type: 'embeddings_skipped',
      reason: 'no_api_key',
      pending: pending.length,
      total,
      timestamp: new Date().toISOString(),
    }));
    return { embedded: 0, skipped: pending.length, failed: 0, upToDate, total };
  }

  let embedded = 0;
  let failed = 0;

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    let vectors;
    try {
      vectors = await embedTexts({ texts: batch.map((b) => b.text), apiKey });
    } catch (e) {
      failed += batch.length;
      console.error(JSON.stringify({
        type: 'embeddings_batch_failed',
        stage: 'embed',
        batchStart: i,
        batchSize: batch.length,
        error: e?.message || String(e),
        timestamp: new Date().toISOString(),
      }));
      continue; // never let one bad batch kill the run
    }

    for (let j = 0; j < batch.length; j++) {
      const { product, hash } = batch[j];
      const vec = vectors[j];
      if (!Array.isArray(vec)) {
        failed++;
        console.error(JSON.stringify({
          type: 'embeddings_batch_failed',
          stage: 'missing_vector',
          productId: product.id,
          timestamp: new Date().toISOString(),
        }));
        continue;
      }
      try {
        await prisma.$executeRaw`
          INSERT INTO vas_product_embeddings ("productId", embedding, "contentHash", model, "updatedAt")
          VALUES (${product.id}, ${toVectorLiteral(vec)}::vector, ${hash}, ${EMBEDDING_MODEL}, CURRENT_TIMESTAMP)
          ON CONFLICT ("productId") DO UPDATE
          SET embedding = EXCLUDED.embedding,
              "contentHash" = EXCLUDED."contentHash",
              model = EXCLUDED.model,
              "updatedAt" = CURRENT_TIMESTAMP
        `;
        embedded++;
      } catch (e) {
        failed++;
        console.error(JSON.stringify({
          type: 'embeddings_batch_failed',
          stage: 'upsert',
          productId: product.id,
          error: e?.message || String(e),
          timestamp: new Date().toISOString(),
        }));
      }
    }
  }

  console.log(JSON.stringify({
    type: 'embeddings_sync_complete',
    embedded,
    failed,
    upToDate,
    total,
    model: EMBEDDING_MODEL,
    timestamp: new Date().toISOString(),
  }));

  return { embedded, skipped: 0, failed, upToDate, total };
}

/**
 * Nearest-neighbour product search by meaning (cosine distance). Returns []
 * whenever semantic search cannot answer (no API key, embed failure, table
 * missing/empty) so callers can fall back to the lexical path.
 *
 * @param {{ prisma: object, query: string, networkCode?: string|null, limit?: number }} args
 * @returns {Promise<Array<object>>} VasProduct rows with an extra `distance` field (lower = closer)
 */
export async function semanticProductSearch({ prisma, query, networkCode = null, limit = 8 } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !prisma || !query || !String(query).trim()) return [];

  let vec;
  try {
    [vec] = await embedTexts({ texts: [String(query).trim()], apiKey });
  } catch (e) {
    console.error(JSON.stringify({
      type: 'embeddings_search_error',
      stage: 'embed_query',
      error: e?.message || String(e),
      timestamp: new Date().toISOString(),
    }));
    return [];
  }
  if (!Array.isArray(vec)) return [];

  const vecLiteral = toVectorLiteral(vec);
  try {
    const rows = await prisma.$queryRaw`
      SELECT p.*, (e.embedding <=> ${vecLiteral}::vector) AS distance
      FROM vas_product_embeddings e
      JOIN "VasProduct" p ON p.id = e."productId"
      WHERE p.active = true
        AND (${networkCode}::text IS NULL OR p."networkCode" = ${networkCode})
      ORDER BY distance ASC
      LIMIT ${limit}
    `;
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    // Missing table / extension / DB hiccup — lexical fallback handles it.
    console.error(JSON.stringify({
      type: 'embeddings_search_error',
      stage: 'query',
      error: e?.message || String(e),
      timestamp: new Date().toISOString(),
    }));
    return [];
  }
}
