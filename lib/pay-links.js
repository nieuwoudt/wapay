/**
 * Payment links in the chat and on the web (founder, 2026-10-24).
 *
 * 1. Every link says what it is for (lib/link-description.js checks it).
 * 2. One message after a link is made, and it is the message to forward: who
 *    is asking (the requester's name and the last digits of their number, the
 *    pay page's trust signal), the amount, what it is for, the link as plain
 *    text (WhatsApp strips buttons from a forwarded message) and how to pay.
 *    What the requester receives by card was shown at the fee choice, before
 *    the link was made, so nothing here is for the requester's eyes only.
 * 3. "my links" lists the open links; "remind 2" gives a reminder to forward;
 *    "cancel 2" closes one. The web app shows the same links and texts.
 * 4. WaPay never writes to the payer to ask for money (the 20 October spam
 *    restriction, and anyone could make WaPay send "please pay R500" to any
 *    number). When the requester names the payer's number, the one message
 *    carries a tap-to-send link that opens the requester's OWN WhatsApp chat
 *    with that person, the request ready to send. The payer's number is used
 *    for that link only and is never stored on the request.
 *
 * Pure apart from `sendCreatedLink` and `openLinksOf`, whose collaborators are
 * passed in. No model call anywhere in this file, and no personal data leaves
 * it except in the texts it returns to the caller.
 */
import { paymentRequestUrl, requesterNumberTail } from './payment-requests.js';
import { cleanDescription, descriptionRefusal, plainText } from './link-description.js';
import { isValidSaMsisdn, normaliseMsisdn, toWaId } from './msisdn.js';
import { parseSlots } from './slot-parser.js';

const SAST_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "R150", or "R150.50" when there are cents (the chat's own shape). */
export function rands(cents) {
  const c = Math.round(Number(cents) || 0);
  return `R${(c / 100).toFixed(2).replace(/\.00$/, '')}`;
}

/** "31 Oct" in South African time. */
export function dateShort(at) {
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return '';
  const x = new Date(t + SAST_MS);
  return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`;
}

/** "today", "yesterday" or "3 days ago", by the South African calendar. */
export function relativeDay(at, now = Date.now()) {
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return '';
  const days = Math.floor((now + SAST_MS) / DAY_MS) - Math.floor((t + SAST_MS) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/** "082 123 4567". */
export function spacedNumber(msisdn) {
  const d = normaliseMsisdn(msisdn);
  return d.length === 10 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : d;
}

// ---------------------------------------------------------------------------
// Reading a get-paid ask
// ---------------------------------------------------------------------------

const NAME_WORD = "[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'’-]{1,20}";
const FROM_NAME = new RegExp(`\\bfrom\\s+(?:my\\s+)?(${NAME_WORD}(?:\\s+${NAME_WORD}){0,2}?)(?=\\s+for\\b|\\s*[,.!?]|\\s*$)`, 'i');
const OWES_ME = new RegExp(`^\\s*(${NAME_WORD}(?:\\s+${NAME_WORD})?)\\s+(?:owes?|ows|owing)\\s+me\\b`, 'i');
const NOT_A_NAME = /^(?:me|my|phone|work|home|bank|card|wallet|app|whatsapp|the|a|an|someone|somebody|anyone|anybody|him|her|them|us|you|people|customers?|clients?|please|pls)$/i;
// "for R150", "for 150", "for 150 rand": the amount, not what it is for ("for 2 boxes" is a description).
const STARTS_WITH_AMOUNT = /^\s*(?:r\s?\d|\d+(?:[.,]\d{1,2})?\s*(?:rands?|zar)?\s*(?:$|for\b|from\b|[,.!?]))/i;

/**
 * What a get-paid ask says: the amount, what it is for and who pays.
 *   "please pay me R150 for braids"                 → 15000, "braids", null
 *   "request R200 from 082 123 4567 for plumbing"   → 20000, "plumbing", { msisdn: '0821234567' }
 *   "R250 from Thandi for the birthday gift"        → 25000, "the birthday gift", { name: 'Thandi' }
 *   "create a payment link for R100 for braids"     → 10000, "braids", null
 * The description is the text after "for" (one that is not an amount); a
 * number anywhere is who pays, so its digits are never read as the amount.
 * The description is cleaned, not judged: the caller checks it.
 *
 * @returns {{ amountCents: number|null, description: string|null, payer: {msisdn:string}|{name:string}|null }}
 */
export function parseLinkAsk(text) {
  let s = ` ${String(text ?? '').replace(/\s+/g, ' ').trim()} `;
  let payer = null;

  const phone = s.match(/(\b(?:from|to|by)\s+)?(?<![\d+])(\+?27|0)((?:[\s-]?\d){9})(?!\d)/i);
  if (phone) {
    const msisdn = normaliseMsisdn(`${phone[2]}${phone[3]}`);
    if (isValidSaMsisdn(msisdn)) {
      payer = { msisdn };
      s = s.replace(phone[0], ' ');
    }
  }
  if (!payer) {
    const owes = s.match(OWES_ME);
    const m = owes || s.match(FROM_NAME);
    if (m && !NOT_A_NAME.test(m[1].trim().split(/\s+/)[0])) {
      payer = { name: m[1].trim() };
      s = s.replace(m[0], ' ');
    }
  }

  let description = null;
  const forRe = /\bfor\b\s*:?\s*/gi;
  for (let m = forRe.exec(s); m; m = forRe.exec(s)) {
    const rest = s.slice(m.index + m[0].length);
    if (!rest.trim() || STARTS_WITH_AMOUNT.test(rest)) continue;
    description = rest.trim();
    s = `${s.slice(0, m.index)} `;
    break;
  }
  if (!description) {
    const labelled = s.match(/\b(?:description|reason)\s*:\s*(.+)$/i);
    if (labelled) {
      description = labelled[1].trim();
      s = `${s.slice(0, labelled.index)} `;
    }
  }

  let amountCents = parseSlots(s).amountCents || null;
  if (!amountCents && description) {
    // "please pay me for 2 boxes R150" or "for braids 150": the amount rode inside the description.
    const inside = description.match(/(?:^|\s)(?:r\s?(\d{1,6}(?:[.,]\d{1,2})?)\b|(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:rand|zar)?\s*$)/i);
    if (inside) {
      const value = Math.round(parseFloat(String(inside[1] || inside[2]).replace(',', '.')) * 100);
      if (Number.isInteger(value) && value > 0) {
        amountCents = value;
        description = `${description.slice(0, inside.index)} ${description.slice(inside.index + inside[0].length)}`.trim();
      }
    }
  }
  const cleaned = description ? cleanDescription(description) : '';
  return { amountCents: amountCents || null, description: cleaned || null, payer };
}

// ---------------------------------------------------------------------------
// The description question
// ---------------------------------------------------------------------------

// At the description step almost any text is a valid answer, so "is this another request?" cannot be the
// usual "no slot found". These openings are requests, never what a payment is for; the processor's intent
// switch already catches airtime, data, electricity, fuel, deposits and withdrawals before the step.
const OTHER_REQUEST = /^\s*(?:send|transfer|cash\s*-?\s*out|pay\s+(?:request|r\s?\d|\d|my|the|someone|somebody|him|her|them|back)|balance|my\s+balance|check\s+(?:my\s+)?balance|show\s+(?:me\s+)?my|my\s+(?:transactions|history|statement)|transactions?|history|statement|invite|forgot\s+(?:my\s+)?pin|reset\s+(?:my\s+)?pin|speak|talk)\b/i;

/** A message at the description step that is clearly another request: it leaves the flow (never trap). */
export function looksLikeOtherRequest(text) {
  return OTHER_REQUEST.test(String(text || ''));
}

/** The one question when a link has no description yet, or the plain reason it was refused. */
export function descriptionQuestion({ amountCents = null, refused = null, replacedCents = null } = {}) {
  const what = Number.isInteger(amountCents) ? `the ${rands(amountCents)}` : 'it';
  const lead = refused
    ? `${descriptionRefusal(refused)}\n\n`
    : Number.isInteger(replacedCents) && replacedCents > 0 ? `🔁 Your ${rands(replacedCents)} link is cancelled and no longer works.\n\n` : '';
  return `${lead}🙏 What is ${what} for? The person paying sees it on the link.\n\nReply in a few words, like "braids" or "rent", or "cancel" to stop.`;
}

// ---------------------------------------------------------------------------
// The forwardable card
// ---------------------------------------------------------------------------

// A name that reads as WaPay or an authority is never put on a card (the
// processor's safeRequesterLabel list, plus SARS): the masked number goes instead.
const LABEL_IMPERSONATION = /\b(?:wapay|wa-pay|support|admin|system|official|helpdesk|service|sars)\b/i;

/**
 * How the requester is named on the card: their WhatsApp name with the last
 * three digits of their number ("Thandi •••567", the pay page's trust
 * signal), or the masked number when the name is empty, reads as authority or
 * has no letter or digit. Never the whole number.
 */
export function cardRequesterLabel(account) {
  const digits = String(account?.msisdn || account?.waId || '').replace(/\D/g, '');
  const local = digits.startsWith('27') && digits.length === 11 ? `0${digits.slice(2)}` : digits;
  const masked = local.length >= 6 ? `${local.slice(0, 3)}•••${local.slice(-3)}` : null;
  const name = plainText(account?.displayName).slice(0, 24).trim();
  const folded = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const usable = !!name && /[\p{L}\p{N}]/u.test(name) && !LABEL_IMPERSONATION.test(name) && !LABEL_IMPERSONATION.test(folded) && !/w\s*a\s*p\s*a\s*y/.test(folded);
  if (usable) {
    const tail = requesterNumberTail({ msisdn: local });
    return tail ? `${name} ${tail}` : name;
  }
  return masked || 'A WaPay user';
}

/** A stored description as the payer reads it (older links may hold up to 120 characters). */
export function displayDescription(note, max = 80) {
  const t = cleanDescription(note);
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export const PAY_WAYS_LINE = 'No fee for you: pay by card, Instant EFT and more, or from a WaPay balance.';

/**
 * The message the requester forwards, and the reminder: it reads the same
 * from WaPay's chat, forwarded, or sent from the requester's own WhatsApp.
 */
export function requestCardText({ label, amountCents, description = null, url, replacedCents = null, reminder = false, openUntil = null }) {
  const who = label || 'A WaPay user';
  const lines = [reminder ? `🔔 *Reminder: ${who} is asking you to pay ${rands(amountCents)}*` : `🙏 *${who} is asking you to pay ${rands(amountCents)}*`];
  if (description) lines.push(`For: ${description}`);
  lines.push('', `Pay here: ${url}`, PAY_WAYS_LINE);
  if (openUntil && dateShort(openUntil)) lines.push(`Open until ${dateShort(openUntil)}.`);
  if (Number.isInteger(replacedCents) && replacedCents > 0) lines.push('', `This link replaces the earlier ${rands(replacedCents)} link, which no longer works.`);
  return lines.join('\n');
}

/** The card for a stored link (the web share text, the chat's created message). */
export function cardForLink({ account, request, replacedCents = null }) {
  return requestCardText({ label: cardRequesterLabel(account), amountCents: request.amountCents, description: displayDescription(request.note), url: paymentRequestUrl(request.id), replacedCents });
}

/** The reminder for an open link: the same card, marked as a reminder, with the date it closes. */
export function reminderCardFor({ account, request }) {
  return requestCardText({ label: cardRequesterLabel(account), amountCents: request.amountCents, description: displayDescription(request.note), url: paymentRequestUrl(request.id), reminder: true, openUntil: request.expiresAt });
}

/** wa.me link that opens the requester's own chat with this number, the text ready to send. null for a number that is not a SA cellphone. */
export function tapToSendUrl({ msisdn, text }) {
  const n = normaliseMsisdn(msisdn);
  if (!isValidSaMsisdn(n)) return null;
  return `https://wa.me/${toWaId(n)}?text=${encodeURIComponent(String(text ?? ''))}`;
}

/** wa.me link with no number: WhatsApp asks who to send the text to. */
export function shareToWhatsAppUrl(text) {
  return `https://wa.me/?text=${encodeURIComponent(String(text ?? ''))}`;
}

/** The texts the web app needs for one open link. */
export function webLinkTexts({ account, request }) {
  const reminderText = reminderCardFor({ account, request });
  return { shareText: cardForLink({ account, request }), reminderText, remindUrl: shareToWhatsAppUrl(reminderText) };
}

/**
 * The requester's one message after a link is made: the card, and when they
 * named the payer's number, the tap-to-send line under it. One translation
 * call at most (the existing localizer; English is returned as is). The
 * prefilled text is the card as the requester reads it; if a translation lost
 * the paragraph break, the English card is used instead.
 *
 * @returns {Promise<{ text: string, recordAs: string|null }>}
 */
export async function composeLinkCreated({ card, tapMsisdn = null, localize = async (t) => t }) {
  if (!tapMsisdn || !isValidSaMsisdn(normaliseMsisdn(tapMsisdn))) return { text: await localize(card), recordAs: null };
  const tapLine = `📲 Tap to send it to ${spacedNumber(tapMsisdn)} from your own WhatsApp:`;
  const localized = await localize(`${card}\n\n${tapLine}`);
  const cut = localized.lastIndexOf('\n\n');
  const urlInCard = (card.match(/https:\/\/\S+/) || [''])[0];
  let prefill = cut > 0 ? localized.slice(0, cut) : '';
  if (!prefill || !prefill.includes(urlInCard)) prefill = card;
  const url = tapToSendUrl({ msisdn: tapMsisdn, text: prefill });
  const masked = (() => { const d = normaliseMsisdn(tapMsisdn); return `${d.slice(0, 3)}•••${d.slice(-3)}`; })();
  return { text: `${localized}\n${url}`, recordAs: `${prefill}\n\n[tap-to-send link to ${masked}]` };
}

/**
 * Send the one message after a link is made, then, only for a WaPay member the
 * requester has sent money to before (resolved by the caller), WaPay's own
 * informational note to that member, and only inside the member's 24-hour
 * service window: outside it Meta drops a plain text (BUGLOG #138), so nothing
 * is sent. The requester's message is the same in every case, so it never says
 * whether a number belongs to a WaPay member.
 *
 * deps: { send({ to, text, kind, refs, recordAs }), localize(text), windowOpen(waId), deliverToMember(waId), log?(type, data) }
 * @returns {Promise<{ sent: object, text: string, card: string, memberWindowOpen: boolean|null, memberDelivered: boolean }>}
 */
export async function sendCreatedLink(deps, { to, account, request, tapMsisdn = null, member = null, replacedCents = null, kind = 'flow' }) {
  const card = cardForLink({ account, request, replacedCents });
  const msg = await composeLinkCreated({ card, tapMsisdn, localize: deps.localize || (async (t) => t) });
  // The text goes through the transport that remembers what it said, with the link as its reference (BUGLOG #120).
  const sent = await deps.send({ to, text: msg.text, kind, refs: { request: request.id }, ...(msg.recordAs ? { recordAs: msg.recordAs } : {}) });
  let memberWindowOpen = null;
  let memberDelivered = false;
  if (member?.waId) {
    memberWindowOpen = !!(await Promise.resolve(deps.windowOpen(member.waId)).catch(() => false));
    if (memberWindowOpen) memberDelivered = !!(await Promise.resolve(deps.deliverToMember(member.waId)).catch(() => false));
    deps.log?.('payrequest_directed', { accountId: account?.id || null, code: request.id, windowOpen: memberWindowOpen, delivered: memberDelivered });
  }
  return { sent, text: msg.text, card, memberWindowOpen, memberDelivered };
}

// ---------------------------------------------------------------------------
// "my links", "remind 2", "cancel 2"
// ---------------------------------------------------------------------------

const NUMBER = '(?:#|no\\.?\\s*|number\\s*)?(\\d{1,2})';
const LIST_ASK = /^(?:(?:show|see|check|view|list|track)\s+(?:me\s+)?)?(?:all\s+)?(?:(?:my|our)\s+)?(?:open\s+|unpaid\s+|pending\s+|active\s+)?(?:(?:payment|pay)\s+)?(?:links|requests)(?:\s+status)?\s*\??$|^(?:(?:show|see|check|view|track)\s+(?:me\s+)?)?my\s+(?:(?:payment|pay)\s+)?(?:link|request)(?:\s+status)?\s*\??$/i;
const REMIND_N = new RegExp(`^(?:send\\s+(?:a\\s+)?)?remind(?:er)?\\s+(?:for\\s+)?(?:(?:link|request)\\s+)?${NUMBER}$`, 'i');
const REMIND_CODE = /^(?:send\s+(?:a\s+)?)?remind(?:er)?\s+(?:for\s+)?(?:(?:link|request)\s+)?(PR[A-Z]{6})$/i;
const CANCEL_N = new RegExp(`^cancel\\s+(?:(?:link|request)\\s+)?${NUMBER}$`, 'i');
const CANCEL_CODE = /\bcancel\w*\s+(?:my\s+)?(?:(?:payment\s+)?(?:link|request)\s+)?(PR[A-Z]{6})\b/i;

/**
 * The link commands, read before any model: "my links" (and "my payment
 * links", "open links", "show my requests"), "remind 2" / "remind PRXXXXXX",
 * "cancel 2" / "cancel PRXXXXXX" / "cancel request PRXXXXXX".
 * @returns {{kind:'LIST'}|{kind:'REMIND'|'CANCEL', n?:number, code?:string}|null}
 */
export function matchLinkCommand(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 80) return null;
  const t = raw.replace(/[.!]+$/, '').replace(/\s+/g, ' ').trim();
  if (LIST_ASK.test(t)) return { kind: 'LIST' };
  let m = t.match(REMIND_N);
  if (m) return { kind: 'REMIND', n: Number(m[1]) };
  m = t.match(REMIND_CODE);
  if (m) return { kind: 'REMIND', code: m[1].toUpperCase() };
  m = t.match(CANCEL_N);
  if (m) return { kind: 'CANCEL', n: Number(m[1]) };
  m = t.match(CANCEL_CODE);
  if (m) return { kind: 'CANCEL', code: m[1].toUpperCase() };
  return null;
}

/** The customer's open personal links, newest first (business tickets live in the portal). */
export async function openLinksOf({ prisma, accountId, now = Date.now(), take = 20 }) {
  return prisma.paymentRequest.findMany({
    where: { accountId, businessId: null, status: 'PENDING', expiresAt: { gt: new Date(now) } },
    orderBy: { createdAt: 'desc' },
    take,
  });
}

export const MY_LINKS_SHOWN = 10;

/** "my links": one short message, a numbered list, the two next steps, the web page. */
export function myLinksText({ links = [], now = Date.now(), webUrl = 'app.wapay.co.za/app/links' } = {}) {
  if (!links.length) {
    return `🔗 You have no open payment links.\n\nTo make one, tell me the amount and what it is for, like "R150 for braids".\nAll your links: ${webUrl}`;
  }
  const shown = links.slice(0, MY_LINKS_SHOWN);
  const rows = shown.map((l, i) => {
    const what = displayDescription(l.note, 40);
    return `${i + 1}. ${rands(l.amountCents)}${what ? ` for ${what}` : ''} · ${relativeDay(l.createdAt, now)} · ${l.id}`;
  });
  const more = links.length > shown.length ? [`and ${links.length - shown.length} more on the web`] : [];
  return [
    `🔗 *Your open payment links*`,
    ...rows,
    ...more,
    '',
    `Reply *remind 1* for a reminder to forward, or *cancel 1* to close that link.`,
    `All your links: ${webUrl}`,
  ].join('\n');
}
