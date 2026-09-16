/**
 * Agent guards (v1.4 agent, 2026-09-16): the two deterministic fences around
 * the model, per docs/AGENT_ARCHITECTURE_V2.md C4 (guard list) and C11
 * (output gates).
 *
 *   agentGuard(text)  -> the pre-model answers that must never reach the
 *                        model: a 16-digit voucher PIN, a "Pay request PR..."
 *                        deep-link code, a "voucher pin <serial tail>" resend.
 *                        The patterns are copied from the processor
 *                        (message-processor-v2.js detectExplicitIntent,
 *                        PAY_REQUEST_CODE_PATTERN and the resend short-circuit)
 *                        so the agent path and the regex path agree.
 *   outputGate(text)  -> the post-model checks on the composed reply: the
 *                        betting lexicon (Meta policy, WABA-existential), the
 *                        pay-out partner name while cash-out is not live for
 *                        this customer, off-domain links, dashes, length.
 *
 * Pure functions, no DB, no model client. A blocked reply is the caller's
 * cue to degrade to a fact line, never to silence.
 */

// --- Pre-model guards ------------------------------------------------------

// message-processor-v2.js:2294
export const PAY_REQUEST_CODE_PATTERN = /\bpay\s+request\s+(PR[A-HJKMNP-Z]{6})\b/i;

// message-processor-v2.js:1521 ("voucher pin <serial tail>", PIN-gated resend)
export const VOUCHER_PIN_RESEND_PATTERN = /^voucher\s+pin\s+(\d{4,20})$/i;

/**
 * The only pre-model answers, in the processor's order: the resend ask
 * (a literal "voucher pin" prefix), then a pay-request code anywhere in the
 * text, then a bare 16-digit voucher PIN after stripping every separator
 * (detectExplicitIntent: `text.replace(/[^\d]/g, '')` then /^\d{16}$/).
 *
 * @param {string} text
 * @returns {{kind:'VOUCHER_PIN', pin:string}
 *         | {kind:'PAY_REQUEST_CODE', code:string}
 *         | {kind:'VOUCHER_PIN_RESEND', tail:string}
 *         | null}
 */
export function agentGuard(text) {
  if (typeof text !== 'string' || !text) return null;

  const resendMatch = text.trim().match(VOUCHER_PIN_RESEND_PATTERN);
  if (resendMatch) return { kind: 'VOUCHER_PIN_RESEND', tail: resendMatch[1] };

  const payReqMatch = text.match(PAY_REQUEST_CODE_PATTERN);
  if (payReqMatch) return { kind: 'PAY_REQUEST_CODE', code: payReqMatch[1].toUpperCase() };

  const digitsOnly = text.replace(/[^\d]/g, '');
  if (/^\d{16}$/.test(digitsOnly)) return { kind: 'VOUCHER_PIN', pin: digitsOnly };
  // A bare 12-digit OTT PIN: twelve digits, or three groups of four. A
  // sentence with an amount and a phone number also has 12 digits and is
  // not a PIN; nor is a phone number followed by a number.
  if (/^\d{4}[\s-]?\d{4}[\s-]?\d{4}$/.test(text.trim())) return { kind: 'VOUCHER_PIN', pin: digitsOnly };

  return null;
}

// --- Output gates ----------------------------------------------------------

/** Betting and gambling words the bot may never send (Meta gambling policy). */
export const BETTING_LEXICON = [
  'bet', 'bets', 'betting',
  'wager', 'wagers', 'wagering',
  'casino', 'casinos',
  'odds',
  'gamble', 'gambles', 'gambling', 'gambler', 'gamblers',
  'lotto', 'lottery', 'powerball',
  'sportsbook', 'bookmaker', 'bookmakers', 'bookie', 'bookies',
  'punt', 'punts', 'punting', 'punter', 'punters',
  'hollywoodbets', 'betway', 'supabets', 'sportingbet', 'lottostar',
];

const BETTING_RE = new RegExp(`\\b(?:${BETTING_LEXICON.join('|')})\\b`, 'i');

/** Hosts a reply may link to; any subdomain of these is fine too. */
export const ALLOWED_URL_HOSTS = ['wapay.co.za', 'pleasepayme.co.za'];

const URL_RE = /https?:\/\/[^\s<>"'()[\]]+/gi;

// The partner name as a standalone word, but not the product name
// "OTT voucher(s)", which is allowed always.
const PARTNER_WORD_RE = /\bO[\s.]?T[\s.]?T\b\.?(?![\s-]*vouchers?\b)/gi;
// Pay-out language that, near the partner name, would leak the rail before
// cash-out is live for this customer.
const PAYOUT_WORD_RE = /\b(?:pay-?\s?outs?|payshap|cash-?\s?outs?|withdraw(?:al|als|s|ing|n)?)\b/i;
const PARTNER_WINDOW = 40;

export const MAX_REPLY_CHARS = 1500;

const hostAllowed = (host) =>
  ALLOWED_URL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

function hasOffDomainUrl(text) {
  for (const m of text.matchAll(URL_RE)) {
    // Strip trailing punctuation a sentence leaves on a link.
    const raw = m[0].replace(/[.,;:!?]+$/, '');
    let host;
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      return true; // a thing that looks like a link but does not parse: block
    }
    if (!hostAllowed(host)) return true;
  }
  return false;
}

function leaksPartner(text) {
  for (const m of text.matchAll(PARTNER_WORD_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    const after = text.slice(end, end + PARTNER_WINDOW);
    const before = text.slice(Math.max(0, start - PARTNER_WINDOW), start);
    if (PAYOUT_WORD_RE.test(after) || PAYOUT_WORD_RE.test(before)) return true;
  }
  return false;
}

/** Em and en dashes become ', ' (the constitution forbids dashes in copy). */
export function rewriteDashes(text) {
  if (!/[–—]/.test(text)) return text;
  return text
    .replace(/[ \t]*[–—]+[ \t]*/g, ', ')
    .replace(/^, /gm, '')
    .replace(/, $/gm, '');
}

/**
 * Checks a composed reply before it is sent. Rules run in this order and the
 * first block wins: BETTING, PARTNER (only while withdrawLive is false), URL,
 * DASH_REWRITE (ok stays true, text rewritten), LENGTH.
 *
 * @param {string} text
 * @param {{ withdrawLive?: boolean }} [opts]
 * @returns {{ ok: boolean, rule: string|null, text: string }}
 */
export function outputGate(text, { withdrawLive = false } = {}) {
  const input = typeof text === 'string' ? text : '';

  if (BETTING_RE.test(input)) return { ok: false, rule: 'BETTING', text: input };
  if (!withdrawLive && leaksPartner(input)) return { ok: false, rule: 'PARTNER', text: input };
  if (hasOffDomainUrl(input)) return { ok: false, rule: 'URL', text: input };

  const rewritten = rewriteDashes(input);
  if (rewritten.length > MAX_REPLY_CHARS) return { ok: false, rule: 'LENGTH', text: rewritten };

  if (rewritten !== input) return { ok: true, rule: 'DASH_REWRITE', text: rewritten };
  return { ok: true, rule: null, text: input };
}
