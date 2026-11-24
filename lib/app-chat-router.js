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
import { classifyAdEntry } from './ad-flow.js';

export const SECRET_LINE = 'That looks like a PIN, an ID number or an account number. Never type one in this box. WaPay asks for your PIN only in the PIN boxes, when you confirm something. Nothing was sent.';

const compact = (s) => String(s || '').replace(/[\s().+-]/g, '');
const SA_CELL = /^(?:27|0)([6-8]\d{8})$/;

/** "082 123 4567", "+27 82 123 4567", "27821234567" → "0821234567"; anything else → null. */
export function cellOf(text) {
  const raw = String(text || '').trim();
  if (!/^\+?[\d\s().-]{9,18}$/.test(raw)) return null;
  const m = compact(raw).match(SA_CELL);
  return m ? `0${m[1]}` : null;
}

/**
 * A pay link or its code: pleasepayme.co.za/PRXXXXXX, wa-pay.me/PRXXXXXX, /pay/PRXXXXXX, or the
 * bare code in capitals. Lower-case eight-letter words that start with "pr" are words, not codes.
 */
export function payLinkCodeOf(text) {
  const raw = String(text || '').trim();
  const inUrl = raw.match(/(?:pleasepayme\.co\.za|wa-pay\.me|\/pay)\/(PR[A-Za-z]{6})(?![A-Za-z])/i);
  if (inUrl) return inUrl[1].toUpperCase();
  const bare = raw.match(/^(PR[A-Z]{6})$/);
  return bare ? bare[1] : null;
}

/**
 * Is this line a secret the message box must not take?
 * @returns {'pin'|'id'|'digits'|null}
 */
export function secretKind(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const all = compact(raw);
  if (/^\d+$/.test(all)) {
    if (SA_CELL.test(all)) return null;
    if (/^\d{4,6}$/.test(all)) return 'pin';
    if (all.length === 13) return 'id';
    return all.length >= 7 ? 'digits' : null;
  }
  if (/\bpin\b/i.test(raw) && /\d{4,6}/.test(raw)) return 'pin';
  if (/\b[A-Z]{1,2}\d{6,9}\b/.test(raw)) return 'id';
  for (const run of raw.match(/\+?\d(?:[\d\s-]*\d)?/g) || []) {
    const digits = compact(run);
    if (digits.length < 7 || SA_CELL.test(digits)) continue;
    return digits.length === 13 ? 'id' : 'digits';
  }
  return null;
}

const norm = (text) => String(text || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

const VAS = [
  ['AIRTIME', /\bairtime\b/],
  ['DATA', /\bdata\b|\bbundles?\b/],
  ['ELECTRICITY', /\belectric(ity)?\b|\bprepaid\b|\bmeter\b/],
  ['FUEL', /\bfuel\b|\bpetrol\b|\bdiesel\b/],
  ['OTT_SELF', /\bvouchers?\b/],
];

// A member's everyday words, first match wins. The order settles the overlaps:
// "how much does it cost" is a fee question before it is a balance question;
// "make a link" is getting paid before "links" is the list.
const MEMBER = [
  [{ kind: 'logout' }, /\b(log ?out|sign ?out)\b/],
  [{ kind: 'answer', topic: 'fees' }, /\b(fees?|costs?|charges?|price|pricing)\b/],
  [{ kind: 'card', card: 'balance' }, /\b(balance|how much (do i have|have i|is in)|my money|available)\b/],
  [{ kind: 'card', card: 'recent' }, /\b(recent|activity|transactions?|history|statement|came in|went out)\b/],
  [{ kind: 'page', href: '/app/get-paid' }, /\b(get paid|please pay me|pay me|owes? me|invoice|request|(make|new|create|another) (a )?(payment )?link)\b/],
  [{ kind: 'card', card: 'links' }, /\b(links?|who (has )?paid)\b/],
  [{ kind: 'page', href: '/app/pay-out' }, /\b(pay ?out|payout|withdraw|cash ?out|money out|to my bank|atm)\b/],
  [{ kind: 'page', href: '/app/top-up' }, /\b(top ?up|deposit|add money|load money)\b/],
  [{ kind: 'page', href: '/app/send' }, /\b(send|pay (someone|somebody|a friend|another)|transfer)\b/],
  [{ kind: 'page', href: '/app/profile' }, /\b(profile|change (my )?pin|my details|verify|id check|invite|refer)\b/],
  [{ kind: 'page', href: '/app/help' }, /\b(help|support|contact|problem|stuck)\b/],
  [{ kind: 'greet' }, /^(hi|hello|hey|howzit|sawubona|molo|dumela|home|menu|start)\b/],
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
 *   | { kind: 'paylink', code: string }
 *   | { kind: 'cell', cell: string }
 *   | { kind: 'page', href: string }
 *   | { kind: 'card', card: 'balance'|'recent'|'links' }
 *   | { kind: 'answer', topic: string }
 *   | { kind: 'vas', product: string }
 *   | { kind: 'open' } | { kind: 'login' } | { kind: 'logout' } | { kind: 'paylink-ask' } | { kind: 'greet' } | { kind: 'unknown' }}
 */
export function routeMessage(text, { authed = false } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { kind: 'empty' };
  const reason = secretKind(raw);
  if (reason) return { kind: 'secret', reason };
  const code = payLinkCodeOf(raw);
  if (code) return { kind: 'paylink', code };
  const cell = cellOf(raw);
  const t = norm(raw);

  if (authed) {
    // A member who types a number wants to pay that person: the Send screen asks for it properly.
    if (cell) return { kind: 'page', href: '/app/send' };
    for (const [product, re] of VAS) if (re.test(t)) return { kind: 'vas', product };
    for (const [out, re] of MEMBER) if (re.test(t)) return { ...out };
    return { kind: 'unknown' };
  }

  if (cell) return { kind: 'cell', cell };
  if (/\b(log ?in|login|sign ?in)\b/.test(t)) return { kind: 'login' };
  if (/\bpay\b.*\blink\b|\blink\b.*\bpay\b/.test(t)) return { kind: 'paylink-ask' };
  const ad = classifyAdEntry(raw);
  if (ad === 'Q1' || ad === 'OPEN') return { kind: 'open' };
  if (AD_TOPIC[ad]) return { kind: 'answer', topic: AD_TOPIC[ad] };
  if (/\b(what is|what's|whats|wapay|how does (it|this) work|explain)\b/.test(t)) return { kind: 'answer', topic: 'about' };
  if (/^(hi|hello|hey|howzit|sawubona|molo|dumela|help|menu|start)\b/.test(t)) return { kind: 'greet' };
  return { kind: 'unknown' };
}

/** "Good morning" by South African time: morning 05:00 to 11:59, afternoon 12:00 to 17:59, evening otherwise. */
export function greetingFor(date = new Date(), firstName = null) {
  const hour = (new Date(date).getUTCHours() + 2) % 24;
  const part = hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 18 ? 'Good afternoon' : 'Good evening';
  const name = String(firstName || '').trim();
  return name ? `${part}, ${name}` : part;
}
