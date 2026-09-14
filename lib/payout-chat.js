/**
 * Withdrawals INSIDE WhatsApp ("withdraw R200", "cash out", "payshap"),
 * built on lib/payouts.js the same way lib/business-chat.js sits on the
 * portal: every function returns a step { text, state, data?, action? } and
 * the processor sends it, parks the state and runs the PIN check. Nothing
 * here moves money; requestPayout does, once, after the PIN.
 *
 * Flow: (identity check once) → how → how much → where → confirm → PIN.
 *   PAYSHAP  : to the customer's own bank account (account number + branch code; OTT 2026-09-14)
 *   RTC      : to a bank account (account number + bank / universal branch code)
 *   CASHSEND : cash at an Absa or Nedbank ATM, no bank account needed
 * The recipient is the customer themselves: the KYC name (profile.kyc.fullName)
 * is what goes to the bank rail, never a typed name. Live only when
 * WAPAY_PAYOUT_ENABLED=true; otherwise the honest coming-soon script stays.
 */

import prisma from './prisma.js';
import {
  PAYOUT_METHODS, MIN_PAYOUT_CENTS, MAX_PAYOUT_CENTS, payoutEnabled, kycRequired, accountKycVerified,
  quotePayout, payoutBalances as realPayoutBalances, requestPayout as realRequestPayout, resolveProviders as realResolveProviders,
} from './payouts.js';
import { normaliseMsisdn, isValidSaMsisdn } from './msisdn.js';

export const PAYOUT_STATES = ['PAYOUT_KYC', 'PAYOUT_METHOD', 'PAYOUT_AMOUNT', 'PAYOUT_ACCOUNT', 'PAYOUT_BRANCH', 'PAYOUT_MOBILE', 'PAYOUT_ID', 'PAYOUT_CONFIRM', 'PAYOUT_PIN'];

/** Universal branch codes (one code per bank, published by the banks). */
export const BANK_BRANCH_CODES = {
  FNB: '250655', CAPITEC: '470010', 'STANDARD BANK': '051001', ABSA: '632005', NEDBANK: '198765', TYMEBANK: '678910', TYME: '678910',
  DISCOVERY: '679000', 'AFRICAN BANK': '430000', INVESTEC: '580105', BIDVEST: '462005', 'OLD MUTUAL': '462005', SASFIN: '683000', 'BANK ZERO': '888000',
};
const BANK_DISPLAY = {
  FNB: 'FNB', CAPITEC: 'Capitec', 'STANDARD BANK': 'Standard Bank', ABSA: 'Absa', NEDBANK: 'Nedbank', TYMEBANK: 'TymeBank', TYME: 'TymeBank',
  DISCOVERY: 'Discovery Bank', 'AFRICAN BANK': 'African Bank', INVESTEC: 'Investec', BIDVEST: 'Bidvest Bank', 'OLD MUTUAL': 'Old Mutual', SASFIN: 'Sasfin', 'BANK ZERO': 'Bank Zero',
};

const R = (c) => `R${(c / 100).toFixed(2).replace(/\.00$/, '')}`;
const CANCEL_RE = /^\W*(cancel|stop|no|exit|back|menu|home|nevermind|never mind)\W*$/i;

/**
 * "withdraw R200", "cash out", "payshap 150", "money to my bank", "cash at atm".
 * Returns { amountCents|null, method|null } or null. A sentence about
 * "please pay me" or a payment request is NOT a withdrawal.
 */
export function matchWithdrawAsk(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 160) return null;
  if (/\b(please pay me|pay request|payment link|request money)\b/i.test(t)) return null;
  if (!/\b(withdraw(?:al|als)?|cash ?-?out|pay ?-?out|payshap|cash ?send|cash at|atm|(?:to|into) my bank|my bank account|bank transfer|take (?:my )?money out|get (?:my )?(?:money|cash) out|money out|onttrek|khipha imali)\b/i.test(t)) return null;
  const m = t.match(/\bR?\s?(\d{1,5})(?:[.,](\d{1,2}))?\b/);
  let amountCents = null;
  if (m) { const whole = Number(m[1]); const frac = m[2] ? Number((m[2] + '0').slice(0, 2)) : 0; amountCents = whole * 100 + frac; }
  const method = /payshap|shap/i.test(t) ? 'PAYSHAP' : /atm|cash ?send|cash at/i.test(t) ? 'CASHSEND' : /\bbank\b|\beft\b|\brtc\b|account number/i.test(t) ? 'RTC' : null;
  return { amountCents, method };
}

export function parseMethodChoice(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^\W*(1|one|payshap|shap)\W*/.test(t) || /payshap/.test(t)) return 'PAYSHAP';
  if (/^\W*(2|two)\W*/.test(t) || /bank transfer|transfer|eft|rtc|account/.test(t)) return 'RTC';
  if (/^\W*(3|three)\W*/.test(t) || /atm|cash/.test(t)) return 'CASHSEND';
  return null;
}

export function parseRandAmount(text) {
  const m = String(text || '').replace(/\s/g, '').match(/^R?(\d{1,6})(?:[.,](\d{1,2}))?$/i);
  if (!m) return null;
  return Number(m[1]) * 100 + Number(((m[2] || '') + '00').slice(0, 2));
}

export function bankToBranch(text) {
  const t = String(text || '').trim();
  const digits = t.replace(/\D/g, '');
  if (/^\d{6}$/.test(digits) && digits.length === t.replace(/\s/g, '').length) return { branch_code: digits, branch_name: t.trim() };
  const key = Object.keys(BANK_BRANCH_CODES).find((k) => new RegExp(`\\b${k.replace(/ /g, '\\s*')}\\b`, 'i').test(t));
  return key ? { branch_code: BANK_BRANCH_CODES[key], branch_name: BANK_DISPLAY[key] || key } : null;
}

function recipientName(account) {
  const full = String(account?.profile?.kyc?.fullName || account?.displayName || 'WaPay Customer').trim();
  const parts = full.split(/\s+/);
  return { firstname: parts[0] || 'WaPay', surname: parts.slice(1).join(' ') || parts[0] || 'Customer' };
}

const methodMenu = (balanceCents) =>
  `💸 *Withdraw from WaPay*\n\nYou have ${R(balanceCents)} available. How would you like it?\n\n` +
  `1️⃣ *PayShap* to your bank account, instant: ${R(quotePayout({ method: 'PAYSHAP', amountCents: MIN_PAYOUT_CENTS }).feeCents)} fee, arrives in minutes\n` +
  `2️⃣ *Bank transfer* to an account number: ${R(quotePayout({ method: 'RTC', amountCents: MIN_PAYOUT_CENTS }).feeCents)} fee, usually within the hour\n` +
  `3️⃣ *Cash at an ATM* (Absa or Nedbank, no bank account needed): from ${R(quotePayout({ method: 'CASHSEND', amountCents: MIN_PAYOUT_CENTS }).feeCents)}\n\n` +
  `Reply 1, 2 or 3. Reply "cancel" to stop.`;

const KYC_ASK = `🪪 Withdrawals need a once-off identity check (it takes about two minutes on your phone). Reply *VERIFY* and I'll send you the secure link, or "cancel".`;
const KYC_PENDING = `🪪 Your identity check is still being reviewed. I'll let you know the moment it clears, and withdrawals open right away.`;
const CANCELLED = `👍 Cancelled. Your money stays in your balance.`;

/**
 * Start (or gate) a withdrawal for an onboarded customer. Returns null when
 * withdrawals are switched off (the caller keeps the coming-soon answer).
 */
export async function startWithdraw({ prisma: prismaClient = prisma, account, ask = {}, deps = {} }) {
  if (!payoutEnabled()) return null;
  const kyc = account?.profile?.kyc || {};
  if (kycRequired() && !accountKycVerified(account)) {
    return { state: 'PAYOUT_KYC', data: {}, text: kyc.status === 'PENDING' || kyc.status === 'PENDING_REVIEW' ? KYC_PENDING : KYC_ASK };
  }
  const balances = await (deps.payoutBalances || realPayoutBalances)({ prisma: prismaClient, accountId: account.id });
  if (balances.totalCents < MIN_PAYOUT_CENTS) {
    return { state: null, text: `💸 Withdrawals start at ${R(MIN_PAYOUT_CENTS)} and you have ${R(balances.totalCents)} available right now. Your balance still works for airtime, data, electricity and sending money.` };
  }
  const data = { amountCents: ask.amountCents || null, method: ask.method || null, intentId: newIntentId(), recipient: {}, balanceCents: balances.totalCents };
  if (data.method) return nextAfterMethod({ account, data });
  return { state: 'PAYOUT_METHOD', data, text: methodMenu(balances.totalCents) };
}

function newIntentId() {
  return `wa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function amountAsk(data) {
  const def = PAYOUT_METHODS[data.method];
  return { state: 'PAYOUT_AMOUNT', data, text: `How much would you like to withdraw by ${def.label}? Between ${R(MIN_PAYOUT_CENTS)} and ${R(MAX_PAYOUT_CENTS)}. You have ${R(data.balanceCents)} available; the fee comes off your balance on top of the amount.` };
}

function validateAmount(data, amountCents) {
  if (!Number.isInteger(amountCents) || amountCents < MIN_PAYOUT_CENTS || amountCents > MAX_PAYOUT_CENTS) {
    return { state: 'PAYOUT_AMOUNT', data, text: `Please enter an amount between ${R(MIN_PAYOUT_CENTS)} and ${R(MAX_PAYOUT_CENTS)}, like "200".` };
  }
  const q = quotePayout({ method: data.method, amountCents });
  if (q.totalCents > data.balanceCents) {
    const maxNet = Math.max(0, data.balanceCents - q.feeCents);
    return { state: 'PAYOUT_AMOUNT', data, text: `That is more than you have once the ${R(q.feeCents)} fee is added. You can withdraw up to ${R(Math.floor(maxNet / 100) * 100)} by ${PAYOUT_METHODS[data.method].label}.` };
  }
  return null;
}

function recipientAsk(data) {
  // PayShap on OTT's rail is addressed by account number + branch code, like
  // RTC (OTT, 2026-09-14); the customer's own WhatsApp number rides along for
  // the SMS notification, never asked for.
  if (data.method === 'CASHSEND') return { state: 'PAYOUT_MOBILE', data, text: `Which cellphone number will collect the cash at the ATM? Reply *mine* to use this WhatsApp number, or type the number. The collection code is sent to it by SMS.` };
  return { state: 'PAYOUT_ACCOUNT', data, text: `What is the bank account number the money must go to? It must be an account in your own name.` };
}

function nextAfterMethod({ account, data }) {
  if (!data.amountCents) return amountAsk(data);
  const bad = validateAmount(data, data.amountCents);
  if (bad) return bad;
  return recipientAsk(data);
}

function confirmAsk(data) {
  const q = quotePayout({ method: data.method, amountCents: data.amountCents });
  const r = data.recipient;
  const where = data.method === 'RTC' ? `account ${r.account_number} at ${r.branch_name || r.branch_code}` : data.method === 'PAYSHAP' ? `account ${r.account_number} at ${r.branch_name || r.branch_code} by PayShap` : `an Absa or Nedbank ATM (collection code to ${r.mobile})`;
  return {
    state: 'PAYOUT_CONFIRM',
    data: { ...data, feeCents: q.feeCents, totalCents: q.totalCents },
    text: `Please confirm:\n\n💸 Withdraw *${R(data.amountCents)}* to ${where}\nFee: ${R(q.feeCents)}\nLeaves your balance: *${R(q.totalCents)}*\n\nReply *YES* to continue to your PIN, or *NO* to cancel.`,
  };
}

/**
 * One customer reply inside the flow (everything except the PIN, which the
 * processor verifies before calling executeWithdraw).
 */
export async function handleWithdrawReply({ prisma: prismaClient = prisma, account, state, data = {}, text, deps = {} }) {
  const t = String(text || '').trim();
  if (CANCEL_RE.test(t)) return { state: null, text: CANCELLED, cancelled: true };
  if (state === 'PAYOUT_KYC') {
    if (/^\W*(verify|yes|ok|start)\W*$/i.test(t)) return { state: null, action: 'START_KYC' };
    return { state: null, text: CANCELLED, cancelled: true };
  }
  if (state === 'PAYOUT_METHOD') {
    const method = parseMethodChoice(t);
    if (!method) return { state, data, text: `Reply *1* for PayShap, *2* for a bank transfer, or *3* for cash at an ATM. Or "cancel".` };
    return nextAfterMethod({ account, data: { ...data, method } });
  }
  if (state === 'PAYOUT_AMOUNT') {
    const amountCents = parseRandAmount(t);
    if (amountCents == null) return { state, data, text: `Just the amount, like "200" or "R150.50".` };
    const bad = validateAmount(data, amountCents);
    if (bad) return bad;
    return recipientAsk({ ...data, amountCents });
  }
  if (state === 'PAYOUT_MOBILE') {
    const own = /^\W*(mine|me|this|this one|my number)\W*$/i.test(t);
    const raw = own ? String(account.msisdn || account.waId || '') : t;
    // Accounts hold 27-form numbers, people type 0-form: normalise first, then validate.
    const mobile = normaliseMsisdn(raw);
    if (!mobile || !(isValidSaMsisdn(mobile) || isValidSaMsisdn(raw))) return { state, data, text: `That does not look like a South African cellphone number. Type it like 073 123 4567, or reply *mine*.` };
    return confirmAsk({ ...data, recipient: { ...data.recipient, mobile } });
  }
  if (state === 'PAYOUT_ACCOUNT') {
    const digits = t.replace(/\D/g, '');
    if (digits.length < 6 || digits.length > 20) return { state, data, text: `Please type the account number only (6 to 20 digits).` };
    return { state: 'PAYOUT_BRANCH', data: { ...data, recipient: { ...data.recipient, account_number: digits } }, text: `Which bank is that account with? Reply with the bank's name (FNB, Capitec, Standard Bank, Absa, Nedbank, TymeBank, Discovery, African Bank, Investec) or its universal branch code.` };
  }
  if (state === 'PAYOUT_BRANCH') {
    const b = bankToBranch(t);
    if (!b) return { state, data, text: `I did not recognise that bank. Reply with one of: FNB, Capitec, Standard Bank, Absa, Nedbank, TymeBank, Discovery, African Bank, Investec, or the 6-digit universal branch code.` };
    const own = data.method === 'PAYSHAP' ? { mobile: normaliseMsisdn(String(account.msisdn || account.waId || '')) } : {};
    return confirmAsk({ ...data, recipient: { ...data.recipient, ...b, ...own } });
  }
  if (state === 'PAYOUT_ID') {
    const digits = t.replace(/\D/g, '');
    if (digits.length !== 13) return { state, data, text: `Your South African ID number is 13 digits. Please try again, or "cancel".` };
    return confirmAsk({ ...data, recipient: { ...data.recipient, id_number: digits } });
  }
  if (state === 'PAYOUT_CONFIRM') {
    if (/^\W*(yes|yebo|ewe|ja|y|confirm|ok|okay)\W*$/i.test(t)) return { state: 'PAYOUT_PIN', data, text: `🔐 *Enter your WaPay PIN* to withdraw ${R(data.amountCents)}.` };
    return { state: 'PAYOUT_CONFIRM', data, text: `Reply *YES* to continue or *NO* to cancel.` };
  }
  return { state: null, text: CANCELLED };
}

/** After a verified PIN: the one call that moves money. */
export async function executeWithdraw({ prisma: prismaClient = prisma, account, data, deps = {} }) {
  const recipient = { ...recipientName(account), ...(data.recipient || {}) };
  const out = await (deps.requestPayout || realRequestPayout)({ prisma: prismaClient, account, intentId: data.intentId, method: data.method, amountCents: data.amountCents, recipient, client: deps.client, providers: deps.providers });
  if (out.ok && out.status === 'SETTLED') return { state: null, done: true, text: `✅ *Done.* ${R(out.amountCents)} is on its way to you by ${PAYOUT_METHODS[data.method].label}. Reference ${out.reference}. Fee ${R(out.feeCents)}.` };
  if (out.ok && out.status === 'PENDING') return { state: null, done: true, text: `⏳ *Sent.* ${R(out.amountCents)} has been handed to the bank rail (reference ${out.reference}). I'll message you the moment the bank confirms it, usually within minutes.` };
  const why = out.error === 'INSUFFICIENT_FUNDS' ? `you no longer have ${R(out.totalCents || (data.totalCents || 0))} available` : out.error === 'KYC_REQUIRED' ? 'your identity check has not cleared yet' : out.error === 'NO_PROVIDER' ? 'that pay-out method is not available right now' : out.error === 'BAD_RECIPIENT' ? `the ${String(out.field || 'details').replace('_', ' ')} was not accepted` : out.error === 'DISABLED' || out.error === 'NOT_CONFIGURED' ? 'withdrawals are not switched on yet' : `the bank rail declined it (${out.error || 'unknown'})`;
  return { state: null, done: false, text: `❌ The withdrawal did not go through: ${why}. Nothing has left your balance. Say "withdraw" to try again.` };
}
