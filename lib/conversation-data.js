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

  const stateChanged = prevState !== nextState;
  const sentErrorKeys = stateChanged ? [] : prevSent;

  // If state changes, start from a clean slate for state-specific slots.
  // If state stays the same, merge new slots on top of existing.
  const base = stateChanged ? {} : { ...safePrev };

  return {
    ...base,
    ...safeNext,
    processedMessageIds,
    sentErrorKeys,
  };
}


