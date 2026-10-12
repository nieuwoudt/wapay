-- Pay-outs for customers without a South African ID (founder 2026-10-12, the
-- Lisa case): a passport or foreign ID number is stored encrypted like the SA
-- ID (idType = 'PASSPORT'), with the issuing country (ISO alpha-2) that the
-- rail receives as country_of_issue and nationality. And cellphone labels
-- show the last FOUR digits ("Mine: cellphone •••1175"); bank accounts and
-- ID numbers keep three, so only cash destinations gain a column. Idempotent.
BEGIN;
ALTER TABLE "payout_identities" ADD COLUMN IF NOT EXISTS "countryOfIssue" TEXT;
ALTER TABLE "payout_destinations" ADD COLUMN IF NOT EXISTS "mobileLast4" TEXT;
COMMIT;
