-- WaPay for Business, 2026-09-10: delivery receipts on links sent from WaPay's
-- number, and a customer opt-out for those sends. All additive and nullable;
-- the running code ignores columns it does not select, so this can be
-- applied before the deploy that uses it (deploy-ordering rule, 2026-09-04).
--
--   * payment_requests.waMessageId     — Meta's message id for the WaPay-sent
--                                        copy of the link (status webhooks key on it)
--   * payment_requests.deliveryStatus  — accepted | sent | delivered | read | failed
--   * payment_requests.deliveredAt
--   * business_customers.optedOutAt    — the customer replied STOP to WaPay
ALTER TABLE "payment_requests" ADD COLUMN IF NOT EXISTS "waMessageId" TEXT;
ALTER TABLE "payment_requests" ADD COLUMN IF NOT EXISTS "deliveryStatus" TEXT;
ALTER TABLE "payment_requests" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "payment_requests_waMessageId_idx" ON "payment_requests"("waMessageId");
ALTER TABLE "business_customers" ADD COLUMN IF NOT EXISTS "optedOutAt" TIMESTAMP(3);
