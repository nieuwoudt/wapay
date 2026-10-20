-- The daily conversation audit (2026-10-19, docs/audits/DAILY_AUDIT.md): one
-- row per run and one row per distinct finding, keyed by fingerprint so a
-- problem that returns is counted as recurring instead of listed again.
-- Read by Mission Control's Health tab (GET /api/admin/audit); written by the
-- 02:00 UTC cron step and POST /api/internal/audit-run. Additive and
-- idempotent: apply with node --env-file=.env scripts/apply-migration.mjs
-- 20261019_audit_loop, then pnpm prisma:generate, before the code deploys.
BEGIN;
CREATE TABLE IF NOT EXISTS "audit_runs" (
  "id" TEXT PRIMARY KEY,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "since" TIMESTAMP(3) NOT NULL,
  "until" TIMESTAMP(3) NOT NULL,
  "accounts" INTEGER NOT NULL DEFAULT 0,
  "turns" INTEGER NOT NULL DEFAULT 0,
  "p1" INTEGER NOT NULL DEFAULT 0,
  "p2" INTEGER NOT NULL DEFAULT 0,
  "p3" INTEGER NOT NULL DEFAULT 0,
  "reviewed" BOOLEAN NOT NULL DEFAULT FALSE,
  "error" TEXT,
  "summary" JSONB
);
CREATE INDEX IF NOT EXISTS "audit_runs_startedAt_idx" ON "audit_runs"("startedAt");
CREATE TABLE IF NOT EXISTS "audit_findings" (
  "id" TEXT PRIMARY KEY,
  "fingerprint" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "why" TEXT,
  "fix" TEXT,
  "firstSeenRunId" TEXT NOT NULL,
  "lastSeenRunId" TEXT NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "occurrences" INTEGER NOT NULL DEFAULT 1,
  "accountCount" INTEGER NOT NULL DEFAULT 0,
  "accountsJson" JSONB,
  "sampleBotQuote" TEXT,
  "sampleUserQuote" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "resolvedAt" TIMESTAMP(3),
  "resolvedNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "audit_findings_fingerprint_key" ON "audit_findings"("fingerprint");
CREATE INDEX IF NOT EXISTS "audit_findings_status_severity_idx" ON "audit_findings"("status", "severity");
CREATE INDEX IF NOT EXISTS "audit_findings_lastSeenRunId_idx" ON "audit_findings"("lastSeenRunId");
COMMIT;
