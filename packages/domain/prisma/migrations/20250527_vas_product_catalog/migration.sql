-- VAS Product Catalogue Migration
-- Updates VasProduct model for full catalogue support

-- Add new columns if they don't exist (safe migration)
ALTER TABLE "VasProduct" ADD COLUMN IF NOT EXISTS "provider" TEXT DEFAULT 'BLU';
ALTER TABLE "VasProduct" ADD COLUMN IF NOT EXISTS "subcategory" TEXT;
ALTER TABLE "VasProduct" ADD COLUMN IF NOT EXISTS "operatorCode" TEXT;
ALTER TABLE "VasProduct" ADD COLUMN IF NOT EXISTS "externalCode" TEXT;
ALTER TABLE "VasProduct" ADD COLUMN IF NOT EXISTS "fixedPriceCents" INTEGER;
ALTER TABLE "VasProduct" ADD COLUMN IF NOT EXISTS "periodType" TEXT;
ALTER TABLE "VasProduct" ADD COLUMN IF NOT EXISTS "dataMb" INTEGER;
ALTER TABLE "VasProduct" ADD COLUMN IF NOT EXISTS "priority" INTEGER DEFAULT 100;
ALTER TABLE "VasProduct" ADD COLUMN IF NOT EXISTS "popularity" INTEGER DEFAULT 0;
ALTER TABLE "VasProduct" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN DEFAULT true;

-- Migrate existing data
UPDATE "VasProduct" SET "externalCode" = "skuCode" WHERE "externalCode" IS NULL;
UPDATE "VasProduct" SET "fixedPriceCents" = "priceCents" WHERE "fixedPriceCents" IS NULL AND "priceCents" > 0;
UPDATE "VasProduct" SET "isActive" = "active" WHERE "isActive" IS NULL;

-- Create new indexes
CREATE INDEX IF NOT EXISTS "VasProduct_category_networkCode_idx" ON "VasProduct"("category", "networkCode");
CREATE INDEX IF NOT EXISTS "VasProduct_isActive_category_idx" ON "VasProduct"("isActive", "category");
CREATE INDEX IF NOT EXISTS "VasProduct_priority_idx" ON "VasProduct"("priority");
CREATE INDEX IF NOT EXISTS "VasProduct_popularity_idx" ON "VasProduct"("popularity");

-- Create unique constraint on provider + category + externalCode (if externalCode is not null)
-- Note: This may fail if duplicates exist - run after data cleanup
-- CREATE UNIQUE INDEX IF NOT EXISTS "VasProduct_provider_category_externalCode_key" 
-- ON "VasProduct"("provider", "category", "externalCode") 
-- WHERE "externalCode" IS NOT NULL;

