-- Drop the legacy conversation ring, 2026-09-18.
--
-- Account.conversationData."history" held the last ten messages of each chat.
-- It was written at 63 call sites in the message processor and read at NONE:
-- conversation memory is the append-only conversation_turns table, recorded by
-- construction on every send through lib/say.js. Two things made the residue
-- worth removing rather than leaving to rot:
--
--   * "forget me" erased conversation_turns and the customer's notes but never
--     touched this key, so a customer who asked to be forgotten still had ten
--     of their own messages sitting in a column nobody reads.
--   * every ring write was a read-modify-write of the WHOLE conversationData
--     column, which also carries live flow state and the inbound dedupe list,
--     so the writes could clobber them.
--
-- The `-` operator drops the key and leaves every other key in the blob alone,
-- so flow state and processedMessageIds survive. Idempotent: rows without the
-- key are not touched, and re-running changes nothing.
--
-- Safe to apply BEFORE the code that stops writing the key deploys: a later
-- write simply recreates it, and the next run of this statement removes it
-- again.

UPDATE "Account"
SET "conversationData" = "conversationData" - 'history'
WHERE "conversationData" ? 'history'
