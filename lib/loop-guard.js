/**
 * The loop that froze Lisa (2026-10-12): the model told her `Type "reset
 * PIN"`, she typed "Reset pin", nothing deterministic knew the words, and the
 * same model told her to type them again, four times. Whatever the cause of
 * the next invented command, the signature is the same and cheap to see: the
 * reply about to go out asks the customer to type what they just typed.
 * Such a reply is never sent; the customer gets an honest line instead and a
 * person is asked to look (founder 2026-10-14: "this sort of hanging should
 * never happen"). Pure apart from nothing: the caller sends and alerts.
 */

const INSTRUCTION = /\b(?:type|say|reply(?: with)?|send|write|text|enter)\s+(?:me\s+)?(?:the words?\s+)?["“'‘*_]+([^"”'’*_\n]{2,40}?)["”'’*_]+/gi;
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');

/** The phrases a reply asks the customer to type ("type *reset PIN*", `say "withdraw R50"`). Pure. */
export function instructedPhrases(reply) {
  return [...String(reply || '').matchAll(INSTRUCTION)].map((m) => m[1].trim()).filter(Boolean);
}

/**
 * A loop: the previous reply told the customer to type a phrase, they typed
 * it (equal after normalising, or the phrase plus a few characters such as
 * "Reset pin 2006"), and the reply about to go out tells them to type it
 * again. A first "type *balance* any time" after "balance" is not a loop (the
 * previous reply never asked); "I want to withdraw" against `say "withdraw"`
 * is not either (the customer did not send the phrase). Pure.
 */
export function echoLoop(reply, inbound, previousReply = null) {
  const n = norm(inbound);
  if (n.length < 3) return false;
  const asked = previousReply == null ? null : new Set(instructedPhrases(previousReply).map(norm));
  return instructedPhrases(reply).some((p) => {
    const q = norm(p);
    if (q.length < 3 || !(n === q || (n.startsWith(q) && n.length - q.length <= 6))) return false;
    return asked == null || asked.has(q);
  });
}

/** What the customer reads instead; a person is named only when the alert went. */
export function loopBreakText({ personAsked = false } = {}) {
  return personAsked
    ? 'Sorry, I sent you round in a circle there: what I asked you to type is not something I can do in this chat. I have asked a person from the WaPay team to look at it and message you here. Meanwhile, say *help* to see what I can do.'
    : 'Sorry, I sent you round in a circle there: what I asked you to type is not something I can do in this chat. Say *help* to see what I can do.';
}
