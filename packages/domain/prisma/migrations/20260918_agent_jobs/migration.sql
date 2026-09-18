-- Agent jobs, 2026-09-18 (AGENT_ARCHITECTURE_V2 C20, Phase 4): one table for
-- every piece of work that must NOT run on the customer's turn. The chat path
-- has a 60 second budget and a customer waiting; a supplier reconcile, a
-- retention purge or a backfill belongs here instead.
--
-- Additive only, and nothing reads it until lib/jobs.js is wired, so this can
-- be applied to production before the code that uses it deploys.
--
--   * kind        — the worker that handles it ('fuel-reconcile', 'payout-sweep', …)
--   * key         — the caller's idempotency handle. UNIQUE with kind, so the
--                   same work is never queued twice; an existing PENDING row is
--                   simply left alone.
--   * runAfter    — the earliest time to run it (a backoff sets this on retry)
--   * status      — PENDING | RUNNING | DONE | FAILED
--   * attempts    — incremented on every claim; a job that exhausts maxAttempts
--                   is FAILED and left for a human, never retried forever
--   * lockedAt    — set when claimed; a RUNNING row older than the stale window
--                   is reclaimable, because a serverless worker can vanish
--                   mid-job without ever writing DONE or FAILED
--   * payload     — JSON, whatever the worker needs. No bearer secrets: the
--                   caller passes ids, and the worker reads the row itself.
CREATE TABLE IF NOT EXISTS "agent_jobs" (
  "id"          TEXT NOT NULL,
  "kind"        TEXT NOT NULL,
  "key"         TEXT NOT NULL,
  "accountId"   TEXT,
  "status"      TEXT NOT NULL DEFAULT 'PENDING',
  "payload"     JSONB,
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "runAfter"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt"    TIMESTAMP(3),
  "lastError"   TEXT,
  "result"      JSONB,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_jobs_pkey" PRIMARY KEY ("id")
);

-- The idempotency guarantee: one live row per (kind, key).
CREATE UNIQUE INDEX IF NOT EXISTS "agent_jobs_kind_key_key"
  ON "agent_jobs"("kind", "key");

-- The drain's own query: the oldest runnable job of any kind.
CREATE INDEX IF NOT EXISTS "agent_jobs_status_runAfter_idx"
  ON "agent_jobs"("status", "runAfter");

-- Reading a customer's outstanding work without scanning the table.
CREATE INDEX IF NOT EXISTS "agent_jobs_accountId_status_idx"
  ON "agent_jobs"("accountId", "status");
