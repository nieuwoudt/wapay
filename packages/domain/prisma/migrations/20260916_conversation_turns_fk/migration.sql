-- Conversation turns follow their account (POPIA erasure: deleting the
-- account deletes its transcript). Orphans from harness runs before the
-- teardown fix are removed first so the constraint can be added. Re-runnable:
-- the constraint is dropped if present and added again (the apply script
-- runs statements one by one, so no DO block).
DELETE FROM "conversation_turns" t WHERE NOT EXISTS (SELECT 1 FROM "Account" a WHERE a."id" = t."accountId");
ALTER TABLE "conversation_turns" DROP CONSTRAINT IF EXISTS "conversation_turns_accountId_fkey";
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
