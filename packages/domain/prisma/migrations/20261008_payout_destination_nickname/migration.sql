-- A customer's own name for a saved pay-out destination ("mine", "mother"),
-- founder ask 2026-10-08 after the first production run. Shown as a prefix on
-- the label and matched when the customer picks a destination by name.
-- Idempotent.
BEGIN;
ALTER TABLE "payout_destinations" ADD COLUMN IF NOT EXISTS "nickname" TEXT;
COMMIT;
