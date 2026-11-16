/**
 * The ad chat flow (2026-10-18): how the bot answers a person who tapped a
 * click-to-WhatsApp ad. Source of truth: docs/AD_CHAT_FLOW.md (the founder's
 * brief of 18 Oct 2026). Pure: copy, classification and parsing only; the
 * processor sends.
 *
 * The rule above everything: answer the question briefly, then get the
 * person to an open account and a first payment link. Meta has already sent
 * its greeting, so nothing here opens with another welcome.
 *
 * Banned in every message (campaign compliance): bank / banking (except
 * "any bank card"), send money, transfer, withdraw, cash out, ATM, competitor
 * comparisons, percentage savings claims, em dashes. tests/ad-flow.test.mjs
 * scans every string this module can produce.
 */

export const AD_QUESTIONS = Object.freeze({
  Q1: 'Open my WaPay account',
  Q2: 'How do I get paid with a link?',
  Q3: 'What does it cost?',
  Q4: 'Turn my WhatsApp into a wallet',
});

export const AD_BUTTONS = Object.freeze({
  OPEN: Object.freeze({ id: 'AD_OPEN_ACCOUNT', title: 'Open my account' }),
  COST: Object.freeze({ id: 'AD_WHAT_IT_COSTS', title: 'What it costs' }),
  HOW: Object.freeze({ id: 'AD_HOW_IT_WORKS', title: 'How it works' }),
  BANK: Object.freeze({ id: 'AD_PAYOUT_BANK', title: 'To my bank account' }),
  NEDBANK: Object.freeze({ id: 'AD_PAYOUT_NEDBANK', title: 'Nedbank cash' }),
  ABSA: Object.freeze({ id: 'AD_PAYOUT_ABSA', title: 'Absa cash' }),
});
export const PAYOUT_BUTTON_KINDS = Object.freeze(['PAYOUT_BANK', 'PAYOUT_NEDBANK', 'PAYOUT_ABSA']);

/**
 * Section 2 of the brief: what WaPay can do today. The bot's source of truth for ad arrivals.
 * Since 2026-10-18 the same truth holds for every customer (docs/LAUNCH_SCOPE.md).
 * Age (founder, 2026-10-18): no rule to build; anyone with a WhatsApp account may open an
 * account, a nominal 16 and above, not enforced.
 */
export const CAN_DO = Object.freeze({
  payMethods: 'any credit, cheque or debit card, Apple Pay, Samsung Pay, Google Pay, Instant EFT, Capitec Pay, SnapScan, Zapper, Scan to Pay, bank QR code apps, RCS store cards or MobiCred',
  payMethodsShort: 'any bank card, Instant EFT, Capitec Pay, SnapScan and more',
  comingSoon: 'Airtime, data, electricity and fuel are coming soon.',
});
export const OPEN_FIRST = "Let's open your account first. You only need this phone.";

export const AD_STATES = Object.freeze({ ENTRY: 'AD_ENTRY', FIRST_LINK: 'AD_FIRST_LINK' });

function norm(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Which entry point a first message (or a tapped button) is.
 * @returns {'Q1'|'Q2'|'Q3'|'Q4'|'OPEN'|'COST'|'HOW'|'free_text'}
 */
export function classifyAdEntry(text) {
  const t = norm(text);
  if (!t) return 'free_text';
  const exact = {
    [norm(AD_QUESTIONS.Q1)]: 'Q1',
    [norm(AD_QUESTIONS.Q2)]: 'Q2',
    [norm(AD_QUESTIONS.Q3)]: 'Q3',
    [norm(AD_QUESTIONS.Q4)]: 'Q4',
    [norm(AD_BUTTONS.OPEN.title)]: 'OPEN',
    [norm(AD_BUTTONS.COST.title)]: 'COST',
    [norm(AD_BUTTONS.HOW.title)]: 'HOW',
    [norm(AD_BUTTONS.OPEN.id)]: 'OPEN',
    [norm(AD_BUTTONS.COST.id)]: 'COST',
    [norm(AD_BUTTONS.HOW.id)]: 'HOW',
    [norm(AD_BUTTONS.BANK.title)]: 'PAYOUT_BANK',
    [norm(AD_BUTTONS.NEDBANK.title)]: 'PAYOUT_NEDBANK',
    [norm(AD_BUTTONS.ABSA.title)]: 'PAYOUT_ABSA',
    [norm(AD_BUTTONS.BANK.id)]: 'PAYOUT_BANK',
    [norm(AD_BUTTONS.NEDBANK.id)]: 'PAYOUT_NEDBANK',
    [norm(AD_BUTTONS.ABSA.id)]: 'PAYOUT_ABSA',
  };
  if (exact[t]) return exact[t];
  // Loose matches, in case Meta trims or re-punctuates the suggested texts.
  if (/\bwallet\b/.test(t)) return 'Q4';
  // Section 6: the questions people ask before (and after) opening an account.
  if (/\b(deposit|top ?up|load|put in)\b.*\bcash\b|\bcash\b.*\b(deposit|top ?up|load|in)\b/.test(t)) return 'FAQ_CASH_IN';
  if (/\b(airtime|data|electricity|electric|prepaid|fuel|petrol|diesel)\b/.test(t)) return 'FAQ_VAS';
  if (/\b(money out|get my money|withdraw|cash ?out|pay ?out|payout|take out|draw)\b/.test(t)) return 'FAQ_MONEY_OUT';
  if (/\bhow\b.*\b(people|they|someone|customers?|clients?)\b.*\bpay me\b|\bpay me\b.*\b(how|with what)\b|\bpayment methods?\b|\bwhich (cards?|methods?)\b/.test(t)) return 'FAQ_PAY_ME_HOW';
  if (/\b(pay|send)\b.*\b(someone|somebody|a friend|my (friend|mother|mom|brother|sister|wife|husband|son|daughter)|a person|people|another)\b|\bsend money\b|\btransfer\b/.test(t)) return 'FAQ_PAY_SOMEONE';
  if (/\b(open|create|start|register|sign ?up)\b.*\baccount\b|\baccount\b.*\b(open|create|start)\b/.test(t)) return 'Q1';
  if (/\b(cost|costs|fee|fees|price|charge|charges|how much)\b/.test(t)) return 'Q3';
  if (/\b(get paid|paid|payment link|link|how does it work|how it works)\b/.test(t)) return 'Q2';
  return 'free_text';
}

/** The first word of a WhatsApp profile name when it reads as a name; else null. */
export function firstNameFrom(profileName) {
  const first = String(profileName || '').trim().split(/\s+/)[0] || '';
  if (!/^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'-]{1,19}$/.test(first)) return null;
  const lower = first.toLowerCase();
  const notNames = new Set(['friend', 'user', 'customer', 'whatsapp', 'wapay', 'shop', 'store', 'business', 'official', 'admin', 'test', 'null', 'undefined', 'the', 'mr', 'mrs', 'ms', 'dr']);
  if (notNames.has(lower)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export function rands(cents) {
  const v = Math.round(cents) / 100;
  return Number.isInteger(v) ? `R${v}` : `R${v.toFixed(2)}`;
}

/** The approved fee example, computed from the LIVE fee table (never typed in). */
export function feeExample(paymentRequestFeeCents, { amountCents = 10000, rail } = {}) {
  const feeCents = rail ? paymentRequestFeeCents(amountCents, rail) : paymentRequestFeeCents(amountCents);
  return { amountCents, feeCents, netCents: amountCents - feeCents, amount: rands(amountCents), fee: rands(feeCents), net: rands(amountCents - feeCents) };
}

/**
 * The reply for an entry point.
 * @returns {{ text: string, buttons: Array<{id:string,title:string}>, startOnboarding: boolean, kind: string }}
 */
export function adEntryReply(kind, { firstName = null, fee = null, hasAccount = false } = {}) {
  const name = firstName ? `, ${firstName}` : '';
  switch (kind) {
    case 'Q1':
    case 'OPEN':
      return {
        kind,
        startOnboarding: true,
        buttons: [],
        text: `Great${name}. Let's open your WaPay account. You only need this phone, and it's three quick steps.`,
      };
    case 'Q2':
    case 'HOW':
      // 2026-10-20 (creative review): answer, then straight into onboarding step 1 in the
      // same turn. Q2 opened an account 36% of the time against 85% for Q1 while it waited
      // for a button tap. A member asking the same question gets the answer alone.
      return {
        kind,
        startOnboarding: !hasAccount,
        buttons: [],
        text:
          'It works like this:\n' +
          '1. Tell WaPay who owes you and how much.\n' +
          '2. Forward the payment link we send you.\n' +
          "3. They pay with any bank card, Instant EFT, Capitec Pay, SnapScan and more. They don't need WaPay." +
          (hasAccount ? '' : "\n\nLet's open your account so you can try it. You only need this phone, and it's three quick steps."),
      };
    case 'Q3':
    case 'COST': {
      const ex = fee || { amount: 'R100', fee: 'R6.50', net: 'R93.50' };
      // 2026-10-20 (creative review): the cost answer opened an account 28% of the time
      // while it waited for a tap; now the answer is followed by onboarding step 1 at once.
      return {
        kind,
        startOnboarding: !hasAccount,
        buttons: [],
        text:
          "Under R50, getting paid is free, for you and for them, even when they pay by card. Between WaPay users it's free at any amount.\n\n" +
          `From R50, card payments have a small fee that comes off what you receive, never off what they pay. For example, ${ex.amount} by card costs you ${ex.fee}, so you keep ${ex.net}. We always show you the cost before you share a link.` +
          (hasAccount ? '' : "\n\nLet's open your account. You only need this phone, and it's three quick steps."),
      };
    }
    case 'Q4':
      return {
        kind,
        startOnboarding: true,
        buttons: [],
        text:
          "You're in the right place. Once your account is open, you can get paid by anyone, top up electronically, pay other WaPay users for free, and pay out to your bank account or as cash at Nedbank and Absa ATMs. Airtime, data, electricity and fuel are coming soon." +
          "\n\nLet's open your account first. You only need this phone.",
      };
    case 'FAQ_PAY_ME_HOW':
      return { kind, startOnboarding: false, buttons: hasAccount ? [] : [AD_BUTTONS.OPEN], text: `However suits them: ${CAN_DO.payMethods}. They don't need WaPay.${hasAccount ? '' : `\n\n${OPEN_FIRST}`}` };
    case 'FAQ_MONEY_OUT':
      return {
        kind, startOnboarding: false,
        buttons: hasAccount ? [AD_BUTTONS.BANK, AD_BUTTONS.NEDBANK, AD_BUTTONS.ABSA] : [AD_BUTTONS.OPEN],
        text: `You can pay out to any South African bank account with PayShap, or collect cash at a Nedbank or Absa ATM, no card needed.${hasAccount ? '' : `\n\n${OPEN_FIRST}`}`,
      };
    case 'FAQ_CASH_IN':
      return { kind, startOnboarding: false, buttons: hasAccount ? [] : [AD_BUTTONS.OPEN], text: `Not yet. Cash top-ups with OTT and Blue Voucher are coming soon. For now you can top up electronically with a card, Instant EFT, Capitec Pay, SnapScan and more.${hasAccount ? '' : `\n\n${OPEN_FIRST}`}` };
    case 'FAQ_VAS':
      return { kind, startOnboarding: false, buttons: hasAccount ? [] : [AD_BUTTONS.OPEN], text: `Not yet, those are coming soon. Right now you can get paid, top up electronically, pay other WaPay users and pay out.${hasAccount ? '' : `\n\n${OPEN_FIRST}`}` };
    case 'FAQ_PAY_SOMEONE':
      return { kind, startOnboarding: false, buttons: hasAccount ? [] : [AD_BUTTONS.OPEN], text: `Yes. You can pay anyone from your WaPay balance to any SA number, free, and it lands in their WaPay balance. If they're not on WaPay yet, it waits for them. Just tell me the amount and their number.${hasAccount ? '' : `\n\n${OPEN_FIRST}`}` };
    default:
      return {
        kind: 'free_text',
        startOnboarding: false,
        buttons: [AD_BUTTONS.OPEN],
        text: `${firstName ? `Hi ${firstName}. ` : ''}Happy to help with that once your account is open. It takes three quick steps and you only need this phone.`,
      };
  }
}

export const FAQ_KINDS = Object.freeze(['FAQ_PAY_ME_HOW', 'FAQ_MONEY_OUT', 'FAQ_CASH_IN', 'FAQ_VAS', 'FAQ_PAY_SOMEONE']);
export function isFaqKind(kind) { return FAQ_KINDS.includes(kind); }

/**
 * One-step sign-up (WAPAY_ONBOARDING_ONE_STEP, 2026-10-22, docs/ONBOARDING.md §5):
 * the ad arrival's answer and the first-link question in ONE message, because
 * the account is open by the time it arrives (the processor appends the terms
 * line). A question gets its member answer first; "open my account", a tapped
 * button and free text get the first-link question alone. No buttons: the next
 * step is a typed amount and name.
 */
export function adOpenedReply(kind, { firstName = null, fee = null } = {}) {
  const prompt = firstLinkPrompt(firstName);
  if (['Q2', 'HOW', 'Q3', 'COST'].includes(kind) || isFaqKind(kind)) {
    return `${adEntryReply(kind, { firstName, fee, hasAccount: true }).text}\n\n${prompt}`;
  }
  if (kind === 'Q4') {
    return "You're in the right place. Your WaPay account is open: you can get paid by anyone, top up electronically, pay other WaPay users for free, and pay out to your bank account or as cash at Nedbank and Absa ATMs. " +
      `${CAN_DO.comingSoon}\n\n${prompt}`;
  }
  return prompt;
}

/** When reply buttons cannot be delivered, the same choice as text. */
export function buttonsAsText(buttons) {
  return buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n');
}

/** The moment onboarding completes for an ad arrival. */
export function firstLinkPrompt(firstName = null) {
  // 2026-10-20 (creative review): 37 accounts typed the old example back word for word, so the
  // prompt carries no example sentence. 2026-10-24 (founder: every link says what it is for): it asks
  // for the amount and what it is for in one answer, so "250 braids" makes the link in one turn.
  return `You're all set${firstName ? `, ${firstName}` : ''}. Let's get you paid. How much, and what is it for? Type the amount and a few words, and I'll make a link you can forward.`;
}

/**
 * "250 braids", "braids 250", "R250 for the birthday gift", "R250 from Thandi for the birthday
 * gift", "Thandi owes me 250 for braids" → amount, who, note. Null when no amount. Since 2026-10-24
 * the prompt asks what the payment is for, so the words left once the amount, a "from <name>" or
 * "<name> owes me" and the currency words are removed are the note (what it is for), not a name.
 * A name is read only where the customer marked it. The processor checks the note like any other
 * description (lib/link-description.js) and asks for it when there is none.
 */
export function parseFirstLinkAsk(text) {
  const raw = String(text || '').trim();
  const m = raw.match(/(?:^|\s)r?\s*(\d{1,6}(?:[.,]\d{1,2})?)(?=\s|$)/i);
  if (!m) return null;
  const amountCents = Math.round(parseFloat(m[1].replace(',', '.')) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) return null;
  const forNote = raw.match(/\bfor\s+(.{1,80}?)[.!]?$/i);
  const from = raw.match(/\bfrom\s+([A-Za-zÀ-ɏ][A-Za-zÀ-ɏ' -]{0,30}?)(?=\s+for\b|[.,!]|$)/i);
  const owes = raw.match(/^\s*([A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'-]{1,20}(?:\s+[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'-]{1,20})?)\s+(?:owes?|ows|owing)\s+me\b/i);
  const payerName = from ? from[1].trim() : owes ? owes[1].trim() : null;
  let note = forNote ? forNote[1].trim() : null;
  if (!note) {
    let rest = raw.replace(m[0], ' ');
    if (from) rest = rest.replace(from[0], ' ');
    if (owes) rest = rest.replace(owes[0], ' ');
    rest = rest
      .replace(/\b(?:rands?|zar|please|pls)\b/gi, ' ')
      .replace(/^\s*r\b/i, ' ')
      .replace(/[^A-Za-zÀ-ɏ0-9'’ -]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (/[A-Za-zÀ-ɏ]{2}/.test(rest) && rest.length <= 80) note = rest;
  }
  return { amountCents, payerName, note };
}

export function firstLinkRetry() {
  return 'Just the amount in rands and a few words about what it is for.';
}

// The created link (section 8) is the one forwardable card every customer gets since 2026-10-24
// (lib/pay-links.js requestCardText); its words keep to section 11, tests/ad-flow.test.mjs checks them.

/** Paid notification shape for ad arrivals (the payer is not known by name on a card payment). */
export function adPaidCopy({ amountCents, payerName = null }) {
  const amount = rands(amountCents);
  const head = payerName ? `${payerName} paid you ${amount}.` : `Your payment link for ${amount} was paid.`;
  return `${head} It's in your WaPay balance. Anyone else owe you? Send me the next one.`;
}

export const TIPS = Object.freeze([
  'Under R50, getting paid is free.',
  "Between WaPay users it's free at any amount.",
  'You can pay out to your bank account, or collect cash at Nedbank and Absa ATMs.',
  'We show you the cost before you share.',
]);

export function reminderCopy(kind, firstName = null) {
  if (kind === 'mid_onboarding') return `Hi${firstName ? ` ${firstName}` : ''}, you're one step away from your WaPay account. Want to finish?`;
  return 'Ready for your first payment link? Just tell me how much and what it is for.';
}

export function matchesStop(text) {
  return /^\s*(stop|unsubscribe|no more( messages| reminders)?|leave me alone|don'?t message me)\s*[.!]?\s*$/i.test(String(text || ''));
}

export const STOP_REPLY = 'Okay, no more reminders from me. Message me any time you want to pick this up.';

/**
 * Section 11 words. Never: banking, send money, transfer, withdraw, cash out,
 * em dashes. "Bank" only in "any bank card", "bank QR code apps" and "bank
 * account"; "ATM" only beside Nedbank or Absa. `copyViolations` returns what
 * a string breaks; tests run every string this module produces through it.
 */
export const BANNED_COPY = /\b(banking|send money|transfer|withdraw|cash[ -]?out)\b|—/i;
export function copyViolations(text) {
  const t = String(text || '');
  const out = [];
  const m = t.match(BANNED_COPY);
  if (m) out.push(m[0]);
  for (const hit of t.matchAll(/\bbank\b(?!\s+(card|QR code apps|account))/gi)) out.push(`bank@${hit.index}`);
  if (/\bATMs?\b/i.test(t) && !/\b(Nedbank|Absa)\b/.test(t)) out.push('ATM without Nedbank/Absa');
  if (/\d+\s?%/.test(t)) out.push('percentage');
  return out;
}

/**
 * Audit 2026-10-19: the first-link prompt's example typed back word for word
 * (ten customers made links for nobody), and the customer who thinks WaPay
 * pays them ("nobody owes me", "who must pay me"). Both get an answer, not a
 * link or the same prompt again.
 */
const EXAMPLE_NORM = norm('R250 from Thandi for the birthday gift');
export function isFirstLinkExample(text) {
  const t = norm(text);
  return !!t && (t === EXAMPLE_NORM || t.replace(/\s+/g, '') === EXAMPLE_NORM.replace(/\s+/g, ''));
}
export const EXAMPLE_ECHO_REPLY = 'That was just our example. How much are you really asking for, and what is it for? Type the amount and a few words.';
export function looksLikeNobodyOwesMe(text) {
  const t = norm(text);
  if (!t || t.length > 160) return false;
  return /\b(nobody|no ?one|noone|no body) (owes?|ows|is paying|must pay|will pay)\b|\bwho (must|will|is going to|should|gonna) pay me\b|\byou (give|put|send|pay|deposit) (me )?(the |my )?money\b|\bwhere (do|does|will) (the |my )?money come\b|\b(i )?(just )?(need|want) (the )?(money|cash) now\b|\bgive me (the |some )?money\b|\bdo you (give|lend|loan) (me )?money\b|\bi don'?t (know|have) (who|anyone|anybody|someone)\b.*\b(owe|pay)/.test(t);
}
export const NOBODY_OWES_ME_REPLY = 'WaPay does not pay you itself. It helps you get paid by people who owe you: a customer, a friend, family. When someone owes you, tell me the amount and who it is from, and I make a link you forward to them; the money lands in your WaPay balance when they pay. You can also add your own money by card, pay anyone from your balance, and take money out at an Absa or Nedbank ATM. Say *home* to see everything.';

/**
 * Loans (creative review, 2026-10-20): 21 accounts asked for a loan, a float or credit in the
 * first two days. One honest line, then the next step; never a referral to a lender (the
 * Messaging Policy forbids payday and P2P lending content), never a model call.
 */
export function matchLoanAsk(text) {
  const t = norm(text);
  if (!t || t.length > 160) return false;
  if (/\b(pay ?out|withdraw|cash ?out|balance|voucher|airtime|data|electricity)\b/.test(t) && !/\b(loan|borrow|lend|credit|advance)\b/.test(t)) return false;
  return /\b(loans?|borrow(ing)?|lend( me)?|mashonisa|cash advance|an? advance|credit (facility|line|for me)|can i (get|have) credit|payday|give me credit|i need credit|on credit)\b/.test(t) && !/\bcredit(ed)? (my|the|to) (account|balance|wallet)\b|\bcredit card\b/.test(t);
}

export const LOANS_REPLY = "WaPay doesn't offer loans. You can get paid, top up, pay other WaPay users and pay out. To get paid, tell me who owes you and how much, and I make the link you forward to them.";
