/**
 * WaPay for Business — the sign-up conversation INSIDE WhatsApp (founder
 * ask 2026-09-06: "when a business signs up, we just ask a question").
 *
 * Two questions, both answered in the chat the customer is already in:
 *   1. right after onboarding completes: "is this account for you, or for
 *      a business?" (state BIZ_SIGNUP_TYPE)
 *   2. if business: "what is the trading name?" (state BIZ_SIGNUP_NAME)
 * and the business row exists. Nothing else is asked: category and a
 * password live in the portal's Settings. An existing wallet gets the same
 * flow from the command "business account" (matchBusinessSignupAsk).
 *
 * Why the chat is enough: the message arrives from a WhatsApp account Meta
 * verified by SMS, over a webhook WaPay verifies by HMAC, from a wallet that
 * has a PIN and gave consent. That is the same proof the portal's OTP
 * establishes, minus the code (docs/ONBOARDING.md).
 *
 * Rules kept from the portal path (lib/business-auth.js, lib/business.js):
 * registration is CLOSED by default (invite list / WAPAY_BUSINESS_SIGNUPS),
 * one business per account, the name goes through validateBusinessName
 * (no bank / network / WaPay impersonation), a race on the unique
 * accountId adopts the winner. A wallet that may not register yet is put on
 * a list (profile.businessInterestAt) and told so honestly.
 *
 * Pure with respect to messaging: every function returns a step
 * { text, state, data?, done?, raw? } and the processor sends it, so the
 * whole conversation is unit-testable against the in-memory Prisma stub.
 * `raw` marks copy that carries a command or URL and must not be localised.
 */

import prisma from './prisma.js';
import { createBusiness, validateBusinessName } from './business.js';
import { mayRegister } from './business-auth.js';
import { updateProfile } from './user-profile.js';

export const BIZ_SIGNUP_TYPE = 'BIZ_SIGNUP_TYPE';
export const BIZ_SIGNUP_NAME = 'BIZ_SIGNUP_NAME';
export const BIZ_SIGNUP_STATES = [BIZ_SIGNUP_TYPE, BIZ_SIGNUP_NAME];

/** Where the portal lives: the dedicated host when set, else /business on the app. */
export function portalUrl() {
  const host = String(process.env.WAPAY_BUSINESS_HOST || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (host) return `https://${host}`;
  const base = String(process.env.APP_BASE_URL || 'https://pleasepayme.co.za').replace(/\/+$/, '');
  return `${base}/business`;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const LEAD = "(?:(?:hi|hello|hey|howzit|please|pls|i want to|i'd like to|i would like to|i need to|can i|how do i|how can i|i want|i need|i'd like|i would like)\\s+)*";
const TAIL = "(?:\\s+(?:please|pls|now|on wapay|with wapay|for my (?:shop|business|spaza|salon|laundry)))*";
const SIGNUP_PATTERNS = [
  "(?:register|open|create|add|set up|setup|sign up|signup|start|make)\\s+(?:as\\s+)?(?:a|an|my|the|for|for a|for my|for the)?\\s*(?:new\\s+)?business(?:\\s+(?:account|profile|wallet))?",
  "business\\s+(?:account|sign up|signup|register|registration|profile|wallet)",
  "(?:i am|i'm|im|this is)\\s+a\\s+business(?:\\s+(?:account|owner|user|customer))?",
  "wapay\\s+for\\s+business",
  "(?:a|an|my|the)\\s+business\\s+(?:account|profile|wallet)",
].map((p) => new RegExp(`^${LEAD}(?:${p})${TAIL}$`, 'i'));

/**
 * "business account" / "register my business" / "I'm a business" — the
 * explicit ask that starts the flow for an existing wallet. Anchored on the
 * whole message so ordinary sentences that mention a business ("my business
 * is slow today") never trigger it, and "business login" (the portal code
 * command, handled earlier) never lands here.
 */
export function matchBusinessSignupAsk(text) {
  const t = normalise(text);
  if (!t || t.length > 80) return false;
  return SIGNUP_PATTERNS.some((re) => re.test(t));
}

const PERSONAL_RE = /(^|\W)(1|one|personal|persoonlik|myself|for me|private|retail|individual|not a business)(\W|$)/i;
const BUSINESS_RE = /(^|\W)(2|two|business|besigheid|ibhizinisi|kgwebo|shop|store|company|spaza|salon|laundry|tuck ?shop)(\W|$)/i;
const END_RE = /^\W*(no|nope|cancel|skip|later|stop|exit|menu|home|nothing)\W*$/i;
const CANCEL_RE = /^\W*(cancel|stop|skip|later|exit|menu|home|no thanks|nevermind|never mind)\W*$/i;

/** @returns {'PERSONAL'|'BUSINESS'|null} */
export function parseAccountType(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (END_RE.test(t)) return 'PERSONAL';
  const p = PERSONAL_RE.test(t);
  const b = BUSINESS_RE.test(t);
  if (b && !p) return 'BUSINESS';
  if (p && !b) return 'PERSONAL';
  return null;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const TYPE_QUESTION =
  `One last thing: is this WaPay account for you, or for a business?\n\n` +
  `1️⃣ *Personal*: buy airtime, data and electricity, send and receive money\n` +
  `2️⃣ *Business*: get paid by your customers and see who paid what\n\n` +
  `Reply *1* or *2*.`;
const TYPE_REASK = `Reply *1* if this account is for you personally, or *2* if it is for a business.`;
const PERSONAL_TEXT =
  `👍 Personal it is. You're all set!\n\n` +
  `If you ever run a business on WhatsApp, just say *business account* and I'll set it up in two questions.`;
const NAME_ASK =
  `🏪 *WaPay for Business*\n\n` +
  `What is your business's trading name? Your customers see it on every payment link and receipt.\n\n` +
  `For example: Thabo's Laundry. Reply *cancel* to stop.`;
const NAME_TOO_SHORT = `Please give me the trading name (2 to 60 characters), or reply *cancel*.`;
const NAME_NOT_ALLOWED = `That name can't be used: it looks like a bank, a network or WaPay itself. What is your own trading name? (Or reply *cancel*.)`;
const CANCEL_TEXT = `No problem. Say *business account* whenever you're ready.`;
const WAITLIST_TEXT =
  `🏪 WaPay for Business is opening to a small group of businesses first. I've put you on the list and will message you right here when your spot opens.\n\n` +
  `Meanwhile you can already get paid: say *please pay me R150* and I'll give you a payment link.`;
const FAILED_TEXT = `Something went wrong on my side and the business was not created. Please say *business account* to try again.`;

function alreadyText(name) {
  return (
    `✅ *${name}* is already registered as your business.\n\n` +
    `Manage customers, payment links and revenue at ${portalUrl()}. To sign in from a computer, WhatsApp me *business login* and type the code I give you.`
  );
}

function registeredText(name) {
  return (
    `🎉 *${name}* is now a WaPay business.\n\n` +
    `Your customers pay you through links you create at ${portalUrl()}: customers, itemised links, who paid what, monthly revenue and a CSV export.\n\n` +
    `To sign in there, WhatsApp me *business login* and type the code. In Settings you can add what your business does and a password for the shop computer.\n\n` +
    `Every payment lands in this WaPay wallet, and I'll message you here each time a customer pays.`
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** The question asked once, right after onboarding completes. */
export function accountTypeQuestion() {
  return { state: BIZ_SIGNUP_TYPE, data: { asked: 0 }, text: TYPE_QUESTION };
}

async function noteInterest(prismaClient, accountId) {
  try {
    await updateProfile({ prisma: prismaClient, accountId, patch: { businessInterestAt: new Date().toISOString() } });
  } catch {
    // best-effort memory; the reply stands either way
  }
}

/**
 * Start (or short-circuit) the business sign-up for an onboarded wallet:
 * already registered → say so; not invited while the pilot is closed →
 * waitlist; else ask the trading name.
 */
export async function startBusinessSignup({ prisma: prismaClient = prisma, account }) {
  const existing = await prismaClient.business.findUnique({ where: { accountId: account.id } });
  if (existing) return { state: null, raw: true, text: alreadyText(existing.name), businessId: existing.id, already: true };
  if (!mayRegister(account.msisdn || account.waId)) {
    await noteInterest(prismaClient, account.id);
    return { state: null, text: WAITLIST_TEXT, waitlisted: true };
  }
  return { state: BIZ_SIGNUP_NAME, data: {}, text: NAME_ASK };
}

/**
 * One user reply inside the flow. Never throws for user input; a database
 * failure surfaces as FAILED_TEXT with the state cleared, so the customer
 * is never stuck in a step.
 */
export async function handleBusinessSignupReply({ prisma: prismaClient = prisma, account, state, data = {}, text }) {
  const t = String(text || '').trim();
  const asked = Number(data?.asked || 0);

  if (state === BIZ_SIGNUP_TYPE) {
    const choice = parseAccountType(t);
    if (choice === 'BUSINESS') return startBusinessSignup({ prisma: prismaClient, account });
    if (choice === 'PERSONAL' || asked >= 1) return { state: null, text: PERSONAL_TEXT, personal: true };
    return { state: BIZ_SIGNUP_TYPE, data: { asked: asked + 1 }, text: TYPE_REASK };
  }

  if (state === BIZ_SIGNUP_NAME) {
    if (CANCEL_RE.test(t)) return { state: null, text: CANCEL_TEXT, cancelled: true };
    const v = validateBusinessName(t);
    if (!v.ok) return { state: BIZ_SIGNUP_NAME, data, text: v.error === 'NAME_NOT_ALLOWED' ? NAME_NOT_ALLOWED : NAME_TOO_SHORT };
    if (!mayRegister(account.msisdn || account.waId)) {
      // The invite was withdrawn between the two questions: same honest answer.
      await noteInterest(prismaClient, account.id);
      return { state: null, text: WAITLIST_TEXT, waitlisted: true };
    }
    let business = null;
    try {
      business = await createBusiness({ prisma: prismaClient, accountId: account.id, name: v.name });
    } catch (error) {
      if (error?.code === 'P2002') {
        business = await prismaClient.business.findUnique({ where: { accountId: account.id } });
      } else {
        console.error(JSON.stringify({ type: 'business_chat_register_error', accountId: account.id, error: error?.message }));
      }
    }
    if (!business) return { state: null, text: FAILED_TEXT, failed: true };
    return { state: null, done: true, raw: true, businessId: business.id, text: registeredText(business.name) };
  }

  return { state: null, text: CANCEL_TEXT };
}
