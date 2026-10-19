/**
 * Support inbox helpers (founder 2026-10-19): what an operator needs to know
 * about a conversation at a glance, computed from the turns memory holds. Pure.
 */
import { matchCloseAccountAsk } from './account-closure.js';

const QUESTION = /\?\s*$|^(how|what|when|where|why|who|which|can|could|do|does|did|is|are|will|would|should)\b/i;
const UNANSWERED_AFTER_MS = 10 * 60 * 1000;

export function summariseTurns(turns = [], { now = Date.now() } = {}) {
  const users = turns.filter((t) => t.role === 'user');
  const bots = turns.filter((t) => t.role === 'assistant');
  const last = turns[turns.length - 1] || null;
  const lastUser = users[users.length - 1] || null;
  const lastBot = bots[bots.length - 1] || null;
  const unanswered = !!(last && last.role === 'user' && now - new Date(last.at).getTime() > UNANSWERED_AFTER_MS);
  let gateTier = null; let personAsked = false; let opsReplies = 0;
  for (const t of bots) {
    const tier = t.refs && typeof t.refs === 'object' && t.refs.gate ? Number(t.refs.tier) : null;
    if (Number.isFinite(tier)) gateTier = gateTier == null ? tier : Math.max(gateTier, tier);
    if (t.refs && typeof t.refs === 'object' && t.refs.personAsked) personAsked = true;
    if (t.kind === 'ops') opsReplies += 1;
  }
  const closeAsk = users.some((t) => matchCloseAccountAsk(t.text));
  const questions = users.filter((t) => QUESTION.test(String(t.text || '').trim())).map((t) => ({ at: t.at, text: String(t.text || '').slice(0, 200) }));
  return {
    lastUserAt: lastUser ? lastUser.at : null,
    lastUserText: lastUser ? String(lastUser.text || '').slice(0, 160) : null,
    lastBotAt: lastBot ? lastBot.at : null,
    unanswered,
    gateTier,
    personAsked,
    closeAsk,
    opsReplies,
    questions,
    counts: { user: users.length, bot: bots.length },
    needsPerson: unanswered || personAsked || closeAsk || (gateTier != null && gateTier >= 2),
  };
}
