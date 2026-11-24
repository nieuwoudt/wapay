/**
 * The message box on the WaPay landing screen (2026-11-24): what a typed line
 * means, decided by code. Pure: no network, no storage, no model. The page
 * (components/app/Landing.js) does what this returns.
 *
 * The rule that comes first (docs/GOLDEN_THREAD.md 2.13): the message box
 * never takes a secret. A line shaped like a PIN, an ID or passport number, or
 * a long run of digits that is not a South African cell number is answered
 * with SECRET_LINE on the page and goes nowhere. A PIN is typed only into the
 * PIN boxes, which post it to /api/app/auth or /api/app/pin.
 *
 * Someone who is not signed in gets the ad flow's own reading of a question
 * (lib/ad-flow.js classifyAdEntry), so the web and the chat hear the same
 * question the same way. A member's everyday words open the page or the card
 * that already exists. Nothing here starts a payment.
 */
import { classifyAdEntry, matchLoanAsk } from './ad-flow.js';

export const SECRET_LINE = 'That looks like a PIN, an ID number or an account number. Never type one in this box. WaPay asks for your PIN only in the PIN boxes, when you confirm something. Nothing was sent.';
export const BAD_CELL_LINE = 'That does not look like a South African cell number. Type all ten digits, like 083 123 4567.';

const compact = (s) => String(s || '').replace(/[\s().+-]/g, '');
const SA_CELL = /^(?:27|0)([6-8]\d{8})$/;

/** "082 123 4567", "+27 82 123 4567", "27821234567" → "0821234567"; anything else → null. */
export function cellOf(text) {
  const raw = String(text || '').trim();
  if (!/^\+?[\d\s().-]{9,18}$/.test(raw)) return null;
  const m = compact(raw).match(SA_CELL);
  return m ? `0${m[1]}` : null;
}

/** The one cell number in a sentence ("my number is 082 123 4567"), when it is the only number there. */
function cellIn(text) {
  const runs = String(text || '').match(/\+?\d(?:[\d\s().-]*\d)?/g) || [];
  if (runs.length !== 1) return null;
  return cellOf(runs[0]);
}

/** A number typed where a cell number goes that is not one: too short, too long, a landline, another country. */
function badCell(text) {
  const raw = String(text || '').trim();
  if (!/^\+?[\d\s().-]+$/.test(raw)) return false;
  const digits = compact(raw);
  if (digits.length < 9 || digits.length > 12 || SA_CELL.test(digits)) return false;
  return raw.startsWith('+') || /^(0|27)/.test(digits);
}

// Eight-letter English words that start with "pr": typed on their own they are words, not pay codes.
const PR_WORDS = new Set(['practice', 'prepared', 'presence', 'presents', 'preserve', 'pressing', 'pressure', 'previous', 'princess', 'printing', 'priority', 'prisoner', 'probably', 'problems', 'proceeds', 'produced', 'producer', 'products', 'profiles', 'programs', 'progress', 'projects', 'promised', 'promises', 'promoted', 'properly', 'property', 'proposal', 'proposed', 'prospect', 'protocol', 'provided', 'provider', 'province']);

/**
 * A pay link or its code: pleasepayme.co.za/PRXXXXXX, wa-pay.me/PRXXXXXX, /pay/PRXXXXXX; the
 * code in capitals anywhere in the line ("pay PRDEMOEF"); or the code alone in any case, as a
 * phone keyboard types it ("Prdemoef"), unless it is an ordinary word.
 */
export function payLinkCodeOf(text) {
  const raw = String(text || '').trim();
  const inUrl = raw.match(/(?:pleasepayme\.co\.za|wa-pay\.me|\/pay)\/(PR[A-Za-z]{6})(?![A-Za-z])/i);
  if (inUrl) return inUrl[1].toUpperCase();
  const capitals = raw.match(/(?:^|[^A-Za-z])(PR[A-Z]{6})(?![A-Za-z])/);
  if (capitals && !PR_WORDS.has(capitals[1].toLowerCase())) return capitals[1];
  const alone = raw.match(/^(pr[a-z]{6})[.!?]?$/i);
  return alone && !PR_WORDS.has(alone[1].toLowerCase()) ? alone[1].toUpperCase() : null;
}

/**
 * A return address after log-in: one of the app's own pages, or the landing screen. Anything
 * else (another site, a script, a path that climbs out, the log-in page itself) is the landing screen.
 */
export function safeNext(next) {
  const ok = typeof next === 'string' && /^\/app(\/[a-z0-9-]*)?(\?[\w=&%.-]*)?$/i.test(next);
  return ok && !/^\/app\/login(\?|$)/i.test(next) ? next : '/app';
}

// Words that say a number in the line is an amount, not a secret.
const AMOUNT_CUE = /\b(send|pay|paid|owes?|owing|link|request|invoice|top ?up|deposit|withdraw|out|for|buy|airtime|data|electricity|fees?|costs?|rands?|zar)\b/i;
// A PIN named in words, however it is glued or spaced: "pin2580", "my pin is 2 5 8 0".
const NAMED_PIN = /pin|pass ?code|password|otp/i;
const NAMED_NUMBER = /\b(acc|account|card|id|passport|bank)\b/i;
const CELL_AT_START = /^(?:27|0)[6-8]\d{8}/;
const CELL_AT_END = /(?:27|0)[6-8]\d{8}$/;

/** A run of digits with any cell number at either end taken off: what is left is judged on its own. */
function withoutCell(digits) {
  if (SA_CELL.test(digits)) return '';
  if (CELL_AT_START.test(digits)) return digits.replace(CELL_AT_START, '');
  if (CELL_AT_END.test(digits)) return digits.replace(CELL_AT_END, '');
  return digits;
}

/**
 * Is this line a secret the message box must not take? It errs on the side of yes: a bare
 * four to six digits is read as a PIN even when the person meant an amount.
 * @returns {'pin'|'id'|'digits'|null}
 */
export function secretKind(text) {
  const raw = String(text || '').normalize('NFKC').trim();
  if (!raw) return null;
  // Digits of another script (full-width ones were just folded to 0-9): never guessed at.
  if (/\p{Nd}/u.test(raw.replace(/[0-9]/g, ''))) return 'digits';
  // The whole line is digits once spaces and punctuation go: a cell number, an amount under four digits, or a secret.
  const core = raw.replace(/[^A-Za-z0-9]/g, '');
  if (/^\d+$/.test(core)) {
    if (SA_CELL.test(core)) return null;
    if (/^\d{4,6}$/.test(core)) return 'pin';
    if (core.length === 13) return 'id';
    return core.length >= 7 ? 'digits' : null;
  }
  // A sentence. Amounts written with an R are amounts; every other run of digits is weighed.
  const body = raw.replace(/\br\s?\d[\d ,]*(?:[.,]\d{1,2})?(?!\d)/gi, ' ');
  const runs = (body.match(/\d(?:[\d\s.\-/]*\d)?/g) || []).map((run) => withoutCell(run.replace(/\D/g, ''))).filter(Boolean);
  if (NAMED_PIN.test(body) && runs.join('').length >= 4) return 'pin';
  if (/\b[A-Za-z]{1,2}\d{6,9}\b/.test(body)) return 'id';
  for (const digits of runs) {
    if (digits.length === 13) return 'id';
    if (digits.length >= 7) return 'digits';
    if (digits.length >= 4 && (NAMED_NUMBER.test(body) || !AMOUNT_CUE.test(body))) return NAMED_NUMBER.test(body) ? 'digits' : 'pin';
  }
  return null;
}

const norm = (text) => String(text || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

const HELLO = /^(hi|hello|hallo|hey|heita|howzit|sawubona|sanibonani|molo|molweni|dumela|dumelang)\b/;
const THANKS = /^(thanks|thank you|thx|ta|dankie|ngiyabonga|enkosi|kea leboha)\b/;
// Back to the start: the thread is cleared and an open log-in step is closed.
const HOME = /^(home|menu|main menu|back|cancel|start|start again|start over|clear|close)$/;
// Asked by anyone, signed in or not, before anything else is read into the line.
const FORGOT_PIN = /\b(forgot|forget|forgotten|lost|reset)\b.*\bpin\b|\bpin\b.*\b(forgot|forgotten|lost|reset)\b/;
// Something is wrong, or the person wants a person. "no problem" and "problem solved" are not trouble.
const TROUBLE = /\b(wrong|error|not working|stuck|complain|complaint|fraud|scammed|stolen|stole|hacked|refund|dispute|unauthori[sz]ed|charged twice|did ?n[o']?t make|nothing happened|not showing|did ?n[o']?t go through|failed|declined|human|agent|real person|(close|delete) (my )?account)\b|\b(talk|speak|chat) (to|with)\b/;
const PROBLEM = /\b(problem|issue)s?\b/;
const NOT_A_PROBLEM = /\bno (problem|issue)s?\b|\b(solved|fixed|sorted|resolved)\b|\bissue (a|the|me|my)\b/;
const inTrouble = (t) => TROUBLE.test(t) || (PROBLEM.test(t) && !NOT_A_PROBLEM.test(t));
const PAY_A_LINK = /\bpay\b.*\blinks?\b|\b(i have|i got|i was sent|i received|sent me|someone sent)\b.*\blinks?\b/;
const PAYOUT_WORDS = /\b(pay ?outs?|payouts?|withdraw(al)?s?|cash ?out|money out|get (my )?money|to my bank|atm)\b/;
const FEE_WORDS = /\b(fees?|costs?|charges?|price|pricing|free)\b/;
const STATUS_WORDS = /\b(where is|where's|wheres|status|late|pending|still waiting|waiting for|when will|not received|not arrived|has ?n[o']?t arrived|did ?n[o']?t arrive|arrived?|received?|landed|came in|went out|paid yet)\b/;

// A question about WaPay itself. "What is the weather" is not one, and gets the plain fallback.
const HOW_IT_WORKS = /\bhow (?:does|do|did) (?:wapay|it|this|you) work\b|\bhow (?:do i|to) use\b/;
const ABOUT = /^(?:wapay|explain)$|\b(what|who|about|explain|tell me)\b.*\bwapay\b|\bwhat(?: is|'s|s) (?:this|it)\b|\bwhat can (?:i|you) do\b|\bwho are you\b|\bhow does (?:it|this) work\b/;

const VAS = [
  ['AIRTIME', /\bairtime\b/],
  ['DATA', /\bdata\b|\bbundles?\b/],
  ['ELECTRICITY', /\belectric(ity)?\b|\bprepaid\b|\bmeter\b/],
  ['FUEL', /\bfuel\b|\bpetrol\b|\bdiesel\b/],
  ['OTT_SELF', /\bvouchers?\b/],
];

// A member's everyday words, first match wins. The order settles the overlaps:
// a balance question before a status question ("where is my money" is the balance);
// a status question before any action ("where is my pay out" must not open a second pay-out);
// "who paid" before "pay me"; "make a link" before the list of links;
// "pay out" before "request" ("request a pay out"); a bare "pay ..." last of all means paying a person.
const MEMBER = [
  [{ kind: 'logout' }, /\b(log ?out|sign ?out)\b/],
  [{ kind: 'card', card: 'balance' }, /\b(balance|bal|how much( money)? (do i have|have i|is in)|where is my money|available)\b/],
  [{ kind: 'card', card: 'recent' }, STATUS_WORDS],
  [{ kind: 'card', card: 'recent' }, /\b(recent|activity|transactions?|history|statement)\b/],
  [{ kind: 'card', card: 'links' }, /\b(who (has )?paid|paid me|been paid|(did|has|have) \w+ (pay|paid))\b/],
  [{ kind: 'page', href: '/app/pay-out' }, PAYOUT_WORDS],
  [{ kind: 'page', href: '/app/get-paid' }, /\b(get paid|please pay me|pay me|owes? me|invoice|request|(make|new|create|another|issue) (a )?(payment )?link)\b/],
  [{ kind: 'card', card: 'links' }, /\blinks?\b/],
  [{ kind: 'page', href: '/app/top-up' }, /\b(top ?up|deposit|add money|load money)\b/],
  [{ kind: 'page', href: '/app/send' }, /\b(send|transfer|pay)\b/],
  [{ kind: 'page', href: '/app/profile' }, /\b(profile|change (my )?pin|my details|verify|id check|invite|refer)\b/],
  [{ kind: 'page', href: '/app/help' }, /\b(help|support|contact)\b/],
];

const AD_TOPIC = {
  Q2: 'how', HOW: 'how', Q3: 'fees', COST: 'fees', Q4: 'about',
  FAQ_PAY_ME_HOW: 'payMethods', FAQ_MONEY_OUT: 'moneyOut', FAQ_CASH_IN: 'cashIn', FAQ_VAS: 'vas', FAQ_PAY_SOMEONE: 'paySomeone',
  PAYOUT_BANK: 'moneyOut', PAYOUT_NEDBANK: 'moneyOut', PAYOUT_ABSA: 'moneyOut',
};

/**
 * What a typed line means.
 *
 * @param {string} text
 * @param {{ authed?: boolean }} [who]
 * @returns {{ kind: 'empty' }
 *   | { kind: 'secret', reason: 'pin'|'id'|'digits' }
 *   | { kind: 'badcell' }
 *   | { kind: 'paylink', code: string }
 *   | { kind: 'cell', cell: string }
 *   | { kind: 'page', href: string }
 *   | { kind: 'card', card: 'balance'|'recent'|'links' }
 *   | { kind: 'answer', topic: string }
 *   | { kind: 'vas', product: string }
 *   | { kind: 'open' } | { kind: 'login' } | { kind: 'logout' } | { kind: 'paylink-ask' } | { kind: 'support' }
 *   | { kind: 'home' } | { kind: 'greet' } | { kind: 'thanks' } | { kind: 'unknown' }}
 */
export function routeMessage(text, { authed = false } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { kind: 'empty' };
  // A number typed where a cell number goes, but not one: said so plainly, not scolded as a secret.
  if (badCell(raw)) return { kind: 'badcell' };
  // A pay link's own address may carry digits; anything typed beside it is still weighed.
  const code = payLinkCodeOf(raw);
  const reason = secretKind(code ? raw.replace(/\S*(?:pleasepayme\.co\.za|wa-pay\.me|\/pay)\/PR[A-Za-z]{6}\S*/i, ' ') : raw);
  if (reason) return { kind: 'secret', reason };
  if (code) return { kind: 'paylink', code };
  const cell = cellOf(raw) || cellIn(raw);
  const t = norm(raw);
  if (HOME.test(t)) return { kind: 'home' };
  // The reset screen is open to anyone and asks for the ID number in its own field.
  if (FORGOT_PIN.test(t)) return { kind: 'page', href: '/app/forgot-pin' };
  if (matchLoanAsk(raw)) return { kind: 'answer', topic: 'loans' };

  if (authed) {
    if (inTrouble(t)) return { kind: 'page', href: '/app/help' };
    if (PAY_A_LINK.test(t)) return { kind: 'paylink-ask' };
    // "How do people pay me?" is a question about ways to pay, not a request for a new link.
    if (classifyAdEntry(raw) === 'FAQ_PAY_ME_HOW') return { kind: 'answer', topic: 'payMethods' };
    if (FEE_WORDS.test(t)) return { kind: 'answer', topic: PAYOUT_WORDS.test(t) ? 'feesPayout' : /\b(top ?up|deposit|add money)\b/.test(t) ? 'feesTopup' : 'fees' };
    for (const [product, re] of VAS) if (re.test(t)) return { kind: 'vas', product };
    for (const [out, re] of MEMBER) if (re.test(t)) return { ...out };
    // A member who types only a number wants to pay that person: the Send screen asks for it properly.
    if (cell) return { kind: 'page', href: '/app/send' };
    if (THANKS.test(t)) return { kind: 'thanks' };
    if (HELLO.test(t)) return { kind: 'greet' };
    const asked = AD_TOPIC[classifyAdEntry(raw)];
    if (asked) return { kind: 'answer', topic: asked };
    if (HOW_IT_WORKS.test(t)) return { kind: 'answer', topic: 'how' };
    return ABOUT.test(t) ? { kind: 'answer', topic: 'about' } : { kind: 'unknown' };
  }

  if (cell) return { kind: 'cell', cell };
  if (PAY_A_LINK.test(t)) return { kind: 'paylink-ask' };
  // A person, or trouble: the support address, said on this screen.
  if (inTrouble(t) || /\b(support|contact)\b/.test(t)) return { kind: 'support' };
  // Opening an account is read before logging in: "open my account" is not "my account".
  const ad = classifyAdEntry(raw);
  if (ad === 'Q1' || ad === 'OPEN' || /\b(sign ?up|register|join)\b|\b(do ?n[o']?t|no|without) (have )?(an )?account\b/.test(t)) return { kind: 'open' };
  if (/\b(log ?in|login|sign ?in|(have|got) an account|already (a member|have)|my balance|where is my money)\b/.test(t)) return { kind: 'login' };
  if (AD_TOPIC[ad]) return { kind: 'answer', topic: AD_TOPIC[ad] };
  if (/\bfree\b/.test(t)) return { kind: 'answer', topic: 'fees' };
  if (HOW_IT_WORKS.test(t)) return { kind: 'answer', topic: 'how' };
  if (ABOUT.test(t)) return { kind: 'answer', topic: 'about' };
  if (HELLO.test(t) || /^help\b/.test(t)) return { kind: 'greet' };
  if (THANKS.test(t)) return { kind: 'thanks' };
  return { kind: 'unknown' };
}

/** "Good morning" by South African time: morning 05:00 to 11:59, afternoon 12:00 to 17:59, evening otherwise. */
export function greetingFor(date = new Date(), firstName = null) {
  const hour = (new Date(date).getUTCHours() + 2) % 24;
  const part = hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 18 ? 'Good afternoon' : 'Good evening';
  const name = String(firstName || '').trim();
  return name ? `${part}, ${name}` : part;
}
