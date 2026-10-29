-- One open withdrawal per account (2026-10-28, BUGLOG #147, incident Build rule 3). On 28 October a customer
-- was offered a second withdrawal while the first waited for approval with its money set aside. The code
-- refuses OPEN_PAYOUT in lib/payouts.js requestPayoutCore before any row; this partial unique index is the
-- database's own backstop for two requests racing past that read. The statuses are the ones that still hold
-- money and are in flight (lib/payout-status-copy.js OPEN_PAYOUT_STATUSES); a SUCCESS, FAILED or
-- NEEDS_OPERATOR row is never constrained (NEEDS_OPERATOR waits for a person and must not block the customer).
--
-- Before applying, this must return no rows (an account with two open withdrawals would make the index fail,
-- and the transaction then changes nothing):
--   SELECT "accountId", count(*) FROM "ProviderRequest" WHERE "route" = 'ott-payout'
--     AND "status" IN ('INIT','AWAITING_APPROVAL','PENDING','REJECTING') GROUP BY 1 HAVING count(*) > 1;
--
-- And look at any open row older than a day: it blocks that customer's next withdrawal until it is resolved
-- (reconcile a PENDING or INIT one, approve or reject an AWAITING_APPROVAL one, finish a REJECTING one):
--   SELECT "accountId", status, metadata->>'reference', "requestTs" FROM "ProviderRequest" WHERE "route" = 'ott-payout'
--     AND "status" IN ('INIT','AWAITING_APPROVAL','PENDING','REJECTING') AND "requestTs" < now() - interval '1 day';
--
-- Additive and idempotent: node --env-file=.env scripts/apply-migration.mjs 20261028_one_open_payout. No Prisma
-- client change (a partial index is not in the schema), and the code works with or without it.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS "ProviderRequest_one_open_payout" ON "ProviderRequest"("accountId") WHERE "route" = 'ott-payout' AND "status" IN ('INIT', 'AWAITING_APPROVAL', 'PENDING', 'REJECTING');
COMMIT;
