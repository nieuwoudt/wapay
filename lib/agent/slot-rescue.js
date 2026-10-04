/**
 * In-flow slot rescue for the agent's clarify step (2026-10-04).
 *
 * The founder answered the agent's withdraw question with "50 and 2" and the
 * pickup failed: the answer went back to the model as prose, the model did
 * not call start_withdraw, and the turn ended in the fallback line. A clarify
 * answer that plainly carries an amount or a method should never need a
 * model call to be understood.
 *
 * One rule, shared with the withdraw flow: the amount and any method NAMED
 * IN WORDS come from lib/payout-chat.js (the payouts thread's parser), so the
 * agent and the state machine read "50 and 2" the same way. A bare menu
 * number ("2") is NOT taken as a method here: the agent asks in words, so no
 * numbered menu was on the screen, and the flow's own method menu (where
 * "2" does mean something) is what the customer reaches next. A negated
 * answer ("no, not cash") goes back to the model untouched.
 *
 * Pure. Returns the merged slots, or null when the answer added nothing the
 * flow can use. The caller dispatches exactly as it would a model proposal,
 * so the policy gate, the preview, the confirm and the PIN are unchanged.
 */
import { parseCompoundWithdraw, methodFromWords } from '../payout-chat.js';
import { WITHDRAW_METHODS } from './tools/schemas.js';

const NEGATION = /\b(?:no|not|nope|never|don'?t|do not|cancel|stop|wait|hold on|rather|instead|actually)\b/i;

/**
 * @param {{ pendingIntent: { action: string, slots?: object } | null, text: string, options?: string[] }} args
 * @returns {{ amountCents: number | null, method: string | null, rescued: string[] } | null}
 */
export function rescueWithdrawSlots({ pendingIntent, text, options = WITHDRAW_METHODS } = {}) {
  if (!pendingIntent || pendingIntent.action !== 'WITHDRAW') return null;
  const raw = String(text || '').trim();
  if (!raw || raw.length > 160 || NEGATION.test(raw)) return null;

  const prev = pendingIntent.slots && typeof pendingIntent.slots === 'object' ? pendingIntent.slots : {};
  const parsed = parseCompoundWithdraw(raw, { options });
  const method = methodFromWords(raw, options);
  const amountCents = Number.isInteger(parsed?.amountCents) && parsed.amountCents > 0 ? parsed.amountCents : null;

  const rescued = [];
  if (amountCents != null) rescued.push('amountCents');
  if (method) rescued.push('method');
  if (!rescued.length) return null;

  const prevAmount = Number.isInteger(prev.amountCents) && prev.amountCents > 0 ? prev.amountCents : null;
  const prevMethod = typeof prev.method === 'string' && options.includes(prev.method) ? prev.method : null;
  return {
    // The newest answer wins over what the model heard before: a customer
    // who says "make it 100" is correcting, not repeating.
    amountCents: amountCents ?? prevAmount,
    method: method || prevMethod,
    rescued,
  };
}
