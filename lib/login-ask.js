/**
 * "Login" in the chat (2026-11-18, BUGLOG #153).
 *
 * A customer typed "login". Nothing deterministic knew the word, so the model answered from the
 * feature notes and told them to say "business login" for a code. They did. That command only
 * answers a number that owns a business or is invited to open one, so it stayed silent, the
 * message went back to the model, and the model told them to say "business login" again. The loop
 * guard (lib/loop-guard.js) caught the second reply; the first wrong instruction had already gone.
 *
 * The rule this file holds: a sign-in question is answered from what exists for THIS number, by
 * code, before any model. A person in the chat is already in their account; the same account is
 * in a browser at the web portal with the cell number and the PIN; a business portal code is only
 * ever offered to a number that can get one. No reply here names a command the chat does not
 * handle for the person reading it (tests/login-ask.test.mjs runs each one through the loop guard).
 *
 * Pure: the processor reads the account and sends.
 */

const LEAD = '(?:(?:hi|hello|hey|please|pls)[,!.]?\\s+)?(?:(?:how\\s+(?:do|can|should)\\s+i|where\\s+(?:do|can)\\s+i|can\\s+i|i\\s+(?:want|need|would\\s+like)\\s+to|let\\s+me|help\\s+me(?:\\s+to)?)\\s+)?';
const VERB = '(?:log\\s*-?\\s*in|login|sign\\s*-?\\s*in|signin|log\\s+me\\s+in|sign\\s+me\\s+in|log\\s*-?\\s*on|logon)';
const WHERE = '(?:\\s+(?:to|on|into|in|at|with)\\s+(?:my\\s+|the\\s+|your\\s+)?(?:wapay(?:\\s+(?:account|app|web(?:site)?|portal))?|account|app|web(?:site)?|portal|profile|wallet))?';
const TAIL = '\\s*(?:please|pls)?\\s*[.!?]*';
const LOGIN_RE = new RegExp(`^${LEAD}${VERB}${WHERE}${TAIL}$`, 'i');

/**
 * A bare sign-in ask: "login", "log in", "sign in", "how do I log in", "login to my account".
 * Anchored on the whole message and short, so a sentence that only mentions a login ("the login
 * page shows an error", "I can't log in, it says wrong PIN") goes to the router as a support
 * question, and "business login" / "admin login" (their own commands, handled earlier) never land
 * here. Pure.
 */
export function matchLoginAsk(text = '') {
  const s = String(text || '').trim();
  if (!s || s.length > 60) return false;
  return LOGIN_RE.test(s);
}

const webLine = (appHost) => (appHost ? ` To use WaPay in a browser, open ${appHost} and sign in with your cell number and your WaPay PIN.` : '');

/**
 * The answer to a bare sign-in ask. `hasBusiness` adds the business portal code, and only then:
 * "business login" answers nobody else. Pure.
 */
export function loginAnswer({ appHost = '', hasBusiness = false } = {}) {
  const lines = [`✅ You are already signed in here: this chat is your WaPay account.${webLine(appHost)}`];
  if (hasBusiness) lines.push('🏪 For your business portal, say *business login* and I send your sign-in code here.');
  lines.push('Forgot your PIN? Say *forgot PIN* and I help you set a new one.');
  return lines.join('\n\n');
}

/**
 * "business login" from a number that owns no business and is not invited to open one: said
 * plainly, about the sender's own number only, with the one command that does something for them
 * ("business account" registers them or puts them on the list). Pure.
 */
export function noBusinessLoginText({ appHost = '' } = {}) {
  return [
    '🏪 There is no WaPay for Business account on this number, so there is no portal code to send. Say *business account* to ask for one.',
    `Your own WaPay account needs no code here: this chat is it.${webLine(appHost)}`,
  ].join('\n\n');
}

/** A business that is paused gets no code and is told so, with where to write. Pure. */
export function pausedBusinessLoginText({ supportEmail = '' } = {}) {
  return `🏪 Your WaPay for Business account is paused, so I cannot send a sign-in code right now.${supportEmail ? ` Write to ${supportEmail} and a person will look at it.` : ''}`;
}
