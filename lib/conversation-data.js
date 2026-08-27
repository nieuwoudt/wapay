/**
 * Pure helper to manage conversationData merges safely.
 *
 * Goal:
 * - Preserve cross-cutting idempotency keys (`processedMessageIds`, `sentErrorKeys`)
 * - Avoid accidental wipe of guards when conversation state is cleared or updated
 */

export function mergeConversationData({ prevState = null, prevData = {}, nextState = null, nextData = null }) {
  const safePrev = prevData && typeof prevData === 'object' ? prevData : {};
  const safeNext = nextData && typeof nextData === 'object' ? nextData : {};

  const processedMessageIds = Array.isArray(safePrev.processedMessageIds) ? safePrev.processedMessageIds : [];
  const prevSent = Array.isArray(safePrev.sentErrorKeys) ? safePrev.sentErrorKeys : [];
  const prevHistory = Array.isArray(safePrev.history) ? safePrev.history : [];

  const stateChanged = prevState !== nextState;
  const sentErrorKeys = stateChanged ? [] : prevSent;

  // If state changes, start from a clean slate for state-specific slots.
  // If state stays the same, merge new slots on top of existing.
  const base = stateChanged ? {} : { ...safePrev };

  const merged = {
    ...base,
    ...safeNext,
    processedMessageIds,
    sentErrorKeys,
  };
  // Conversation HISTORY is cross-cutting like the idempotency keys, not a
  // state slot — starting a flow must never amnesia the AI (chat QA harness
  // finding 2026-08-27, BUGLOG #30: every state change dropped it, so "what
  // did I tell you earlier?" broke the moment any flow started or ended).
  if (!Array.isArray(merged.history) && prevHistory.length) {
    merged.history = prevHistory;
  }
  return merged;
}


