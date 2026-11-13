-- A held send nobody collected in 30 days goes back to its sender and its row
-- closes as REFUNDED (lib/pending-gifts.js refundExpiredHeldGifts, founder
-- 2026-10-18). The status check of 20260821_pending_gifts allowed only ISSUED,
-- DELIVERED and CANCELLED, so the database refused that close and no refund
-- could ever run; the first held sends reach 30 days on 2026-11-17. Idempotent:
-- drop the check if it exists and add it back with REFUNDED, so a re-run lands
-- in the same place.
ALTER TABLE "pending_gifts" DROP CONSTRAINT IF EXISTS "pending_gifts_status_valid";
ALTER TABLE "pending_gifts" ADD CONSTRAINT "pending_gifts_status_valid" CHECK ("status" IN ('ISSUED', 'DELIVERED', 'CANCELLED', 'REFUNDED'));
