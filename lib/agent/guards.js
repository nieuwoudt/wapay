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
 *                        this customer, off-domain links, a request for the
 *                        wallet PIN, a pay-out claimed with none pending,
 *                        dashes, length.
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
/**
 * @param {string} text
 * @param {{ pendingIntent?: { action?: string } | null }} [opts] the clarify intent
 *   the agent parked last turn: when it asked for a METER, a bare 12-digit
 *   answer is the meter (SA prepaid meters are 11 to 13 digits), not a voucher
 *   PIN (review of 2026-10-06). The 16-digit rule always stands.
 */
// --- Launch scope (2026-10-18) ---------------------------------------------
// A purchase command for a product that is switched off ("buy airtime", "Buy
// fuel", a bare "data") is answered by the flow's own coming-soon reply before
// the model sees it: on launch day the Pay agent improvised "I can help you buy
// airtime" for the founder. Questions ("how much is airtime?") still go to the
// model, whose capability list names what is coming soon.
const CATEGORY_WORDS = {
  AIRTIME: /\b(airtime|lugtyd|umoya|phone credit|recharge)\b/i,
  DATA: /\b(data|bundles?|idatha|gigs?|\d+\s?(?:gb|mb))\b/i,
  ELECTRICITY: /\b(electricity|elektrisiteit|umbane|ugesi|mohlagase|motlakase|mudagasi|gezi|prepaid power|units|eskom)\b/i,
  FUEL: /\b(fuel|petrol|diesel)\b/i,
};
const WANTS = /\b(buy|purchase|get|want|need|load|top ?up|topup|recharge|koop|thenga|reka|renga|xava|tsenga|send)\b/i;
const BARE = /^(?:buy|koop|thenga|reka)?\s*(?:airtime|data|electricity|fuel|petrol|diesel|bundles?)\s*(?:please|asseblief)?$/i;
const NOT_A_COMMAND = /\?|\b(how|why|when|what|which|where|can i|could i|is it|do you|does|cost|costs|fee|fees|charge|price|cheap)\b/i;

// `scope` is the caller's launchScopeFor({ waId, account }) (lib/capabilities.js): the
// customer's switches with allowlists applied, plus wicodeLive for fuel. This module
// stays import-free (tests/agent-guards.test.mjs), so without a scope nothing is gated.
export function comingSoonCommand(text, { scope = null } = {}) {
  if (!scope) return null;
  const t = String(text || '').trim();
  if (!t || t.length > 100 || NOT_A_COMMAND.test(t)) return null;
  const bare = t.replace(/[^a-z0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!WANTS.test(t) && !BARE.test(bare)) return null;
  const live = { AIRTIME: !!scope.airtime, DATA: !!scope.data, ELECTRICITY: !!scope.electricity, FUEL: !!scope.wicodeLive };
  for (const [category, re] of Object.entries(CATEGORY_WORDS)) {
    if (!re.test(t)) continue;
    return live[category] ? null : { kind: 'COMING_SOON', category };
  }
  return null;
}

export function agentGuard(text, { pendingIntent = null, scope = null } = {}) {
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
  const awaitingMeter = String(pendingIntent?.action || '').toUpperCase() === 'BUY_ELECTRICITY';
  if (!awaitingMeter && /^\d{4}[\s-]?\d{4}[\s-]?\d{4}$/.test(text.trim())) return { kind: 'VOUCHER_PIN', pin: digitsOnly };

  const soon = comingSoonCommand(text, { scope });
  if (soon) return soon;

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

// The wallet PIN is typed only at a flow's own PIN step, so a model reply
// never asks for it; and a model never says a pay-out is under way unless the
// record has one pending (BUGLOG #111, Lisa 2026-10-15: "Now enter your WaPay
// PIN to confirm the payout", then "Your payout is being confirmed now", with
// nothing sent). A voucher's PIN is a different thing and may be asked for.
const PIN_ASK_RE = /^\W*(?:(?:now|next|then|please|kindly|just|ok(?:ay)?|great|thanks?|thank you|so)[\s,!.]+)*(?:enter|type|send|reply with|give me|share|provide|confirm with|use)\s+(?:me\s+)?(?:(?:your|the)\s+)?(?:wapay\s+|secret\s+|new\s+|\d(?:\s*(?:-|to)\s*\d)?[\s-]?digit\s+)*pin\b/i;
const PIN_QUESTION_RE = /\b(?:what(?:'s| is)\s+your\s+(?:wapay\s+)?pin|i need your\s+(?:wapay\s+)?pin|(?:can|could) you (?:enter|type|send) (?:your|the) (?:wapay\s+)?pin)\b/i;
const VOUCHER_PIN_CONTEXT_RE = /\b(?:vouchers?|1[26][\s-]?digit|blu|ott|wicode|meter|token)\b/i;
const PAYOUT_UNDER_WAY_RE = /\b(?:your\s+)?(?:R\s?[\d.,]+\s+)?(?:pay-?\s?outs?|withdrawals?|cash-?\s?outs?)\b[^.!?\n]{0,40}?\b(?:being\s+(?:confirmed|processed|sent|paid|approved|handled)|on (?:its|their|the) way|processing|in progress|going through|will (?:arrive|reflect|land|show|be (?:paid|sent)))\b|\b(?:money|funds|cash)\b[^.!?\n]{0,30}?\bon (?:its|the) way to your\b/i;
const CONDITIONAL_RE = /\b(?:once|when|after|if|as soon as)\b/i;

const sentencesOf = (text) => String(text).split(/(?<=[.!?\n])\s*/).filter(Boolean);

/** A reply that asks the customer for their wallet PIN (never a voucher's PIN). Pure. */
export function asksForWalletPin(text) {
  return sentencesOf(text).some((s) => (PIN_ASK_RE.test(s) || PIN_QUESTION_RE.test(s)) && !VOUCHER_PIN_CONTEXT_RE.test(s));
}

/** A reply that says a pay-out is under way ("is being confirmed", "on its way"); a "once you confirm" sentence is not. Pure. */
export function claimsPayoutUnderWay(text) {
  return sentencesOf(text).some((s) => PAYOUT_UNDER_WAY_RE.test(s) && !CONDITIONAL_RE.test(s));
}

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

/**
 * Lists become WhatsApp bullets (founder review 5, 2026-10-06: "any reply with
 * two or more items must be bullets, one item per bullet, never consecutive
 * plain lines"). Two rewrites, both mechanical and both reversible by eye:
 *   1. a markdown list marker at the start of a line ("- ", "* ", "– ", "• ")
 *      becomes "• " so WhatsApp shows a bullet instead of a dash;
 *   2. a run of two or more consecutive short lines that each carry a rand
 *      amount and are not already bullets, numbered steps or headers (the
 *      deal lists the review named) gets "• " in front of each line.
 * Prose is left alone: a line over 90 characters, a line ending in ":" "." "!" or
 * "?" and a line with no amount never qualify for rewrite 2.
 */
export function normaliseLists(text) {
  if (typeof text !== 'string' || !text) return text;
  const lines = text.split('\n');
  const out = lines.map((l) => l.replace(/^(\s*)(?:[-*\u2013\u2022]|\u25AA|\u25CF)\s+(?=\S)/, '$1\u2022 '));
  const isBullet = (l) => /^\s*(?:\u2022|\d{1,2}[.)]\s|[\u2460-\u2473]|\d\uFE0F?\u20E3)/.test(l);
  // A sentence (ends in . ! or ?) is prose even when it names a price: "Just say buy R10 airtime." stays a line.
  const priced = (l) => /\bR\s?\d/.test(l) && l.trim().length > 0 && l.trim().length <= 90 && !/[:：.!?]\s*$/.test(l) && !isBullet(l);
  let i = 0;
  while (i < out.length) {
    if (!priced(out[i])) { i += 1; continue; }
    let j = i;
    while (j < out.length && priced(out[j])) j += 1;
    if (j - i >= 2) for (let k = i; k < j; k += 1) out[k] = out[k].replace(/^(\s*)/, '$1\u2022 ');
    i = j;
  }
  return out.join('\n');
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
 * PIN_ASK (a model never asks for the wallet PIN), MONEY_CLAIM (a pay-out
 * said to be under way while the record has none pending), LIST_REWRITE then
 * DASH_REWRITE (ok stays true, text rewritten), LENGTH.
 *
 * @param {string} text
 * @param {{ withdrawLive?: boolean, payoutPending?: boolean }} [opts]
 * @returns {{ ok: boolean, rule: string|null, text: string }}
 */
export function outputGate(text, { withdrawLive = false, payoutPending = false } = {}) {
  const input = typeof text === 'string' ? text : '';

  if (BETTING_RE.test(input)) return { ok: false, rule: 'BETTING', text: input };
  if (!withdrawLive && leaksPartner(input)) return { ok: false, rule: 'PARTNER', text: input };
  if (hasOffDomainUrl(input)) return { ok: false, rule: 'URL', text: input };
  if (asksForWalletPin(input)) return { ok: false, rule: 'PIN_ASK', text: input };
  if (!payoutPending && claimsPayoutUnderWay(input)) return { ok: false, rule: 'MONEY_CLAIM', text: input };

  // Lists first (a leading "- " is a list marker, not a dash to turn into a comma), then dashes.
  const listed = normaliseLists(input);
  const rewritten = rewriteDashes(listed);
  if (rewritten.length > MAX_REPLY_CHARS) return { ok: false, rule: 'LENGTH', text: rewritten };

  if (rewritten !== listed) return { ok: true, rule: 'DASH_REWRITE', text: rewritten };
  if (listed !== input) return { ok: true, rule: 'LIST_REWRITE', text: listed };
  return { ok: true, rule: null, text: input };
}
