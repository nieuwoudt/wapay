-- Beneficiaries: people this account has sent money/airtime/data to, or
-- shared as a contact card. Customers send to the same people again and
-- again (founder ask, 2026-08-19) — remembering them means "send R50 to
-- Philly" works without retyping the number.
--
--   * (accountId, msisdn) UNIQUE - one row per recipient per account,
--     upserted on every use (timesUsed bumps, name fills in when learned)
--   * (accountId, lastUsedAt)    - the "recent recipients" lookup
--
-- msisdn is stored normalised (0XXXXXXXXX). name comes from a shared
-- WhatsApp contact card when available.
--
-- Idempotent: safe to run on an existing database.

BEGIN;

CREATE TABLE IF NOT EXISTS "beneficiaries" (
  "id"         TEXT NOT NULL,
  "accountId"  TEXT NOT NULL,
  "msisdn"     TEXT NOT NULL,
  "name"       TEXT,
  "timesUsed"  INTEGER NOT NULL DEFAULT 1,
  "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "beneficiaries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "beneficiaries_accountId_msisdn_key"
  ON "beneficiaries" ("accountId", "msisdn");

CREATE INDEX IF NOT EXISTS "beneficiaries_accountId_lastUsedAt_idx"
  ON "beneficiaries" ("accountId", "lastUsedAt");

COMMIT;
