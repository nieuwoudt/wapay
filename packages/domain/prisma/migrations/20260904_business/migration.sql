-- WaPay for Business (2026-09-04): businesses that run on WhatsApp send
-- their customers "please pay me" links from a portal and see a CRM view of
-- who paid what. A business is a WaPay account wearing a hat: its money
-- lands in the OWNER's SPEND wallet through the ordinary payment-request
-- rail, so this migration adds no money tables — only identity, customers,
-- and nullable POS fields on payment_requests.
--
--   * businesses          — one per WaPay account (owner); argon2id password
--                           hash optional (OTP-only sign-in when null)
--   * business_customers  — (businessId, msisdn) UNIQUE; totals are derived
--                           from payment_requests at read time, never stored
--   * payment_requests    — nullable businessId / customerId / items /
--                           reference / channel / sentAt. A personal link
--                           leaves all of them NULL and behaves as before.
--
-- Idempotent: safe to run on an existing database.

BEGIN;

CREATE TABLE IF NOT EXISTS "businesses" (
  "id"           TEXT NOT NULL,
  "accountId"    TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "category"     TEXT,
  "passwordHash" TEXT,
  "settings"     JSONB,
  "status"       TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "businesses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "businesses_status_valid" CHECK ("status" IN ('ACTIVE', 'SUSPENDED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "businesses_accountId_key" ON "businesses" ("accountId");

CREATE TABLE IF NOT EXISTS "business_customers" (
  "id"         TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "msisdn"     TEXT NOT NULL,
  "name"       TEXT,
  "email"      TEXT,
  "notes"      TEXT,
  "tags"       JSONB,
  "source"     TEXT NOT NULL DEFAULT 'MANUAL',
  "accountId"  TEXT,
  "lastPaidAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "business_customers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_customers_source_valid" CHECK ("source" IN ('MANUAL', 'IMPORT', 'PAYLINK'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "business_customers_businessId_msisdn_key"
  ON "business_customers" ("businessId", "msisdn");

CREATE INDEX IF NOT EXISTS "business_customers_businessId_createdAt_idx"
  ON "business_customers" ("businessId", "createdAt");

ALTER TABLE "payment_requests" ADD COLUMN IF NOT EXISTS "businessId" TEXT;
ALTER TABLE "payment_requests" ADD COLUMN IF NOT EXISTS "customerId" TEXT;
ALTER TABLE "payment_requests" ADD COLUMN IF NOT EXISTS "items"      JSONB;
ALTER TABLE "payment_requests" ADD COLUMN IF NOT EXISTS "reference"  TEXT;
ALTER TABLE "payment_requests" ADD COLUMN IF NOT EXISTS "channel"    TEXT;
ALTER TABLE "payment_requests" ADD COLUMN IF NOT EXISTS "sentAt"     TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "payment_requests_businessId_status_idx"
  ON "payment_requests" ("businessId", "status");

CREATE INDEX IF NOT EXISTS "payment_requests_businessId_createdAt_idx"
  ON "payment_requests" ("businessId", "createdAt");

COMMIT;
