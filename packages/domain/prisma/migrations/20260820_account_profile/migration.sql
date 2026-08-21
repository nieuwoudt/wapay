-- User memory/profile (founder ask 2026-08-20): the bot must get to know
-- the customer — language, preferred deposit method, last meter, product
-- interests — written deterministically at success points and injected
-- into the orchestrator every turn. One JSONB column; shape owned by
-- lib/user-profile.js. Idempotent.

ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "profile" JSONB;
