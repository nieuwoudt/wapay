-- Remembered pay-out details (founder ask 2026-10-04): the recipient name and
-- ID number once per account, and up to five destinations (a bank account or
-- a cellphone for cash collection). Account and ID numbers are stored
-- encrypted (lib/pii-vault.js, AES-256-GCM under WAPAY_PII_KEY) with the key
-- version they were written with; only the last three digits are stored in
-- clear, for the label. Both tables follow the account (ON DELETE CASCADE,
-- POPIA erasure) and "forget my bank details" / "forget me" delete them.
--
-- Idempotent: safe to run on an existing database. The apply script runs
-- statements one by one, so the FK is dropped if present and added again.

BEGIN;

CREATE TABLE IF NOT EXISTS "payout_identities" (
  "accountId"  TEXT NOT NULL,
  "fullName"   TEXT NOT NULL,
  "idType"     TEXT NOT NULL DEFAULT 'RSAID',
  "idEnc"      TEXT NOT NULL,
  "idLast3"    TEXT NOT NULL,
  "keyVersion" INTEGER NOT NULL DEFAULT 1,
  "consentAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payout_identities_pkey" PRIMARY KEY ("accountId")
);

ALTER TABLE "payout_identities" DROP CONSTRAINT IF EXISTS "payout_identities_accountId_fkey";
ALTER TABLE "payout_identities" ADD CONSTRAINT "payout_identities_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "payout_destinations" (
  "id"           TEXT NOT NULL,
  "accountId"    TEXT NOT NULL,
  "method"       TEXT NOT NULL,
  "label"        TEXT NOT NULL,
  "bankName"     TEXT,
  "branchCode"   TEXT,
  "accountEnc"   TEXT,
  "accountLast3" TEXT,
  "mobileEnc"    TEXT,
  "mobileLast3"  TEXT,
  "keyVersion"   INTEGER NOT NULL DEFAULT 1,
  "fingerprint"  TEXT NOT NULL,
  "consentAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "timesUsed"    INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "payout_destinations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "payout_destinations_accountId_fingerprint_key"
  ON "payout_destinations" ("accountId", "fingerprint");

CREATE INDEX IF NOT EXISTS "payout_destinations_accountId_lastUsedAt_idx"
  ON "payout_destinations" ("accountId", "lastUsedAt");

ALTER TABLE "payout_destinations" DROP CONSTRAINT IF EXISTS "payout_destinations_accountId_fkey";
ALTER TABLE "payout_destinations" ADD CONSTRAINT "payout_destinations_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
