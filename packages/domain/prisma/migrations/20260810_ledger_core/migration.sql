-- Phase 1: money-safe ledger core
--
-- Makes the ledger the source of truth:
--   * one wallet per (account, balanceType) - kills the duplicate-wallet bug
--   * SPEND vs CASH balances - the no-KYC / KYC boundary
--   * UNIQUE idemKey on JournalEntry - real idempotency, replays return the original
--   * holds - reserve funds before a provider call instead of racing
--   * processed_messages - webhook dedupe by uniqueness, not an in-memory Set
--   * CHECK constraints - a negative balance becomes impossible at the DB level
--
-- Safe to run on an existing database: backfills before constraining.

BEGIN;

-- ---------------------------------------------------------------------------
-- Wallet: balance types
-- ---------------------------------------------------------------------------

ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "balanceType" TEXT NOT NULL DEFAULT 'SPEND';
ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Collapse any pre-existing duplicate wallets into the oldest one per account
-- so the unique constraint below can be created. Balances are summed, not lost.
WITH ranked AS (
  SELECT id, "accountId", "balanceType",
         ROW_NUMBER() OVER (PARTITION BY "accountId", "balanceType" ORDER BY id) AS rn
  FROM "Wallet"
),
keepers AS (SELECT id, "accountId", "balanceType" FROM ranked WHERE rn = 1),
losers AS (SELECT id, "accountId", "balanceType" FROM ranked WHERE rn > 1),
sums AS (
  SELECT k.id AS keeper_id,
         COALESCE(SUM(w."availableCents"), 0) AS extra_available,
         COALESCE(SUM(w."pendingCents"), 0)   AS extra_pending
  FROM keepers k
  JOIN losers l
    ON l."accountId" = k."accountId" AND l."balanceType" = k."balanceType"
  JOIN "Wallet" w ON w.id = l.id
  GROUP BY k.id
)
UPDATE "Wallet" w
SET "availableCents" = w."availableCents" + s.extra_available,
    "pendingCents"   = w."pendingCents"   + s.extra_pending
FROM sums s
WHERE w.id = s.keeper_id;

DELETE FROM "Wallet" w
USING (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY "accountId", "balanceType" ORDER BY id) AS rn
    FROM "Wallet"
  ) t WHERE rn > 1
) d
WHERE w.id = d.id;

CREATE UNIQUE INDEX IF NOT EXISTS "Wallet_accountId_balanceType_key"
  ON "Wallet" ("accountId", "balanceType");
CREATE INDEX IF NOT EXISTS "Wallet_accountId_idx" ON "Wallet" ("accountId");

-- Money can never go negative, and a balance type must be one we know.
ALTER TABLE "Wallet" DROP CONSTRAINT IF EXISTS "Wallet_available_non_negative";
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_available_non_negative"
  CHECK ("availableCents" >= 0);

ALTER TABLE "Wallet" DROP CONSTRAINT IF EXISTS "Wallet_pending_non_negative";
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_pending_non_negative"
  CHECK ("pendingCents" >= 0);

ALTER TABLE "Wallet" DROP CONSTRAINT IF EXISTS "Wallet_balanceType_valid";
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_balanceType_valid"
  CHECK ("balanceType" IN ('SPEND', 'CASH'));

-- ---------------------------------------------------------------------------
-- JournalEntry: real idempotency
-- ---------------------------------------------------------------------------

ALTER TABLE "JournalEntry" ADD COLUMN IF NOT EXISTS "idemKey" TEXT;
ALTER TABLE "JournalEntry" ADD COLUMN IF NOT EXISTS "metadata" JSONB;

-- Legacy rows have no idemKey. Backfill from externalRef where present,
-- otherwise synthesise one from the row id so the NOT NULL can be applied.
UPDATE "JournalEntry"
SET "idemKey" = COALESCE(NULLIF("externalRef", ''), 'legacy:' || id)
WHERE "idemKey" IS NULL;

-- Any duplicates created by that backfill get suffixed; legacy data keeps its
-- history without blocking the constraint that protects everything going forward.
WITH dupes AS (
  SELECT id, "idemKey",
         ROW_NUMBER() OVER (PARTITION BY "idemKey" ORDER BY "createdAt", id) AS rn
  FROM "JournalEntry"
)
UPDATE "JournalEntry" je
SET "idemKey" = je."idemKey" || ':dup' || d.rn
FROM dupes d
WHERE je.id = d.id AND d.rn > 1;

ALTER TABLE "JournalEntry" ALTER COLUMN "idemKey" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "JournalEntry_idemKey_key" ON "JournalEntry" ("idemKey");
CREATE INDEX IF NOT EXISTS "JournalEntry_source_createdAt_idx" ON "JournalEntry" ("source", "createdAt");
CREATE INDEX IF NOT EXISTS "JournalEntry_createdAt_idx" ON "JournalEntry" ("createdAt");

-- Reconciliation reads lines by account code.
CREATE INDEX IF NOT EXISTS "JournalLine_accountCode_idx" ON "JournalLine" ("accountCode");
CREATE INDEX IF NOT EXISTS "JournalLine_entryId_idx" ON "JournalLine" ("entryId");

-- A line is a debit or a credit, never both, never neither.
ALTER TABLE "JournalLine" DROP CONSTRAINT IF EXISTS "JournalLine_single_side";
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_single_side"
  CHECK (
    ("debitCents" IS NOT NULL AND "creditCents" IS NULL)
    OR ("debitCents" IS NULL AND "creditCents" IS NOT NULL)
  );

ALTER TABLE "JournalLine" DROP CONSTRAINT IF EXISTS "JournalLine_amounts_positive";
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_amounts_positive"
  CHECK (COALESCE("debitCents", 0) >= 0 AND COALESCE("creditCents", 0) >= 0);

-- ---------------------------------------------------------------------------
-- Holds
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "holds" (
  "id"          TEXT NOT NULL,
  "walletId"    TEXT NOT NULL,
  "idemKey"     TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'ACTIVE',
  "reason"      TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt"  TIMESTAMP(3),
  CONSTRAINT "holds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "holds_amount_positive" CHECK ("amountCents" > 0),
  CONSTRAINT "holds_status_valid" CHECK ("status" IN ('ACTIVE', 'SETTLED', 'RELEASED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "holds_idemKey_key" ON "holds" ("idemKey");
CREATE INDEX IF NOT EXISTS "holds_walletId_status_idx" ON "holds" ("walletId", "status");
CREATE INDEX IF NOT EXISTS "holds_status_createdAt_idx" ON "holds" ("status", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'holds_walletId_fkey'
  ) THEN
    ALTER TABLE "holds"
      ADD CONSTRAINT "holds_walletId_fkey"
      FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Webhook de-duplication
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "processed_messages" (
  "id"          TEXT NOT NULL,
  "waMessageId" TEXT NOT NULL,
  "accountId"   TEXT,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "processed_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "processed_messages_waMessageId_key"
  ON "processed_messages" ("waMessageId");
CREATE INDEX IF NOT EXISTS "processed_messages_processedAt_idx"
  ON "processed_messages" ("processedAt");

COMMIT;
