-- Add missing fields to ProviderRequest for VAS preview/execute flow
-- These fields are required for airtime/data purchase preview and execution

-- Add accountId to track which customer made the request
ALTER TABLE "ProviderRequest" 
  ADD COLUMN IF NOT EXISTS "accountId" TEXT;

-- Add metadata to store preview details (amount, msisdn, vendorId, etc.)
ALTER TABLE "ProviderRequest" 
  ADD COLUMN IF NOT EXISTS "metadata" JSONB;

-- Create index for faster lookups by accountId
CREATE INDEX IF NOT EXISTS "ProviderRequest_accountId_idx" 
  ON "ProviderRequest"("accountId");

-- Create index for faster lookups by status
CREATE INDEX IF NOT EXISTS "ProviderRequest_status_idx" 
  ON "ProviderRequest"("status");

