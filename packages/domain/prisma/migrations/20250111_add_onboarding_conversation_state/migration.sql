-- Add onboarding and conversation state fields to Account
ALTER TABLE "Account" ADD COLUMN "onboardingStatus" TEXT DEFAULT 'NEW';
ALTER TABLE "Account" ADD COLUMN "conversationState" TEXT;
ALTER TABLE "Account" ADD COLUMN "conversationData" JSONB;

-- Update existing accounts to have NEW status
UPDATE "Account" SET "onboardingStatus" = 'NEW' WHERE "onboardingStatus" IS NULL;

