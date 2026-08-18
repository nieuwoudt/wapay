-- Pending voucher gifts: value bought for a phone number that may not be a
-- WaPay user yet.
--
-- The rail (OTT today) has already issued the voucher when this row is
-- written; the row holds the voucher until the recipient shows up on WhatsApp
-- and the gift is marked DELIVERED exactly once (status-guarded update, so
-- concurrent claims cannot deliver the same gift twice).
--
--   * idemKey UNIQUE          - a replayed create returns the original row
--   * status CHECK            - ISSUED -> DELIVERED | CANCELLED, nothing else
--   * (recipientMsisdn,status) - the claim path's lookup, so it must be indexed
--   * voucherPin              - BEARER SECRET, see the column comment
--
-- Idempotent: safe to run on an existing database.

BEGIN;

CREATE TABLE IF NOT EXISTS "pending_gifts" (
  "id"              TEXT NOT NULL,
  "senderAccountId" TEXT NOT NULL,
  "recipientMsisdn" TEXT NOT NULL,
  "amountCents"     INTEGER NOT NULL,
  "rail"            TEXT NOT NULL,
  "voucherPin"      TEXT NOT NULL,
  "voucherSerial"   TEXT,
  "status"          TEXT NOT NULL DEFAULT 'ISSUED',
  "idemKey"         TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt"     TIMESTAMP(3),
  CONSTRAINT "pending_gifts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pending_gifts_amount_positive" CHECK ("amountCents" > 0),
  CONSTRAINT "pending_gifts_status_valid" CHECK ("status" IN ('ISSUED', 'DELIVERED', 'CANCELLED'))
);

COMMENT ON COLUMN "pending_gifts"."voucherPin" IS
  'BEARER SECRET: whoever holds this PIN can redeem the voucher. Never log or display the full value outside delivery to the recipient - mask like maskMsisdn does.';

CREATE UNIQUE INDEX IF NOT EXISTS "pending_gifts_idemKey_key"
  ON "pending_gifts" ("idemKey");

CREATE INDEX IF NOT EXISTS "pending_gifts_recipientMsisdn_status_idx"
  ON "pending_gifts" ("recipientMsisdn", "status");

COMMIT;
