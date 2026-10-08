/**
 * Withdrawals INSIDE WhatsApp ("withdraw R200", "cash out", "payshap"),
 * built on lib/payouts.js the same way lib/business-chat.js sits on the
 * portal: every function returns a step { text, state, data?, action? } and
 * the processor sends it, parks the state and runs the PIN check. Nothing
 * here moves money; requestPayout does, once, after the PIN.
 *
 * Flow: (identity check once) → how → how much → where → (name once) →
 *       (ID once) → confirm → PIN → (save for next time? YES/NO).
 *   PAYSHAP  : to the customer's own bank account (account number + branch code; OTT 2026-09-14)
 *   RTC      : to a bank account (account number + bank / universal branch code)
 *   CASHSEND : ABSA CashSend, cash at an Absa ATM or a Pick n Pay / Boxer till, no bank account needed
 *   NEDCASH  : Nedbank cardless withdrawal, code by SMS
 *   EWALLET  : FNB eWallet, code by SMS, cash at any FNB ATM
 * The recipient is the customer themselves: the KYC name (profile.kyc.fullName)
 * goes to the bank rail when there is one; otherwise the full name is asked
 * once, as on the bank account, and remembered with the ID number only on an
 * explicit YES (lib/payout-beneficiaries.js, encrypted). Live only when
 * WAPAY_PAYOUT_ENABLED=true; otherwise the honest coming-soon script stays.
 *
 * Founder review 2026-10-04 (three live sandbox withdrawals): compound answers
 * ("50 and 2", "50 at ABSA", "the Nedbank one") are read as amount + method and
 * confirmed in one line (parseCompoundWithdraw, shared with the agent's clarify
 * step); the menu says "minimum withdrawals from"; after a paid withdrawal the
 * chat itself says where the code arrives and how to collect; the bank's own
 * notification is named; remembered destinations are offered by number or name.
 */

import prisma from './prisma.js';
import {
  PAYOUT_METHODS, MIN_PAYOUT_CENTS, MAX_PAYOUT_CENTS, payoutEnabled, kycRequired, accountKycVerified,
  quotePayout, methodLimits, payoutConfigured, payoutBalances as realPayoutBalances, requestPayout as realRequestPayout, resolveProviders as realResolveProviders,
} from './payouts.js';
import { matchHowItWorksAsk, howItWorksAnswer, looksLikeQuestion } from './how-it-works.js';
import { matchFeeAsk, feeAnswer } from './fee-facts.js';
import { normaliseMsisdn, isValidSaMsisdn } from './msisdn.js';
import { collectionInstructions } from './payout-collection.js';
import {
  beneficiariesAvailable, DESTINATION_FAMILY, destinationLabel, fingerprintOf, cleanNickname,
  listPayoutDestinations as realListDestinations, getPayoutIdentity as realGetIdentity,
  loadPayoutDestinationSecret as realLoadDestination, loadPayoutIdentitySecret as realLoadIdentity,
  savePayoutIdentity as realSaveIdentity, savePayoutDestination as realSaveDestination, touchPayoutDestination as realTouchDestination,
} from './payout-beneficiaries.js';

export const PAYOUT_STATES = ['PAYOUT_KYC', 'PAYOUT_METHOD', 'PAYOUT_AMOUNT', 'PAYOUT_ACCOUNT', 'PAYOUT_BRANCH', 'PAYOUT_MOBILE', 'PAYOUT_NAME', 'PAYOUT_ID', 'PAYOUT_CONFIRM', 'PAYOUT_PIN', 'PAYOUT_SAVE'];

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
  const method = /payshap|shap/i.test(t) ? 'PAYSHAP' : /\bnedbank\b/i.test(t) ? 'NEDCASH' : /e-?wallet|\bfnb\b(?!\s+account)/i.test(t) ? 'EWALLET' : /\babsa\b|atm|cash ?send|cash at/i.test(t) ? 'CASHSEND' : /\bbank\b|\beft\b|\brtc\b|account number/i.test(t) ? 'RTC' : null;
  return { amountCents, method };
}

export const ALL_METHODS = ['PAYSHAP', 'RTC', 'CASHSEND', 'NEDCASH', 'EWALLET'];
const CASH_METHODS = ['CASHSEND', 'NEDCASH', 'EWALLET'];
const BANK_METHODS = ['PAYSHAP', 'RTC'];
const METHOD_NAMES = { PAYSHAP: 'PayShap', RTC: 'a bank transfer', CASHSEND: 'cash at an Absa ATM', NEDCASH: 'cash at a Nedbank ATM', EWALLET: 'an FNB eWallet' };

/**
 * The words a customer uses for each method, one table for the state machine
 * and for the agent's clarify step and prompt (architecture session,
 * 2026-10-04: one function, two callers). A bank named together with
 * "account" is the bank-account family (PayShap), never the bank's cash
 * product: "my FNB account" is PayShap, "FNB" alone is the eWallet.
 */
export const METHOD_SYNONYMS = Object.freeze({
  PAYSHAP: ['payshap', 'pay shap', 'shap', 'shapid', 'bank account', 'my account', 'capitec', 'standard bank', 'tymebank', 'discovery', 'african bank', 'investec', 'bank zero', 'fnb account', 'absa account', 'nedbank account'],
  RTC: ['bank transfer', 'transfer', 'eft', 'rtc'],
  CASHSEND: ['absa', 'cashsend', 'cash send', 'pick n pay', 'boxer'],
  NEDCASH: ['nedbank', 'cardless'],
  EWALLET: ['ewallet', 'e-wallet', 'fnb'],
  CASH: ['cash', 'atm'],
});

/** The method a sentence names, mapped onto the options actually offered (family fallback), or null. Pure. */
export function methodFromWords(text, options = ALL_METHODS) {
  const t = String(text || '').toLowerCase();
  const offered = (list) => list.find((m) => options.includes(m)) || null;
  const bank = () => offered(BANK_METHODS);
  const cash = () => offered(CASH_METHODS);
  const pick = (m, family) => (options.includes(m) ? m : family === 'BANK' ? bank() : cash());
  if (/\bbank account\b|\b(?:to|into|in) my (?:\w+ )?account\b|\b(?:fnb|absa|nedbank|capitec|standard bank|tyme\w*|discovery|african bank|investec|bank zero)\s+(?:bank\s+)?account\b|\bshap ?id\b/.test(t)) return bank();
  if (/pay ?shap|\bshap\b/.test(t)) return pick('PAYSHAP', 'BANK');
  if (/e-?\s?wallet|\bfnb\b/.test(t)) return pick('EWALLET', 'CASH');
  if (/\bnedbank\b|cardless/.test(t)) return pick('NEDCASH', 'CASH');
  if (/\babsa\b|cash ?send|pick n pay|\bboxer\b/.test(t)) return pick('CASHSEND', 'CASH');
  if (/bank transfer|\btransfer\b|\beft\b|\brtc\b/.test(t)) return pick('RTC', 'BANK');
  if (/\bcapitec\b|standard bank|\btyme\w*|\bdiscovery\b|african bank|\binvestec\b|bank zero|\bbank\b/.test(t)) return bank();
  if (/\batm\b|\bcash\b/.test(t)) return cash();
  return null;
}

/** Menu numbers follow the options actually offered (only methods with a live provider). */
export function parseMethodChoice(text, options = ALL_METHODS) {
  const t = String(text || '').trim().toLowerCase();
  const words = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five' };
  // "1" or "1 please", never the 1 in "150" (that is an amount).
  for (let i = 0; i < options.length; i += 1) if (new RegExp(`^\\W*(?:${i + 1}|${words[i + 1]})(?!\\d)`).test(t)) return options[i];
  return methodFromWords(t, options);
}

/**
 * A compound answer, read as the customer meant it: "50 and 2", "2 and 50",
 * "50 at ABSA", "R50 payshap", "20 nedbank", "the Nedbank one", "150" (an
 * amount, not option 1), "2" (a menu number). Returns
 * { amountCents|null, method|null, menuNumber|null } or null when the text
 * carries neither. Pure: no env, no state, no prisma (founder 2026-10-04:
 * "if I say 50, 20, or 50 and 2, it should confirm, is this what you
 * meant?"). A small integer inside the menu range is a menu number, never an
 * amount: no method allows less than R20. Long digit runs (a cellphone or
 * account number) are ignored.
 */
export function parseCompoundWithdraw(text, { options = ALL_METHODS } = {}) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 160) return null;
  const t = raw.toLowerCase();
  const n = options.length;
  let method = methodFromWords(t, options);
  const nums = [...t.matchAll(/(?<![\d.,])r?\s?(\d{1,6})(?:[.,](\d{1,2}))?(?![\d])/g)]
    .map((m) => ({ cents: Number(m[1]) * 100 + Number(((m[2] || '') + '00').slice(0, 2)), int: m[2] ? null : Number(m[1]) }));
  const isMenu = (x) => x.int != null && x.int >= 1 && x.int <= n;
  let amountCents = null;
  let menuNumber = null;
  const useMenu = (x) => { menuNumber = x.int; method = options[x.int - 1]; };
  if (nums.length >= 2) {
    const menus = nums.filter(isMenu);
    const others = nums.filter((x) => !isMenu(x));
    if (others.length) amountCents = others[0].cents;
    if (!method && menus.length === 1 && others.length) useMenu(menus[0]);
    else if (!method && !others.length && menus.length) useMenu(menus[0]);
  } else if (nums.length === 1) {
    const x = nums[0];
    if (isMenu(x)) { if (!method) useMenu(x); }
    else amountCents = x.cents;
  }
  if (amountCents == null && !method) return null;
  return { amountCents, method, menuNumber };
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

/**
 * "Thandi Nkosi": two or more words of letters (hyphens and apostrophes
 * allowed), no digits, as on the bank account or the ID. Returns the cleaned
 * name or null.
 */
export function cleanFullName(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t || t.length < 3 || t.length > 80) return null;
  if (!/^[\p{L}][\p{L}' -]*$/u.test(t)) return null;
  const parts = t.split(' ').filter(Boolean);
  if (parts.length < 2 || parts.some((p) => p.replace(/[^\p{L}]/gu, '').length < 1)) return null;
  return parts.join(' ');
}

/**
 * The name that goes to the bank: the verified KYC name when there is one,
 * else the name the customer gave as on the account (this time or saved).
 * Never displayName twice: "Nieuwoudt Nieuwoudt" reached the rail on
 * 2026-10-04 because a one-word display name was split into first + last.
 */
function recipientName(account, fullName = null) {
  const full = String(account?.profile?.kyc?.fullName || fullName || '').trim();
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return { firstname: parts[0], surname: parts.slice(1).join(' ') };
  const one = parts[0] || String(account?.displayName || '').trim().split(/\s+/)[0] || 'WaPay';
  return { firstname: one, surname: 'Customer' };
}

const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
const methodLine = (method, limits, balanceCents = null) => {
  const min = limits?.[method]?.minCents || MIN_PAYOUT_CENTS;
  const lim = { minCents: min, maxCents: limits?.[method]?.maxCents || MAX_PAYOUT_CENTS };
  const need = needAt(method, lim);
  const fee = R(need - min);
  // When the balance cannot cover the minimum plus its fee, the line says so
  // (founder test 2026-09-17: a pickable option the customer could not use).
  const short = balanceCents != null && need > balanceCents ? ' (needs ' + R(need) + ' with the fee)' : '';
  // Founder 2026-10-04: "(from R50)" was not clear; say "minimum withdrawals from". No time promised.
  const minimum = 'Minimum withdrawals from ' + R(min) + '.';
  if (method === 'PAYSHAP') return '*PayShap* to your bank account: ' + fee + ' fee. ' + minimum + short;
  if (method === 'RTC') return '*Bank transfer* to an account number: ' + fee + ' fee. ' + minimum + short;
  if (method === 'NEDCASH') return '*Cash at a Nedbank ATM*, code by SMS, no bank account needed: from ' + fee + ' fee. ' + minimum + short;
  if (method === 'EWALLET') return '*FNB eWallet*: cash at any FNB ATM with the code sent by SMS, no bank account needed: from ' + fee + ' fee. ' + minimum + short;
  return '*Cash at an Absa ATM* or a Pick n Pay / Boxer till, no bank account needed: from ' + fee + ' fee. ' + minimum + short;
};
const methodMenu = (balanceCents, options = ALL_METHODS, limits = {}) => {
  const needOf = (m) => { const min = limits?.[m]?.minCents || MIN_PAYOUT_CENTS; return needAt(m, { minCents: min, maxCents: limits?.[m]?.maxCents || MAX_PAYOUT_CENTS }); };
  const short = balanceCents != null ? options.filter((m) => needOf(m) > balanceCents) : [];
  const covered = options.filter((m) => !short.includes(m));
  // Founder 2026-10-08: say plainly which methods the balance does not cover
  // and what to do about it ("add money" works from inside the flow).
  const hint = short.length
    ? `\n\n💡 With ${R(balanceCents)} you cannot use ${short.map((m) => METHOD_SHORT[m] || PAYOUT_METHODS[m]?.label).join(' or ')} yet (${short.map((m) => R(needOf(m))).join(' and ')} with the fee). Say *add money* to top up, or ` +
      (covered.length ? `reply ${covered.map((m) => `*${options.indexOf(m) + 1}*`).join(' or ')} for ${covered.map((m) => METHOD_SHORT[m] || PAYOUT_METHODS[m]?.label).join(' or ')}.` : 'come back once your balance covers it.')
    : '';
  return `💸 *Withdraw from WaPay*\n\nYou have ${R(balanceCents)} available. How would you like it?\n\n` +
    options.map((m, i) => `${NUM[i]} ${methodLine(m, limits, balanceCents)}`).join('\n') +
    `\n\nReply ${options.map((_, i) => i + 1).join(', ').replace(/, (\d)$/, ' or $1')}. Reply "cancel" to stop.` + hint;
};
const shortMenu = (options = ALL_METHODS) => `Reply ${options.map((m, i) => `*${i + 1}* for ${METHOD_NAMES[m]}`).join(', ')}.`;

const KYC_ASK = `🪪 Withdrawals need a once-off identity check (it takes about two minutes on your phone). Reply *VERIFY* and I'll send you the secure link, or "cancel".`;
const KYC_PENDING = `🪪 Your identity check is still being reviewed. I'll let you know the moment it clears, and withdrawals open right away.`;
const CANCELLED = `👍 Cancelled. Your money stays in your balance.`;

/** What this account has remembered (labels and masks only), or nothing when the vault is off. */
async function savedDetailsFor({ prisma: prismaClient, account, deps }) {
  const none = { identity: null, destinations: [] };
  if (!account?.id) return none;
  const list = deps.listDestinations || (beneficiariesAvailable() ? realListDestinations : null);
  const ident = deps.getIdentity || (beneficiariesAvailable() ? realGetIdentity : null);
  if (!list && !ident) return none;
  const [destinations, identity] = await Promise.all([
    list ? list({ prisma: prismaClient, accountId: account.id }).catch(() => []) : [],
    ident ? ident({ prisma: prismaClient, accountId: account.id }).catch(() => null) : null,
  ]);
  return { identity: identity ? { fullName: identity.fullName, idLast3: identity.idLast3 } : null, destinations: (destinations || []).map((d) => ({ id: d.id, method: d.method, family: d.family || DESTINATION_FAMILY[d.method] || null, label: d.label, nickname: d.nickname || null, fingerprint: d.fingerprint || null })) };
}

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
  // Only methods OTT has a live provider for are offered; each carries its own limits and
  // required fields (OTT test merchant 2026-09-15: PayShap + ABSA CashSend, no RTC; every
  // provider requires the recipient's ID number).
  const live = await liveProviders(deps);
  const options = live ? ALL_METHODS.filter((m) => live.some((p) => p.method === m)) : ALL_METHODS;
  if (options.length === 0) {
    return { state: null, text: `💸 Withdrawals are being switched on with our bank partner and are not available for a little while. Your balance still works for airtime, data, electricity and sending money.` };
  }
  const limits = Object.fromEntries(options.map((m) => [m, methodLimits(m, live || [])]));
  const fields = Object.fromEntries(options.map((m) => [m, (live || []).find((p) => p.method === m)?.requiredFields || PAYOUT_METHODS[m].fields]));
  const minAll = Math.min(...options.map((m) => limits[m].minCents));
  const needAll = Math.min(...options.map((m) => needAt(m, limits[m])));
  if (balances.totalCents < needAll) {
    return { state: null, text: '💸 Withdrawals start at ' + R(minAll) + ' plus the fee, so the smallest one needs ' + R(needAll) + ', and you have ' + R(balances.totalCents) + ' available right now. Your balance still works for airtime, data, electricity and sending money.' };
  }
  const saved = await savedDetailsFor({ prisma: prismaClient, account, deps });
  const method = ask.method && options.includes(ask.method) ? ask.method : null;
  const data = { amountCents: ask.amountCents || null, method, intentId: newIntentId(), recipient: {}, balanceCents: balances.totalCents, options, limits, fields, kycName: account?.profile?.kyc?.fullName || null, identity: saved.identity, saved: saved.destinations };
  if (data.method) return nextAfterMethod({ account, data });
  return { state: 'PAYOUT_METHOD', data, text: methodMenu(balances.totalCents, options, limits) };
}

async function liveProviders(deps) {
  if (deps.resolveProviders) return deps.resolveProviders();
  if (!payoutConfigured()) return null;
  return realResolveProviders({}).catch(() => null);
}
const limitsFor = (data) => data?.limits?.[data.method] || { minCents: MIN_PAYOUT_CENTS, maxCents: MAX_PAYOUT_CENTS };
const totalAt = (method, amountCents, lim) => quotePayout({ method, amountCents, minCents: lim.minCents, maxCents: lim.maxCents }).totalCents;
/** The minimum for a method plus the fee at that minimum: what the balance must cover to use it at all. */
const needAt = (method, lim) => totalAt(method, lim.minCents, lim);

/**
 * The largest whole-rand amount inside the method's limits whose amount plus
 * fee fits the balance; null when even the minimum plus its fee does not.
 * Founder test 2026-09-17: R66 against CashSend (R50 minimum, R18 fee) was
 * bounced between "you can withdraw up to R48" and "R48 is below the R50
 * minimum". Fees are banded and never fall as the amount rises, so the
 * total is monotonic and a binary search on whole rands is exact.
 */
export function affordableMaxCents({ method, balanceCents, limits }) {
  const lim = limits?.[method] || { minCents: MIN_PAYOUT_CENTS, maxCents: MAX_PAYOUT_CENTS };
  const balance = Number.isFinite(Number(balanceCents)) ? Number(balanceCents) : 0;
  if (!PAYOUT_METHODS[method] || totalAt(method, lim.minCents, lim) > balance) return null;
  let lo = Math.floor(lim.minCents / 100);
  let hi = Math.floor(Math.min(lim.maxCents, balance) / 100);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (totalAt(method, mid * 100, lim) <= balance) lo = mid; else hi = mid - 1;
  }
  return lo * 100;
}

/**
 * The best OTHER method for this exact amount: within its limits, affordable
 * with the fee, cheapest first. Founder review 2026-09-18: "It already knows
 * which option to choose ... you should just recommend it", so a refusal
 * names one next step instead of sending the customer back to the menu.
 */
const METHOD_FAMILY = { PAYSHAP: 'BANK', RTC: 'BANK', CASHSEND: 'CASH', NEDCASH: 'CASH', EWALLET: 'CASH' };
/** Cash stays cash: someone collecting at an ATM is not sent to find a bank account. */
function bestAlternativeFor(data, amountCents) {
  const options = data.options || ALL_METHODS;
  const family = METHOD_FAMILY[data.method] || null;
  const priced = options
    .filter((m) => m !== data.method)
    .map((m) => {
      const lim = data.limits?.[m] || { minCents: MIN_PAYOUT_CENTS, maxCents: MAX_PAYOUT_CENTS };
      if (amountCents < lim.minCents || amountCents > lim.maxCents) return null;
      const total = totalAt(m, amountCents, lim);
      if (total > data.balanceCents) return null;
      return { method: m, feeCents: total - amountCents, totalCents: total };
    })
    .filter(Boolean)
    .map((p) => ({ ...p, sameFamily: METHOD_FAMILY[p.method] === family }))
    .sort((a, b) => (b.sameFamily ? 1 : 0) - (a.sameFamily ? 1 : 0) || a.feeCents - b.feeCents || options.indexOf(a.method) - options.indexOf(b.method));
  return priced[0] || null;
}

/** " I will need your ID number for that one." when the switch adds that step. */
function extraStepClause(data, method) {
  const needs = (m) => (data.fields?.[m] || PAYOUT_METHODS[m]?.fields || []);
  const adds = needs(method).includes('id_number') && !needs(data.method).includes('id_number') && !data.recipient?.id_number && !data.identity;
  return adds ? ' I will need your ID number for that one.' : '';
}

/** One next step, as a yes/no: the customer never has to re-pick from a list. */
function offerSwitch({ data, amountCents, lead }) {
  const alt = bestAlternativeFor(data, amountCents);
  if (!alt) return null;
  const crossed = !alt.sameFamily && METHOD_FAMILY[data.method] === 'CASH';
  return {
    state: 'PAYOUT_AMOUNT',
    data: { ...data, offerMethod: alt.method, offerAmountCents: amountCents },
    text: lead + ' ' + (METHOD_SHORT[alt.method] || PAYOUT_METHODS[alt.method]?.label) +
      ' takes ' + R(amountCents) + ' for an ' + R(alt.feeCents) + ' fee, so ' + R(alt.totalCents) +
      ' leaves your balance.' + (crossed ? ' That one pays into a bank account, not cash.' : '') +
      extraStepClause(data, alt.method) +
      ' Reply *YES* to switch to that, or type another amount.',
  };
}

/** The customer picked (or the agent proposed) a method the balance cannot cover: say why, offer the ones it can. */
function methodUnaffordable(data) {
  const options = data.options || ALL_METHODS;
  const lim = limitsFor(data);
  const need = needAt(data.method, lim);
  const fact = 'With ' + R(data.balanceCents) + ' you cannot use ' +
    (METHOD_SHORT[data.method] || PAYOUT_METHODS[data.method]?.label) + ' yet: the ' +
    R(lim.minCents) + ' minimum plus the ' + R(need - lim.minCents) + ' fee is ' + R(need) + '.';
  // The code already knows which methods the balance covers and the most each
  // can pay, so it names ONE and offers it (founder review 2026-09-18).
  const family = METHOD_FAMILY[data.method] || null;
  const ranked = options
    .filter((m) => m !== data.method)
    .map((m) => ({ method: m, max: affordableMaxCents({ method: m, balanceCents: data.balanceCents, limits: data.limits }) }))
    .filter((x) => x.max != null)
    .sort((a, b) => (METHOD_FAMILY[b.method] === family ? 1 : 0) - (METHOD_FAMILY[a.method] === family ? 1 : 0) || b.max - a.max || options.indexOf(a.method) - options.indexOf(b.method));
  const pick = ranked[0];
  if (!pick) {
    return { state: 'PAYOUT_METHOD', data: { ...data, method: null }, text: fact + ' Add money first, or "cancel".' };
  }
  const pickLim = data.limits?.[pick.method] || { minCents: MIN_PAYOUT_CENTS, maxCents: MAX_PAYOUT_CENTS };
  const crossedHere = METHOD_FAMILY[pick.method] !== family && family === 'CASH';
  return {
    state: 'PAYOUT_METHOD',
    data: { ...data, method: null, offerMethod: pick.method },
    text: fact + ' ' + sentence(METHOD_SHORT[pick.method] || PAYOUT_METHODS[pick.method]?.label) +
      ' starts at ' + R(pickLim.minCents) + ' and you can take up to ' + R(pick.max) + ' today.' +
      (crossedHere ? ' That one pays into a bank account, not cash.' : '') +
      extraStepClause(data, pick.method) +
      ' Reply *YES* to use that, or say "add money".',
  };
}

function newIntentId() {
  return `wa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function amountAsk(data) {
  const def = PAYOUT_METHODS[data.method];
  const lim = limitsFor(data);
  const cap = affordableMaxCents({ method: data.method, balanceCents: data.balanceCents, limits: data.limits });
  const top = cap == null ? lim.maxCents : Math.min(lim.maxCents, cap);
  return { state: 'PAYOUT_AMOUNT', data, text: 'How much would you like to withdraw by ' + def.label + '? Between ' + R(lim.minCents) + ' and ' + R(top) + '. You have ' + R(data.balanceCents) + ' available; the fee comes off your balance on top of the amount.' };
}
/** A method label that opens a sentence: 'cash at a Nedbank ATM' -> 'Cash at a...'. */
const sentence = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s);
const METHOD_SHORT = { PAYSHAP: 'PayShap', RTC: 'a bank transfer', CASHSEND: 'cash at an Absa ATM', NEDCASH: 'cash at a Nedbank ATM', EWALLET: 'an FNB eWallet' };
function validateAmount(data, amountCents) {
  const lim = limitsFor(data);
  if (!Number.isInteger(amountCents)) return { state: 'PAYOUT_AMOUNT', data, text: `Please enter an amount between ${R(lim.minCents)} and ${R(lim.maxCents)}, like "200".` };
  if (amountCents < lim.minCents) {
    // Founder 2026-09-15: "20" against Absa's R50 minimum got the same line three times. Name the
    // minimum, the method, and the methods that DO allow this amount.
    const lead = R(amountCents) + ' is below the ' + R(lim.minCents) + ' minimum for ' +
      (METHOD_SHORT[data.method] || PAYOUT_METHODS[data.method]?.label) + ', but';
    const offer = offerSwitch({ data, amountCents, lead });
    if (offer) return offer;
    return { state: 'PAYOUT_AMOUNT', data, text: `${R(amountCents)} is below the ${R(lim.minCents)} minimum for ${METHOD_SHORT[data.method] || PAYOUT_METHODS[data.method]?.label}. Please type an amount of ${R(lim.minCents)} or more, or "cancel".` };
  }
  if (amountCents > lim.maxCents) {
    const leadMax = R(amountCents) + ' is above the ' + R(lim.maxCents) + ' maximum for one withdrawal by ' +
      (METHOD_SHORT[data.method] || PAYOUT_METHODS[data.method]?.label) + ', but';
    const offerMax = offerSwitch({ data, amountCents, lead: leadMax });
    if (offerMax) return offerMax;
    return { state: 'PAYOUT_AMOUNT', data, text: `${R(amountCents)} is above the ${R(lim.maxCents)} maximum for one withdrawal by ${METHOD_SHORT[data.method] || PAYOUT_METHODS[data.method]?.label}. Please type an amount up to ${R(lim.maxCents)}, or "cancel".` };
  }
  const q = quotePayout({ method: data.method, amountCents, minCents: lim.minCents, maxCents: lim.maxCents });
  if (q.totalCents > data.balanceCents) {
    // A cheaper method may still carry the full amount: offer that before
    // asking the customer to settle for less (founder review 2026-09-18).
    const leadFee = 'With the ' + R(q.feeCents) + ' fee that is more than you have by ' +
      (METHOD_SHORT[data.method] || PAYOUT_METHODS[data.method]?.label) + ', but';
    const offerFee = offerSwitch({ data, amountCents, lead: leadFee });
    if (offerFee) return offerFee;
    const cap = affordableMaxCents({ method: data.method, balanceCents: data.balanceCents, limits: data.limits });
    if (cap == null) return methodUnaffordable(data);
    // The fee is banded, so it is quoted AT the ceiling, never at the amount
    // the customer typed, and the ceiling is offered rather than stated.
    const capQ = quotePayout({ method: data.method, amountCents: cap, minCents: lim.minCents, maxCents: lim.maxCents });
    return {
      state: 'PAYOUT_AMOUNT',
      data: { ...data, offerMethod: null, offerAmountCents: cap },
      text: 'With the ' + R(capQ.feeCents) + ' fee, ' + R(cap) + ' is the most you can take by ' +
        (METHOD_SHORT[data.method] || PAYOUT_METHODS[data.method]?.label) + ' right now (' + R(cap) +
        ' to you, ' + R(capQ.totalCents) + ' off your balance). Withdraw ' + R(cap) + '? Reply *YES*, or type a smaller amount.',
    };
  }
  return null;
}

/**
 * Amount and method in one message: validate as if the method had been
 * picked, then confirm both in ONE line; YES carries on through the normal
 * sequence via the existing offer mechanism (no new state).
 */
function compoundConfirm({ data, method, amountCents, state }) {
  const withMethod = { ...data, method, offerMethod: null, offerAmountCents: null };
  if (affordableMaxCents({ method, balanceCents: data.balanceCents, limits: data.limits }) == null) return methodUnaffordable(withMethod);
  const bad = validateAmount(withMethod, amountCents);
  if (bad) return bad;
  const text = `Got it: ${R(amountCents)} by ${METHOD_SHORT[method] || PAYOUT_METHODS[method]?.label}. Is that right? Reply *YES* to carry on, or tell me what to change.`;
  if (state === 'PAYOUT_METHOD') return { state: 'PAYOUT_METHOD', data: { ...data, amountCents, offerMethod: method, offerAmountCents: null }, text };
  return { state: 'PAYOUT_AMOUNT', data: { ...data, offerMethod: method, offerAmountCents: amountCents }, text };
}

/** A saved destination picked by number ("1"), or by a word in its label ("the fnb one", "394"). */
export function pickSavedDestination(text, choices = []) {
  if (!Array.isArray(choices) || !choices.length) return null;
  const s = String(text || '').trim().toLowerCase();
  const m = s.match(/^\W*(\d)\W*$/);
  if (m) { const i = Number(m[1]); return i >= 1 && i <= choices.length ? choices[i - 1] : null; }
  const words = s.replace(/\b(the|one|my|that|saved|account|number|please|use)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return null;
  const hits = choices.filter((c) => { const l = String(c.label || '').toLowerCase(); return l.includes(words) || words.split(' ').every((w) => l.includes(w)); });
  return hits.length === 1 ? hits[0] : null;
}

function recipientAsk(data) {
  // PayShap on OTT's rail is addressed by account number + branch code, like
  // RTC (OTT, 2026-09-14); the customer's own WhatsApp number rides along for
  // the SMS notification, never asked for.
  const family = DESTINATION_FAMILY[data.method];
  const choices = (data.saved || []).filter((d) => d.family === family).slice(0, 5);
  if (choices.length) {
    const list = choices.map((d, i) => `${NUM[i]} ${d.label}`).join('\n');
    if (family === 'BANK') return { state: 'PAYOUT_ACCOUNT', data: { ...data, savedChoices: choices }, text: `Which account should the money go to? These are saved:\n\n${list}\n\nReply the number, or type a new account number (it must be an account in your own name).` };
    const what = data.method === 'NEDCASH' ? 'withdrawal code' : data.method === 'EWALLET' ? 'eWallet code' : 'collection code';
    return { state: 'PAYOUT_MOBILE', data: { ...data, savedChoices: choices }, text: `Which cellphone number should get the ${what} by SMS? These are saved:\n\n${list}\n\nReply the number, *mine* for this WhatsApp number, or type another number.` };
  }
  if (data.method === 'CASHSEND') return { state: 'PAYOUT_MOBILE', data, text: `Which cellphone number will collect the cash at the Absa ATM or till? Reply *mine* to use this WhatsApp number, or type the number. The collection code is sent to it by SMS.` };
  if (data.method === 'NEDCASH') return { state: 'PAYOUT_MOBILE', data, text: `Which cellphone number will collect the cash at the Nedbank ATM? Reply *mine* to use this WhatsApp number, or type the number. The withdrawal code is sent to it by SMS.` };
  if (data.method === 'EWALLET') return { state: 'PAYOUT_MOBILE', data, text: `Which cellphone number should receive the FNB eWallet? Reply *mine* to use this WhatsApp number, or type the number. The eWallet code is sent to it by SMS and the cash is collected at any FNB ATM.` };
  return { state: 'PAYOUT_ACCOUNT', data, text: `What is the bank account number the money must go to? It must be an account in your own name.` };
}

function nextAfterMethod({ account, data }) {
  if (affordableMaxCents({ method: data.method, balanceCents: data.balanceCents, limits: data.limits }) == null) return methodUnaffordable(data);
  if (!data.amountCents) return amountAsk(data);
  const bad = validateAmount(data, data.amountCents);
  if (bad) return bad;
  return recipientAsk(data);
}
const nameSource = (data) => (DESTINATION_FAMILY[data.method] === 'BANK' ? 'bank account' : 'ID');
/**
 * After the destination: the full name once (unless KYC has it or it is
 * saved), then the ID number once (unless it is saved), then confirm. The
 * provider's required fields decide whether the ID number is needed at all.
 */
function afterRecipient(data) {
  const need = data.fields?.[data.method] || PAYOUT_METHODS[data.method]?.fields || [];
  const haveName = !!(data.kycName || data.recipient?.fullName || data.identity?.fullName);
  if (!haveName) {
    return { state: 'PAYOUT_NAME', data, text: `What is your full name, exactly as it appears on your ${nameSource(data)}? First name and surname, please.` };
  }
  if (need.includes('id_number') && !data.recipient?.id_number && !data.identity) {
    return { state: 'PAYOUT_ID', data, text: `The bank needs your 13-digit South African ID number for this payout (it must match the account holder). Please type it, or "cancel".` };
  }
  return confirmAsk(data);
}

function confirmAsk(data) {
  const lim = limitsFor(data);
  const q = quotePayout({ method: data.method, amountCents: data.amountCents, minCents: lim.minCents, maxCents: lim.maxCents });
  const r = data.recipient;
  const saved = r.savedLabel ? r.savedLabel : null;
  const where = saved
    ? (DESTINATION_FAMILY[data.method] === 'BANK' ? `${saved}${data.method === 'PAYSHAP' ? ' by PayShap' : ''}` : saved)
    : data.method === 'RTC' ? `account ${r.account_number} at ${r.branch_name || r.branch_code}` : data.method === 'PAYSHAP' ? `account ${r.account_number} at ${r.branch_name || r.branch_code} by PayShap` : data.method === 'NEDCASH' ? `a Nedbank ATM (withdrawal code to ${r.mobile})` : data.method === 'EWALLET' ? `an FNB eWallet on ${r.mobile} (cash at any FNB ATM)` : `an Absa ATM or a Pick n Pay / Boxer till (collection code to ${r.mobile})`;
  const name = data.kycName || r.fullName || data.identity?.fullName || null;
  const idLine = r.id_number ? `ID number: •••${String(r.id_number).slice(-3)}` : data.identity?.idLast3 ? `ID number: •••${data.identity.idLast3} (saved)` : null;
  const lines = [
    'Please confirm:',
    '',
    `💸 Withdraw *${R(data.amountCents)}* to ${where}`,
    name ? `Name on the account: ${name}` : null,
    idLine,
    `Fee: ${R(q.feeCents)}`,
    `Total leaving your balance: *${R(q.totalCents)}* (${R(data.amountCents)} + ${R(q.feeCents)} fee)`,
    `Balance after: *${R(Math.max(0, (data.balanceCents || 0) - q.totalCents))}*`,
    '',
    'Reply *YES* to continue to your PIN, or *NO* to cancel.',
  ].filter((l) => l !== null);
  return { state: 'PAYOUT_CONFIRM', data: { ...data, feeCents: q.feeCents, totalCents: q.totalCents }, text: lines.join('\n') };
}

/**
 * A message that belongs to another flow ("add money", "buy airtime", "send
 * R50", "balance"): the withdrawal is dropped and the processor answers the
 * message as new (passthrough). Founder 2026-10-08: the flow's own reply said
 * "say add money" and then answered "add money" with the method menu.
 */
export const OTHER_FLOW = /^\W*(?:(?:i (?:want|need|would like|wanna|'d like) to|i want|i need|please|can i|can you|could you|let me|let'?s|help me(?: to)?)\s+)?(?:(?:add|load|deposit|put|top ?up)\b[^.?!]{0,30}\b(?:money|cash|funds|wallet|wapay|balance|account)\b.*|add money|load money|top ?up|deposit|add funds|load funds|(?:buy|purchase|get)\b[^.?!]{0,30}\b(?:airtime|data|electricity|bundles?|vouchers?|fuel|petrol)\b.*|send\b[^.?!]{0,30}\b(?:money|airtime|data|r ?\d).*|please pay me\b.*|pay me\b.*|(?:my |check (?:my )?)?balance|my vouchers|my transactions|transaction history|history)\W*$/i;
export function wantsAnotherFlow(text) {
  return OTHER_FLOW.test(String(text || '').trim());
}

/**
 * "Save these details for next time?" answered in a sentence: "Yes please
 * save my bank details as mine" is a yes with the nickname "Mine"; "mother"
 * alone is a yes with that nickname; "no thanks" is a no; "buy airtime" is
 * neither and passes through. Pure.
 */
const SAVE_NO = /^\W*(?:no|nope|nah|n|nee|cha|hayi|not now|don'?t|do not|never|later)\b/i;
const SAVE_YES = /^\W*(?:yes|yebo|ewe|ja|ee|eya|y|yeah|yep|yup|ok|okay|sure|please|definitely|of course)\b|\b(?:save|keep|remember|store)\b/i;
const NICK_AFTER = /\b(?:as|call(?:ed)?(?: it| them| this)?|name(?:d)?(?: it| them)?|under|label(?:led)?(?: it)?|nickname)\s+["'“‘]?([\p{L}][\p{L}' -]{0,23}?)["'”’]?\s*[.!]?\s*$/iu;
const COMMAND_WORD = /\b(?:cancel|stop|home|menu|help|hi|hello|withdraw|airtime|data|electricity|vouchers?|balance|deposit|send|pay|buy|load)\b/i;
export function parseSaveAnswer(text) {
  const t = String(text || '').trim();
  if (!t) return { kind: 'other', nickname: null };
  if (/\b(?:don'?t|do not|never)\s+(?:save|keep|remember|store)\b/i.test(t)) return { kind: 'no', nickname: null };
  if (SAVE_NO.test(t) && !/^\W*(?:yes|yebo|ja|ok|okay)\b/i.test(t)) return { kind: 'no', nickname: null };
  const m = t.match(NICK_AFTER);
  const nickname = m ? cleanNickname(m[1]) : null;
  if (SAVE_YES.test(t)) return { kind: 'yes', nickname };
  const bare = cleanNickname(t);
  if (bare && !wantsAnotherFlow(t) && !COMMAND_WORD.test(t)) return { kind: 'yes', nickname: bare };
  return { kind: 'other', nickname: null };
}

/** "You have it stored", "my bank account", "don't you have my details?": answer from the saved list, then the step. */
const SAVED_ASK = /\b(?:stored|saved|on record|on file|remember(?:ed)?|you have (?:it|my|them)|have it|use (?:my|the) saved|my (?:bank )?(?:account|details)|account (?:info|details)|which (?:accounts?|numbers?) do you have)\b/i;
function savedAnswer(data) {
  const family = DESTINATION_FAMILY[data.method];
  const here = (data.saved || []).filter((d) => d.family === family).slice(0, 5);
  const other = (data.saved || []).filter((d) => d.family !== family);
  const what = family === 'BANK' ? 'bank account' : 'cellphone number';
  const typed = family === 'BANK' ? 'bank account number' : 'cellphone number';
  if (here.length) {
    return { choices: here, text: `Saved for this:\n\n${here.map((d, i) => `${NUM[i]} ${d.label}`).join('\n')}\n\nReply the number to use it, or type a new ${typed}.` };
  }
  const also = other.length ? ` I do have ${other.map((d) => d.label).join(', ')} saved for ${family === 'BANK' ? 'cash' : 'bank'} withdrawals.` : '';
  return { choices: null, text: `Nothing is saved for a ${what} yet.${also} Type the ${typed} now and I will offer to save it for next time.` };
}

const YES_RE = /^\W*(?:yes|yebo|ewe|ja|ee|eya|y|yeah|yep|ok|okay|sure|please|do it|switch|proceed|continue|confirm|save)\W*$/i;
const NO_RE = /^\W*(?:no|nope|nah|n|nee|cha|hayi|no thanks|no thank you|rather not|not now|don'?t|do not)\W*$/i;

/**
 * One customer reply inside the flow (everything except the PIN, which the
 * processor verifies before calling executeWithdraw).
 */
export async function handleWithdrawReply({ prisma: prismaClient = prisma, account, state, data = {}, text, deps = {} }) {
  const t = String(text || '').trim();
  // "Save these details for next time?" after a pay-out the rail accepted. A
  // yes-only write and never a trap: YES saves, NO keeps nothing, anything
  // else keeps nothing AND is answered as a fresh message (passthrough).
  if (state === 'PAYOUT_SAVE') {
    const answer = parseSaveAnswer(t);
    if (answer.kind === 'yes') {
      const r = data.recipient || {};
      const kept = [];
      if (data.saveDestination) {
        const d = await (deps.saveDestination || realSaveDestination)({ prisma: prismaClient, accountId: account.id, method: data.method, recipient: r, nickname: answer.nickname }).catch(() => ({ ok: false }));
        if (d?.ok) kept.push(d.label);
      }
      if (data.saveIdentity && r.fullName && r.id_number) {
        const s = await (deps.saveIdentity || realSaveIdentity)({ prisma: prismaClient, accountId: account.id, fullName: r.fullName, idNumber: r.id_number }).catch(() => ({ ok: false }));
        if (s?.ok) kept.push(`your name and ID number ending ${s.idLast3}`);
      }
      if (!kept.length) return { state: null, text: `I could not save those details just now, so nothing is kept. Your withdrawal is not affected.` };
      const as = answer.nickname ? ` as *${answer.nickname}*` : '';
      return { state: null, text: `✅ Saved${as}, encrypted: ${kept.join(' and ')}. Next time you withdraw, just pick it from the list${answer.nickname ? ` or say "${answer.nickname.toLowerCase()}"` : ''}. Say "forget my bank details" any time and they are erased.` };
    }
    if (answer.kind === 'no') return { state: null, text: `👍 Not saved. Nothing is kept, and I will ask you to type the details next time.` };
    return { state: null, passthrough: true };
  }
  // Another flow asked for mid-withdrawal ("add money", "buy airtime", "balance"):
  // drop this one and let the processor answer the message as new.
  if (state !== 'PAYOUT_KYC' && wantsAnotherFlow(t)) return { state: null, passthrough: true };
  // "You have it stored" / "my bank account" / "don't you have my details?" at a
  // destination step: answer from the saved list, then repeat the step.
  if ((state === 'PAYOUT_ACCOUNT' || state === 'PAYOUT_MOBILE') && SAVED_ASK.test(t) && !/\d{6,}/.test(t) && !pickSavedDestination(t, data.savedChoices)) {
    const ans = savedAnswer(data);
    return { state, data: { ...data, savedChoices: ans.choices || data.savedChoices || null }, text: ans.text };
  }
  // "menu" / "back" / "change" from any step returns to the method menu (checked BEFORE cancel:
  // the founder's "Home" used to cancel the whole withdrawal); a valid amount already given is kept.
  if (state !== 'PAYOUT_KYC' && state !== 'PAYOUT_METHOD' && /^\W*(menu|back|change|change method|other|options|methods?|start over)\W*$/i.test(t)) {
    return { state: 'PAYOUT_METHOD', data: { ...data, method: null, recipient: {}, savedChoices: null }, text: methodMenu(data.balanceCents, data.options || ALL_METHODS, data.limits || {}) };
  }
  // An offer invites a yes, so a person answers "no". That must not throw the
  // withdrawal away: clear the offer and ask again (review 2026-09-18).
  // "cancel" and "stop" still cancel.
  if ((data.offerMethod || data.offerAmountCents) && /^\W*(?:no|nope|nah|no thanks|no thank you|rather not)\W*$/i.test(t)) {
    const kept = { ...data, offerMethod: null, offerAmountCents: null };
    const stay = state === 'PAYOUT_METHOD'
      ? { state: 'PAYOUT_METHOD', data: kept, text: methodMenu(kept.balanceCents, kept.options || ALL_METHODS, kept.limits || {}) }
      : amountAsk(kept);
    return stay;
  }
  if (CANCEL_RE.test(t)) return { state: null, text: CANCELLED, cancelled: true };
  // A question in the middle of the flow is answered and the step is repeated;
  // it is never read as a menu choice or an amount (founder review 2026-09-15:
  // "If I send someone money, can they withdraw it?" was answered "Reply 1, 2 or 3").
  if (state !== 'PAYOUT_KYC' && looksLikeQuestion(t) && !stepInputParses(state, t, data, account)) {
    const aside = answerAside(t, data);
    return { state, data, text: `${aside}\n\n↩️ Back to your withdrawal. ${reprompt(state, data)}` };
  }
  if (state === 'PAYOUT_KYC') {
    if (/^\W*(verify|yes|ok|start)\W*$/i.test(t)) return { state: null, action: 'START_KYC' };
    return { state: null, text: CANCELLED, cancelled: true };
  }
  if (state === 'PAYOUT_METHOD') {
    const options = data.options || ALL_METHODS;
    // "YES" takes the method the last reply offered (and the amount already given).
    if (data.offerMethod && YES_RE.test(t)) {
      return nextAfterMethod({ account, data: { ...data, method: data.offerMethod, offerMethod: null } });
    }
    // Compound answers: "50 and 2", "50 at ABSA", "R50 payshap"; a bare "150" is
    // an amount, kept while the method is asked again (founder 2026-10-04).
    const compound = parseCompoundWithdraw(t, { options });
    if (compound && compound.amountCents != null) {
      if (compound.method) return compoundConfirm({ data, method: compound.method, amountCents: compound.amountCents, state: 'PAYOUT_METHOD' });
      return { state, data: { ...data, amountCents: compound.amountCents, offerMethod: null }, text: `Got it, ${R(compound.amountCents)}. How would you like it? ${shortMenu(options)}` };
    }
    const method = parseMethodChoice(t, options);
    if (!method) {
      return { state, data, text: `${shortMenu(options)} Or "cancel".` };
    }
    return nextAfterMethod({ account, data: { ...data, method } });
  }
  if (state === 'PAYOUT_AMOUNT') {
    // "YES" accepts the switch the last reply offered: the customer never has
    // to re-pick from the menu (founder review 2026-09-18).
    if ((data.offerMethod || data.offerAmountCents) && YES_RE.test(t)) {
      // The amount is re-validated against the balance as it stands now: a
      // purchase can land between the offer and the answer.
      const taken = { ...data, method: data.offerMethod || data.method, amountCents: data.offerAmountCents ?? data.amountCents, offerMethod: null, offerAmountCents: null };
      return nextAfterMethod({ account, data: taken });
    }
    // A bare menu number is a method switch, not an amount: the below-minimum
    // reply says "choose *3*" and the founder typed 3 (2026-09-17). No method
    // allows an amount under R6, so the reading is never ambiguous.
    const optionsHere = data.options || ALL_METHODS;
    if (/^\s*[1-5]\s*$/.test(t) && Number(t) <= optionsHere.length) {
      return nextAfterMethod({ account, data: { ...data, method: optionsHere[Number(t) - 1] } });
    }
    // "50 at ABSA" / "the Nedbank one" here: a new method with (or without) a new amount.
    const compound = parseCompoundWithdraw(t, { options: optionsHere });
    if (compound?.method && compound.amountCents != null) return compoundConfirm({ data, method: compound.method, amountCents: compound.amountCents, state: 'PAYOUT_AMOUNT' });
    if (compound?.method && compound.amountCents == null) return nextAfterMethod({ account, data: { ...data, method: compound.method, offerMethod: null, offerAmountCents: null } });
    const amountCents = compound?.amountCents ?? parseRandAmount(t);
    if (amountCents == null) return { state, data, text: `Just the amount, like "200" or "R150.50".` };
    const bad = validateAmount(data, amountCents);
    if (bad) return bad;
    return recipientAsk({ ...data, amountCents });
  }
  if (state === 'PAYOUT_MOBILE') {
    const chosen = pickSavedDestination(t, data.savedChoices);
    if (chosen) return afterRecipient({ ...data, recipient: { ...data.recipient, savedId: chosen.id, savedLabel: chosen.label } });
    const own = /^\W*(mine|me|this|this one|my number)\W*$/i.test(t);
    const raw = own ? String(account.msisdn || account.waId || '') : t;
    // Accounts hold 27-form numbers, people type 0-form: normalise first, then validate.
    const mobile = normaliseMsisdn(raw);
    if (!mobile || !(isValidSaMsisdn(mobile) || isValidSaMsisdn(raw))) return { state, data, text: `That does not look like a South African cellphone number. Type it like 073 123 4567, or reply *mine*.` };
    return afterRecipient({ ...data, recipient: { ...data.recipient, mobile } });
  }
  if (state === 'PAYOUT_ACCOUNT') {
    const chosen = pickSavedDestination(t, data.savedChoices);
    if (chosen) {
      const own = data.method === 'PAYSHAP' ? { mobile: normaliseMsisdn(String(account.msisdn || account.waId || '')) } : {};
      return afterRecipient({ ...data, recipient: { ...data.recipient, savedId: chosen.id, savedLabel: chosen.label, ...own } });
    }
    const digits = t.replace(/\D/g, '');
    if (digits.length < 6 || digits.length > 20) return { state, data, text: `Please type the account number only (6 to 20 digits)${data.savedChoices?.length ? ', or reply the number of a saved account' : ''}.` };
    return { state: 'PAYOUT_BRANCH', data: { ...data, recipient: { ...data.recipient, account_number: digits } }, text: `Which bank is that account with? Reply with the bank's name (FNB, Capitec, Standard Bank, Absa, Nedbank, TymeBank, Discovery, African Bank, Investec) or its universal branch code.` };
  }
  if (state === 'PAYOUT_BRANCH') {
    const b = bankToBranch(t);
    if (!b) return { state, data, text: `I did not recognise that bank. Reply with one of: FNB, Capitec, Standard Bank, Absa, Nedbank, TymeBank, Discovery, African Bank, Investec, or the 6-digit universal branch code.` };
    const own = data.method === 'PAYSHAP' ? { mobile: normaliseMsisdn(String(account.msisdn || account.waId || '')) } : {};
    return afterRecipient({ ...data, recipient: { ...data.recipient, ...b, ...own } });
  }
  if (state === 'PAYOUT_NAME') {
    const fullName = cleanFullName(t);
    if (!fullName) return { state, data, text: `Please type your first name and surname as they appear on your ${nameSource(data)}, like "Thandi Nkosi".` };
    return afterRecipient({ ...data, recipient: { ...data.recipient, fullName } });
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


/** Would this text be valid input for the current step? Then it is input, not a question. */
function stepInputParses(state, t, data, account) {
  const options = data.options || ALL_METHODS;
  const words = t.split(/\s+/).length;
  if (state === 'PAYOUT_METHOD') {
    const c = parseCompoundWithdraw(t, { options });
    if (c && c.method && c.amountCents != null) return true;                 // "No can you help me withdraw 50 at ABSA?"
    if (c && c.amountCents != null && (words <= 4 || /\bwithdraw|take out|cash out\b/i.test(t))) return true;
    return parseMethodChoice(t, options) !== null && (words <= 3 || /^\W*\d\W*$/.test(t));
  }
  if (state === 'PAYOUT_AMOUNT') {
    if (parseRandAmount(t) != null) return true;
    const c = parseCompoundWithdraw(t, { options });
    if (c && c.method && c.amountCents != null) return true;
    return !!(c && c.amountCents != null && (words <= 8 || /\bwithdraw|take out|cash out\b/i.test(t)));
  }
  if (state === 'PAYOUT_ACCOUNT') return /^\D{0,3}[\d\s-]{6,24}\D{0,3}$/.test(t) || !!pickSavedDestination(t, data.savedChoices);
  if (state === 'PAYOUT_BRANCH') return bankToBranch(t) !== null;
  if (state === 'PAYOUT_MOBILE') return /^\W*(mine|me|this|this one|my number)\W*$/i.test(t) || !!pickSavedDestination(t, data.savedChoices) || !!normaliseMsisdn(t) && isValidSaMsisdn(normaliseMsisdn(t));
  if (state === 'PAYOUT_NAME') return cleanFullName(t) !== null;
  if (state === 'PAYOUT_ID') return /^\D*\d[\d\s]{11,14}\D*$/.test(t);
  if (state === 'PAYOUT_CONFIRM') return /^\W*(yes|yebo|ewe|ja|y|confirm|ok|okay|no|nee|cha|hayi|n)\W*$/i.test(t);
  return false;
}
function answerAside(t, data) {
  if (SAVED_ASK.test(t) && data?.method) return savedAnswer(data).text;
  const fee = matchFeeAsk(t);
  if (fee) return feeAnswer(fee);
  const topic = matchHowItWorksAsk(t) || (/\b(withdraw|cash|atm|bank|payshap|fee|long|when|arrive)\b/i.test(t) ? 'withdraw' : null);
  if (topic) return howItWorksAnswer(topic, { withdrawLive: true, providers: [] });
  return `Good question. Let me finish this withdrawal first and I will answer anything after, or say "cancel" to stop and ask me now.`;
}
function reprompt(state, data) {
  if (state === 'PAYOUT_METHOD') return methodMenu(data.balanceCents, data.options || ALL_METHODS, data.limits || {});
  if (state === 'PAYOUT_AMOUNT') return amountAsk(data).text;
  if (state === 'PAYOUT_ACCOUNT') return data.savedChoices?.length ? `Reply the number of a saved account, or type a new account number.` : `What is the bank account number the money must go to?`;
  if (state === 'PAYOUT_BRANCH') return `Which bank is that account with? Reply with the bank's name or its universal branch code.`;
  if (state === 'PAYOUT_MOBILE') return `Which cellphone number will collect the cash? Reply *mine* or type the number.`;
  if (state === 'PAYOUT_NAME') return `What is your full name, exactly as on your ${nameSource(data)}?`;
  if (state === 'PAYOUT_ID') return `Please type your 13-digit South African ID number.`;
  if (state === 'PAYOUT_CONFIRM') return confirmAsk(data).text;
  return `Reply "withdraw" to start again.`;
}

/** True only when OTT itself acknowledged the request (a real payout status); false for a timeout or an unreadable answer. */
export function payoutHandedOver(outcome) {
  const o = String(outcome || '');
  return o !== '' && o !== 'TRANSPORT_INDETERMINATE' && o !== 'UNKNOWN' && !o.startsWith('HTTP_');
}

/** What a PENDING pay-out will do when it lands: the bank's own notice, or the SMS and the steps. */
function pendingArrival(method, mobile) {
  if (DESTINATION_FAMILY[method] === 'BANK') return `When the bank confirms it, the credit shows in your bank's own app or SMS as well.`;
  const to = mobile ? `•••${String(mobile).replace(/\D/g, '').slice(-3)}` : 'the number you gave';
  return `When it is paid, the code comes by SMS to ${to} and I will send you the collection steps here.`;
}

/** After a verified PIN: the one call that moves money. */
export async function executeWithdraw({ prisma: prismaClient = prisma, account, data, deps = {} }) {
  const rec = { ...(data.recipient || {}) };
  // A saved destination is decrypted here, at the moment of use, never earlier.
  if (rec.savedId) {
    const secret = await (deps.loadDestination || realLoadDestination)({ prisma: prismaClient, accountId: account.id, id: rec.savedId }).catch(() => null);
    if (!secret) return { state: null, done: false, text: `❌ I could not read the saved details for that destination, so nothing was sent and nothing has left your balance. Say "withdraw" to try again and type the details.` };
    if (DESTINATION_FAMILY[data.method] === 'BANK') Object.assign(rec, { account_number: secret.account_number, branch_code: secret.branch_code, branch_name: secret.branch_name });
    else rec.mobile = secret.mobile;
  }
  const kycName = account?.profile?.kyc?.fullName || null;
  let identity = null;
  if (!rec.id_number || !(kycName || rec.fullName)) {
    identity = await (deps.loadIdentity || (beneficiariesAvailable() ? realLoadIdentity : async () => null))({ prisma: prismaClient, accountId: account.id }).catch(() => null);
    if (identity?.idNumber && !rec.id_number) rec.id_number = identity.idNumber;
  }
  const { fullName, savedId, savedLabel, ...wire } = rec;
  const recipient = { ...recipientName(account, fullName || identity?.fullName || null), ...wire };
  const out = await (deps.requestPayout || realRequestPayout)({ prisma: prismaClient, account, intentId: data.intentId, method: data.method, amountCents: data.amountCents, recipient, client: deps.client, providers: deps.providers });

  const accepted = out.ok && (out.status === 'SETTLED' || out.status === 'PENDING');
  // A number typed again that is already saved (the founder typed "mine" beside
  // the saved list, 2026-10-08) counts as a use of the saved row, never a second offer.
  const number = DESTINATION_FAMILY[data.method] === 'BANK' ? wire.account_number : wire.mobile;
  const already = !savedId && number ? (data.saved || []).find((d) => d.fingerprint && d.fingerprint === fingerprintOf(account.id, data.method, number)) : null;
  const usedId = savedId || already?.id || null;
  if (accepted && usedId) await (deps.touchDestination || realTouchDestination)({ prisma: prismaClient, accountId: account.id, id: usedId }).catch(() => {});
  // The consent step: only after the rail accepted, only for details typed this
  // time and not yet saved, only when the vault can hold them. YES saves; anything else keeps nothing.
  const available = deps.beneficiariesAvailable ? deps.beneficiariesAvailable() : beneficiariesAvailable();
  const saveDestination = accepted && available && !usedId && !!number;
  const saveIdentity = accepted && available && !identity && !kycName && !!fullName && !!wire.id_number;
  let saveStep = null;
  if (saveDestination || saveIdentity) {
    const what = [saveDestination ? destinationLabel(data.method, wire) : null, saveIdentity ? `your name and ID number ending ${String(wire.id_number).slice(-3)}` : null].filter(Boolean).join(' and ');
    const savedRec = { fullName: fullName || null, id_number: wire.id_number || null, account_number: wire.account_number || null, branch_code: wire.branch_code || null, branch_name: wire.branch_name || null, mobile: wire.mobile || null };
    saveStep = {
      state: 'PAYOUT_SAVE',
      data: { method: data.method, recipient: savedRec, saveDestination, saveIdentity },
      text: `\n\n💾 Save these details for next time (${what})? Reply *YES*, or give them a name like "mine" or "mother". They are stored encrypted and used only for your withdrawals; say "forget my bank details" any time to erase them. Reply *NO* to skip.`,
    };
  }
  const withSave = (step) => (saveStep ? { ...step, state: saveStep.state, data: saveStep.data, text: step.text + saveStep.text } : step);

  if (out.ok && out.status === 'SETTLED') {
    return withSave({ state: null, done: true, text: `✅ *Done.* ${R(out.amountCents)} is on its way to you by ${PAYOUT_METHODS[data.method].label}. Reference ${out.reference}. Fee ${R(out.feeCents)}.\n\n${collectionInstructions(data.method, wire.mobile)}` });
  }
  if (out.ok && out.status === 'PENDING') {
    // Two different truths (BUGLOG #82). A real OTT "pending" (98/99) means the rail HAS the
    // request; a transport timeout or an unreadable answer means nobody has confirmed anything,
    // so "Sent" would be a claim. Neither promises a time: PayShap on the sandbox took over 20 s.
    if (!payoutHandedOver(out.outcome)) {
      return withSave({ state: null, done: true, text: `⏳ I could not get confirmation from the bank rail just now, so I am checking on it (reference ${out.reference}). Your ${R(out.amountCents)}${Number.isInteger(out.feeCents) ? ` plus the ${R(out.feeCents)} fee` : ''} is held, not spent, and I will message you here either way.` });
    }
    return withSave({ state: null, done: true, text: `⏳ *In progress.* ${R(out.amountCents)} has been handed to the bank rail (reference ${out.reference}). I'll message you here the moment the bank confirms it, and if it does not go through the amount and the fee come straight back to your balance. ${pendingArrival(data.method, wire.mobile)}` });
  }
  const why = out.error === 'INSUFFICIENT_FUNDS' ? `you no longer have ${R(out.totalCents || (data.totalCents || 0))} available` : out.error === 'KYC_REQUIRED' ? 'your identity check has not cleared yet' : out.error === 'NO_PROVIDER' ? 'that pay-out method is not available right now' : out.error === 'BAD_RECIPIENT' ? `the ${String(out.field || 'details').replace('_', ' ')} was not accepted` : out.error === 'DISABLED' || out.error === 'NOT_CONFIGURED' ? 'withdrawals are not switched on yet' : out.error === 'REQUEST_INVALID' ? 'the bank rail could not read our request (our side, not yours) and we are fixing it' : `the bank rail declined it (${out.error || 'unknown'})`;
  return { state: null, done: false, text: `❌ The withdrawal did not go through: ${why}. Nothing has left your balance. Say "withdraw" to try again.` };
}
