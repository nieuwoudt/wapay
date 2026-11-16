/**
 * What a payment link is for (founder, 2026-10-24): "the customer has to put
 * in a description of the payment request they send and create for the
 * payee". Every new personal link carries one, and the payer reads it on the
 * forwarded message, the reminder and the pay page.
 *
 * The description is shown to a third party, so it is cleaned before it is
 * stored and refused when it could mislead the person paying:
 *   - WhatsApp markdown, newlines, control and invisible characters go;
 *   - a website, a link or an e-mail address is refused (a description must
 *     never send the payer anywhere but the pay page);
 *   - a phone or account number is refused (a run of 7 or more digits);
 *   - wording that reads as WaPay or an authority is refused, the way
 *     `safeRequesterLabel` in the processor treats a requester's name
 *     ("WaPay", "support", "admin", "official"), plus "SARS" and "helpdesk",
 *     also when spaced or written with lookalike letters ("W a P a y", "5ARS");
 *     "child support" is allowed, it is what maintenance is called;
 *   - more than DESCRIPTION_MAX characters is refused, never cut mid-word.
 * The customer is told plainly why (`descriptionRefusal`).
 *
 * Pure and browser-safe (no imports): the web app runs the same check before
 * the PIN step, and the server runs it again before a link is created.
 */

export const DESCRIPTION_MAX = 60;

// Control characters and line separators become spaces; zero-width, bidi and soft-hyphen characters
// vanish, so "a<zero-width space>dmin" reads as "admin" to the check exactly as it would to the payer.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
// WhatsApp formatting (*bold* _italic_ ~strike~ `code` > quote) and markup characters.
const FORMATTING = /[*_~`<>\\]/g;

const TLDS = [
  'com', 'net', 'org', 'info', 'biz', 'co', 'za', 'io', 'me', 'ly', 'app', 'link', 'site', 'online', 'xyz', 'top', 'club', 'shop',
  'store', 'africa', 'gov', 'edu', 'page', 'dev', 'ai', 'tk', 'ml', 'ga', 'cf', 'gq', 'ru', 'cn', 'uk', 'us', 'de', 'nl', 'fr', 'tv',
  'cc', 'ws', 'gg', 'in', 'ng', 'ke', 'zw', 'bw', 'na', 'click', 'live', 'win', 'vip', 'pro', 'mobi', 'money', 'cash', 'pay', 'bank',
  'finance', 'loan', 'email', 'example', 'tech', 'website', 'space', 'fun', 'icu', 'cyou', 'buzz', 'cam', 'bond', 'sbs', 'cfd', 'lat',
  'help', 'support', 'services', 'center', 'cloud', 'digital', 'network', 'world', 'trade', 'news', 'blog', 'media', 'one', 'global',
  'group', 'agency', 'company', 'ltd', 'inc',
].join('|');
// A scheme, www., wa.me, an e-mail address, a domain on a known ending, or "dot com" spelled out.
const LINKISH = new RegExp(`https?:|\\bwww\\.|\\bwa\\.me\\b|[a-z0-9._%+-]@[a-z0-9-]+\\.[a-z]|\\b[a-z0-9][a-z0-9-]*\\.(?:${TLDS})\\b|\\bdot\\s+(?:${TLDS})\\b`, 'i');
// Dates are not account numbers: 2026-10-24, 24/10/2026, 24.10.2026.
const DATES = /(?<!\d)(?:(?:19|20)\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])|(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.](?:19|20)\d{2})(?!\d)/g;
// Seven or more digits, spaces, dots or dashes between them allowed: a phone, account or ID number.
const LONG_DIGITS = /\d(?:[\s.-]?\d){6,}/;
// Wording that reads as WaPay or an authority. Checked on the text and on a lookalike-folded copy.
const IMPERSONATION = /\b(?:w\s*a\s*-?\s*p\s*a\s*y|s\s*a\s*r\s*s|support|admin|administrator|official|officials|officially|help\s*-?\s*desk)\b/i;
const ALLOWED_PHRASES = /\bchild\s+support\b/gi;
// Words that answer "who" or nothing at all, never "what for" ("please pay me R100 for someone").
const NOT_A_DESCRIPTION = /^(?:someone|somebody|anyone|anybody|me|you|him|her|them|us|my friend|a friend|a person|people|for|nothing|none|no|nope|skip|n\/?a|idk|dunno|i don'?t know|not sure|whatever|anything|stuff|money|payment|a payment|the payment|request|link|now|today)$/i;
// Cyrillic and digit lookalikes, the same idea as the business-name check in lib/business.js.
const CONFUSABLES = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'к': 'k', 'і': 'i', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ј': 'j', 'ӏ': 'l', 'ԝ': 'w', 'ɑ': 'a', '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

function fold(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split('')
    .map((ch) => CONFUSABLES[ch] || ch)
    .join('')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Text that a third party will read, made plain: control characters and
 * newlines become spaces, invisible characters vanish, WhatsApp formatting
 * goes, whitespace collapses. Used for descriptions and for the requester's
 * name on the forwarded card.
 */
export function plainText(raw) {
  return String(raw ?? '').normalize('NFKC').replace(CONTROLS, ' ').replace(INVISIBLE, '').replace(FORMATTING, '').replace(/\s+/g, ' ').trim();
}

/**
 * The text as the payer would read it, before any refusal: invisible and
 * formatting characters removed, whitespace collapsed, wrapping quotes, a
 * leading "for" ("for braids" answers "what is it for?") and a trailing
 * "please" or "thanks" dropped. Never throws; '' for nothing.
 */
export function cleanDescription(raw) {
  let t = plainText(raw);
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  t = t.replace(/^(?:(?:it'?s|it is|its|this is|that'?s|that is|the money is|money)\s+)?for\s*[:-]?\s+/i, '');
  t = t.replace(/^(?:description|reason|re)\s*[:-]\s*/i, '');
  t = t.replace(/[\s,;:-]*\b(?:please|pls|plz|thanks|thank you|thx|asseblief|asb|ngiyabonga|enkosi)\b[\s.!,;:]*$/i, '');
  t = t.replace(/[\s.,;:!-]+$/, '').trim();
  return t;
}

/**
 * Check a description before it goes on a link.
 * @returns {{ ok: true, text: string } | { ok: false, reason: 'EMPTY'|'LINK'|'NUMBER'|'IMPERSONATION'|'TOO_LONG' }}
 */
export function sanitizeLinkDescription(raw) {
  const text = cleanDescription(raw);
  if (!text || !/\p{L}[^\p{L}]*\p{L}/u.test(text) || NOT_A_DESCRIPTION.test(text)) return { ok: false, reason: 'EMPTY' };
  if (LINKISH.test(text)) return { ok: false, reason: 'LINK' };
  if (LONG_DIGITS.test(text.replace(DATES, ' '))) return { ok: false, reason: 'NUMBER' };
  const checked = text.replace(ALLOWED_PHRASES, ' ');
  if (IMPERSONATION.test(checked) || IMPERSONATION.test(fold(checked))) return { ok: false, reason: 'IMPERSONATION' };
  if (text.length > DESCRIPTION_MAX) return { ok: false, reason: 'TOO_LONG' };
  return { ok: true, text };
}

/** Why a description was refused, in one plain sentence (chat and web). */
export function descriptionRefusal(reason) {
  switch (reason) {
    case 'LINK': return "A description can't carry a website, a link or an e-mail address.";
    case 'NUMBER': return "A description can't carry a phone or account number.";
    case 'IMPERSONATION': return "A description can't use words like WaPay, SARS, support, admin or official, so nobody mistakes it for an official message.";
    case 'TOO_LONG': return `That is too long for a link: ${DESCRIPTION_MAX} characters at most.`;
    default: return 'Say what the payment is for in a few words, like braids or rent.';
  }
}

/** Two descriptions that say the same thing ("Braids" and "braids."). */
export function sameDescription(a, b) {
  const n = (s) => cleanDescription(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return n(a) === n(b);
}
