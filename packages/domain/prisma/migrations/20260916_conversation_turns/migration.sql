-- Conversation turns, 2026-09-16: both sides of every chat turn, append-only.
-- Replaces the 10-message JSON ring in "Account"."conversationData".history.
-- Additive only; the running code does not read this table until the deploy
-- that wires lib/turns.js, so it can be applied first (deploy-ordering rule).
--
--   * role  — user | assistant | event
--   * kind  — agent | flow | guard | home | receipt | payout_webhook | reconcile | itn
--   * text  — already redacted by lib/turns.js before insert (no bearer digits)
--   * refs  — optional pointers (paymentId, transferId, ...) for the context pack
CREATE TABLE IF NOT EXISTS "conversation_turns" (
  "id"          TEXT NOT NULL,
  "accountId"   TEXT NOT NULL,
  "role"        TEXT NOT NULL,
  "kind"        TEXT,
  "text"        TEXT NOT NULL,
  "lang"        TEXT,
  "waMessageId" TEXT,
  "refs"        JSONB,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_turns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "conversation_turns_accountId_createdAt_idx"
  ON "conversation_turns"("accountId", "createdAt");
CREATE INDEX IF NOT EXISTS "conversation_turns_waMessageId_idx"
  ON "conversation_turns"("waMessageId");
