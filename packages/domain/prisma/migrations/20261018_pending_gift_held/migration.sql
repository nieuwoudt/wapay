-- A held send to someone not yet on WaPay has no voucher PIN (BUGLOG #116,
-- founder 2026-10-18: "send money" moves balance, never a voucher). Idempotent:
-- dropping NOT NULL on a nullable column is a no-op.
ALTER TABLE "pending_gifts" ALTER COLUMN "voucherPin" DROP NOT NULL;
