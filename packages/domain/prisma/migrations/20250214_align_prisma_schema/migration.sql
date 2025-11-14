-- Align production DB schema with current Prisma models
-- 1) Ensure audit_log has timestamp/ip/user columns expected by Prisma
-- 2) Ensure consents table matches Prisma fields (rename agreedAt -> grantedAt, add new nullable columns)

-- =========================
-- Audit Log adjustments
-- =========================
ALTER TABLE "audit_log"
  ADD COLUMN IF NOT EXISTS "timestamp" TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS "ipAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "userAgent" TEXT;

-- Backfill timestamp from legacy createdAt column (run once safely)
UPDATE "audit_log"
SET "timestamp" = COALESCE("timestamp", "createdAt");

-- Keep column nullable but add a sane default for new rows
ALTER TABLE "audit_log"
  ALTER COLUMN "timestamp" SET DEFAULT CURRENT_TIMESTAMP;

-- =========================
-- Consents table adjustments
-- =========================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'consents' AND column_name = 'agreedAt'
  ) THEN
    ALTER TABLE "consents" RENAME COLUMN "agreedAt" TO "grantedAt";
  END IF;
END $$;

ALTER TABLE "consents"
  ADD COLUMN IF NOT EXISTS "consentType" TEXT,
  ADD COLUMN IF NOT EXISTS "granted" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "ipAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "userAgent" TEXT;

-- Backfill legacy rows with safe defaults (keep columns nullable)
UPDATE "consents"
SET
  "consentType" = COALESCE("consentType", 'TERMS_AND_CONDITIONS'),
  "granted" = COALESCE("granted", TRUE);

-- No NOT NULL constraint to keep migration non-breaking; Prisma will still insert explicit values.

