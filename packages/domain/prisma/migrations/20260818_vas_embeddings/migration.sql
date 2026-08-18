-- Semantic search over the VAS catalogue: pgvector embeddings per product.
--
-- One row per VasProduct, holding a 1536-dim embedding of the product's
-- searchable meaning (label + network + category + size + validity + app tags).
-- "contentHash" is a sha256 of that text so the sync cron can skip products
-- whose meaning has not changed since the last embedding run.
--
-- Idempotent: safe to run on an existing database.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS vas_product_embeddings (
  "productId"   TEXT NOT NULL PRIMARY KEY REFERENCES "VasProduct"(id) ON DELETE CASCADE,
  embedding     vector(1536) NOT NULL,
  "contentHash" TEXT NOT NULL,
  model         TEXT NOT NULL,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ANN index tradeoff: hnsw vs ivfflat.
--   * hnsw: better recall/latency, no training step, and it can be built on an
--     EMPTY table (ivfflat built before rows exist produces a useless index and
--     needs re-clustering as data grows). Needs pgvector >= 0.5.0.
--   * ivfflat: cheaper to build/store, but requires representative data at
--     build time and `lists` tuning.
-- At this catalogue size (~831 rows) either is instant; hnsw is chosen because
-- it stays correct as the catalogue grows without any re-tuning. If the target
-- database runs pgvector < 0.5.0, swap the index below for:
--   CREATE INDEX IF NOT EXISTS vas_product_embeddings_embedding_idx
--     ON vas_product_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
CREATE INDEX IF NOT EXISTS vas_product_embeddings_embedding_idx
  ON vas_product_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS "vas_product_embeddings_contentHash_idx"
  ON vas_product_embeddings ("contentHash");

COMMIT;
