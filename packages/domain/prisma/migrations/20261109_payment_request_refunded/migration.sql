-- A card payment refunded in the PayFast or Adumo dashboard and reversed in the
-- ledger closes its payment link as REFUNDED (lib/card-refund.js, BUGLOG #146,
-- 2026-11-09). The status check of 20260821_payment_requests allowed only
-- PENDING, PAID, CANCELLED and EXPIRED. Idempotent: drop the check if it exists
-- and add it back with REFUNDED, so a re-run lands in the same place.
ALTER TABLE "payment_requests" DROP CONSTRAINT IF EXISTS "payment_requests_status_valid";
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_status_valid" CHECK ("status" IN ('PENDING', 'PAID', 'CANCELLED', 'EXPIRED', 'REFUNDED'));
