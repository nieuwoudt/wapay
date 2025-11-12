-- Migration 003: Add Onboarding Tables (OTP, PIN, Consent, Audit)
-- Run this in Supabase SQL Editor

-- ============================================
-- 1. OTP Codes Table
-- ============================================
CREATE TABLE IF NOT EXISTS "otp_codes" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "otp_codes_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "otp_codes_accountId_idx" ON "otp_codes"("accountId");
CREATE INDEX IF NOT EXISTS "otp_codes_code_idx" ON "otp_codes"("code");
CREATE INDEX IF NOT EXISTS "otp_codes_expiresAt_idx" ON "otp_codes"("expiresAt");

-- ============================================
-- 2. Auth Factors Table (PIN Storage)
-- ============================================
CREATE TABLE IF NOT EXISTS "auth_factors" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "type" TEXT NOT NULL CHECK ("type" IN ('PIN')),
  "secretHash" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMP(3),
  "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT "auth_factors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "auth_factors_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "auth_factors_accountId_type_key" ON "auth_factors"("accountId", "type");

-- ============================================
-- 3. Consents Table (POPIA Compliance)
-- ============================================
CREATE TABLE IF NOT EXISTS "consents" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "agreedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "waMessageId" TEXT,
  
  CONSTRAINT "consents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "consents_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "consents_accountId_idx" ON "consents"("accountId");
CREATE INDEX IF NOT EXISTS "consents_version_idx" ON "consents"("version");

-- ============================================
-- 4. Audit Log Table
-- ============================================
CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" TEXT NOT NULL,
  "accountId" TEXT,
  "event" TEXT NOT NULL,
  "metadata" JSONB,
  "waMessageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "audit_log_accountId_idx" ON "audit_log"("accountId");
CREATE INDEX IF NOT EXISTS "audit_log_event_idx" ON "audit_log"("event");
CREATE INDEX IF NOT EXISTS "audit_log_createdAt_idx" ON "audit_log"("createdAt");

-- ============================================
-- 5. Update Account Table
-- ============================================
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'pending';
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "onboardingState" TEXT DEFAULT 'S0';

-- Update existing accounts
UPDATE "Account" SET "status" = 'pending' WHERE "status" IS NULL;
UPDATE "Account" SET "onboardingState" = 'S0' WHERE "onboardingState" IS NULL;

-- ============================================
-- 6. Helper Functions
-- ============================================

-- Function to clean up expired OTPs
CREATE OR REPLACE FUNCTION cleanup_expired_otps()
RETURNS void AS $$
BEGIN
  DELETE FROM "otp_codes" 
  WHERE "expiresAt" < NOW() 
  AND "consumedAt" IS NULL;
END;
$$ LANGUAGE plpgsql;

-- Function to unlock expired PIN locks
CREATE OR REPLACE FUNCTION unlock_expired_pins()
RETURNS void AS $$
BEGIN
  UPDATE "auth_factors"
  SET "attempts" = 0, "lockedUntil" = NULL
  WHERE "lockedUntil" < NOW();
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Success Message
-- ============================================
SELECT 'Migration 003 complete! ✅ OTP, PIN, Consent, and Audit tables created.' as status;

