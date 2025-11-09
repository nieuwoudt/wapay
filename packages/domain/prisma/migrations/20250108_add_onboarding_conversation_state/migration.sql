-- AlterTable
ALTER TABLE "Account" ADD COLUMN "onboardingStatus" TEXT NOT NULL DEFAULT 'NEW',
                       ADD COLUMN "conversationState" TEXT,
                       ADD COLUMN "conversationData" JSONB;

