-- Where payment links travel (2026-10-25, founder): one row per device per link per kind per day, with the
-- area Vercel's edge reads from the request's IP (country, province, city, a city-level point), never GPS
-- and never the IP itself. Read by Mission Control's Links tab (GET /api/admin/link-map); written by the
-- pay page, checkout, link creation and the web app's signed-in requests (lib/link-visits.js). Rows older
-- than 90 days are deleted by the daily cron. Additive and idempotent: apply with
-- node --env-file=.env scripts/apply-migration.mjs 20261025_link_visits, then pnpm prisma:generate,
-- before the code deploys (the code tolerates the table missing, it just records nothing).
BEGIN;
CREATE TABLE IF NOT EXISTS "link_visits" (
  "id" TEXT PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "code" TEXT NOT NULL DEFAULT '',
  "accountId" TEXT,
  "source" TEXT,
  "country" TEXT,
  "region" TEXT,
  "city" TEXT,
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "device" TEXT,
  "os" TEXT,
  "browser" TEXT,
  "app" TEXT,
  "visitorKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "link_visits_kind_code_visitorKey_key" ON "link_visits"("kind", "code", "visitorKey");
CREATE INDEX IF NOT EXISTS "link_visits_createdAt_idx" ON "link_visits"("createdAt");
CREATE INDEX IF NOT EXISTS "link_visits_code_idx" ON "link_visits"("code");
CREATE INDEX IF NOT EXISTS "link_visits_accountId_createdAt_idx" ON "link_visits"("accountId", "createdAt");
COMMIT;
