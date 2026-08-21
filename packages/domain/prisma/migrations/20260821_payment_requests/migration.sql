-- Payment requests ("please pay me"): a shareable link that credits the
-- REQUESTER when paid — from another user's WaPay balance (free, in-chat)
-- or by card via PayFast (payer covers the banded payment fee).
--
--   * id is the short shareable code (no timestamp-lookalike digits)
--   * status PENDING -> PAID exactly once (status-guarded update)
--   * payerRef records who/how it was paid, for "did Thabo pay?" answers
--
-- Idempotent: safe to run on an existing database.

BEGIN;

CREATE TABLE IF NOT EXISTS "payment_requests" (
  "id"          TEXT NOT NULL,
  "accountId"   TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "note"        TEXT,
  "status"      TEXT NOT NULL DEFAULT 'PENDING',
  "payerRef"    TEXT,
  "paidAt"      TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_requests_amount_positive" CHECK ("amountCents" > 0),
  CONSTRAINT "payment_requests_status_valid" CHECK ("status" IN ('PENDING', 'PAID', 'CANCELLED', 'EXPIRED'))
);

CREATE INDEX IF NOT EXISTS "payment_requests_accountId_createdAt_idx"
  ON "payment_requests" ("accountId", "createdAt");

COMMIT;
