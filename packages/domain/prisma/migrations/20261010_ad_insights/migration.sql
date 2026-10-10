-- Growth (2026-10-10): Meta ad insights per ad per day + the ad catalogue.
-- Read by Mission Control's Growth tab; written by the daily cron and the
-- tab's refresh. Idempotent.
BEGIN;
CREATE TABLE IF NOT EXISTS "ad_insights_daily" (
  "id" TEXT PRIMARY KEY,
  "adId" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "adName" TEXT,
  "adsetId" TEXT,
  "adsetName" TEXT,
  "campaignId" TEXT,
  "campaignName" TEXT,
  "spendCents" INTEGER NOT NULL DEFAULT 0,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "reach" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "linkClicks" INTEGER NOT NULL DEFAULT 0,
  "conversations" INTEGER NOT NULL DEFAULT 0,
  "connections" INTEGER NOT NULL DEFAULT 0,
  "raw" JSONB,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "ad_insights_daily_adId_date_key" ON "ad_insights_daily"("adId", "date");
CREATE INDEX IF NOT EXISTS "ad_insights_daily_date_idx" ON "ad_insights_daily"("date");
CREATE TABLE IF NOT EXISTS "ad_catalog" (
  "adId" TEXT PRIMARY KEY,
  "name" TEXT,
  "status" TEXT,
  "adsetId" TEXT,
  "adsetName" TEXT,
  "campaignId" TEXT,
  "campaignName" TEXT,
  "objective" TEXT,
  "headline" TEXT,
  "body" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
COMMIT;
