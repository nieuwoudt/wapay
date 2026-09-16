-- Agent turn ledger, 2026-09-16 (AGENT_ARCHITECTURE_V2 C17): one append-only
-- row per agent turn: which path answered (agent | guard | fallback), the
-- outcome, the prompt hash, the tools called, the proposal, the policy
-- decision, the output gates that fired, latency and tokens.
-- Additive only; nothing reads this table until lib/agent/turn-ledger.js is
-- wired, so it can be applied first (deploy-ordering rule).
--
--   * waId       — masked before insert (last 4 digits only)
--   * toolCalls  — JSON, msisdn runs masked, capped at 8,000 chars
--   * proposal   — JSON, msisdn runs masked, capped at 8,000 chars
--   * gatesFired — JSON list of output-gate rule ids
CREATE TABLE IF NOT EXISTS "agent_turns" (
  "id"             TEXT NOT NULL,
  "accountId"      TEXT NOT NULL,
  "waId"           TEXT,
  "path"           TEXT NOT NULL,
  "outcome"        TEXT NOT NULL,
  "promptHash"     TEXT,
  "model"          TEXT,
  "toolCalls"      JSONB,
  "proposal"       JSONB,
  "policyDecision" TEXT,
  "gatesFired"     JSONB,
  "ms"             INTEGER,
  "inputTokens"    INTEGER,
  "outputTokens"   INTEGER,
  "error"          TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_turns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "agent_turns_accountId_createdAt_idx"
  ON "agent_turns"("accountId", "createdAt");
