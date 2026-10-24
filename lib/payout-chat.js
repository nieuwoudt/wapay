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
import { rememberPendingWithdraw, takePendingWithdraw, clearPendingWithdraw } from './kyc-resume.js';
import { checkPayoutRules, dailyCapCopy, kycThresholdCopy, rulesNote } from './payout-rules.js';
import { readPayoutFreeze, FROZEN_PAYOUT_COPY } from './payout-freeze.js';
import { isPayoutHeld, PAYOUT_HOLD_COPY } from './payout-hold.js';
import { expressFor, recentReceipts as realRecentReceipts, expressFeeLine, sastClock } from './payout-express.js';
import { PAYOUT_REVIEW_COPY } from './payout-triage.js';
import {
  PAYOUT_METHODS, MIN_PAYOUT_CENTS, MAX_PAYOUT_CENTS, CASH_STEP_CENTS, isCashMethod, payoutEnabled, kycRequired, accountKycVerified,
  quotePayout, methodLimits, payoutConfigured, payoutBalances as realPayoutBalances, requestPayout as realRequestPayout, resolveProviders as realResolveProviders,
  passportIdType,
} from './payouts.js';
import { matchHowItWorksAsk, howItWorksAnswer, looksLikeQuestion, WITHDRAW_AMOUNT_ASK } from './how-it-works.js';
import { matchFeeAsk, feeAnswer } from './fee-facts.js';
import { normaliseMsisdn, isValidSaMsisdn } from './msisdn.js';
import { collectionInstructions } from './payout-collection.js';
import { moneySituation as realMoneySituation, gateHistory as realGateHistory } from './money-situation.js';
import { shortGateReply, stuckAlert, SHORT_GATE } from './payout-gate.js';
import { sendOpsAlert as realSendOpsAlert } from './email.js';
import { opsPersonAlert as realOpsPersonAlert } from './ops-alerts.js';
import { pinResetCoolOff as realCoolOff } from './pin-reset.js';
import { verifyPinProof } from '@wapay/auth/pin-proof';
import {
  beneficiariesAvailable, DESTINATION_FAMILY, destinationLabel, fingerprintOf, cleanNickname,
  listPayoutDestinations as realListDestinations, getPayoutIdentity as realGetIdentity,
  loadPayoutDestinationSecret as realLoadDestination, loadPayoutIdentitySecret as realLoadIdentity,
  savePayoutIdentity as realSaveIdentity, savePayoutDestination as realSaveDestination, touchPayoutDestination as realTouchDestination,
  setPayoutDestinationNickname as realSetNickname,
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
  if (!/\b(withdraw(?:al|als)?|cash ?-?out|pay ?-?out|payshap|cash ?send|cash at|atm|(?:to|into) my bank|my bank account|bank transfer|take (?:my |the )?(?:money |cash )?out|get (?:my )?(?:money|cash) out|money out|onttrek|khipha imali)\b/i.test(t)) return null;
  const m = t.match(/\bR?\s?(\d{1,5})(?:[.,](\d{1,2}))?\b/);
  let amountCents = null;
  if (m) { const whole = Number(m[1]); const frac = m[2] ? Number((m[2] + '0').slice(0, 2)) : 0; amountCents = whole * 100 + frac; }
  // One table for the method (methodFromWords, shared with the flow and the agent's
  // rescue): "to my bank account" / "my Nedbank account" is the bank family, never a
  // bank's cash product (founder 2026-10-12: "lets do a withdrawal to my bank account"
  // showed the whole menu). "Cash out" and "money out" are withdraw words, not cash.
  const method = methodFromWords(t.replace(/\bcash ?-?out\b|\bget (?:my )?(?:money|cash) out\b|\bmoney out\b|\bpay ?-?out\b/gi, ' '), ALL_METHODS);
  const all = amountCents == null && /\ball (?:of )?(?:my |the )?(?:money|balance|cash|of it|r ?\d+)|\beverything\b|\bthe lot\b/i.test(t);
  // "How much can I withdraw?": the customer's own ceiling, not the how-it-works brief (Lisa, 2026-10-10).
  const howMuch = amountCents == null && WITHDRAW_AMOUNT_ASK.test(t);
  return { amountCents, method, ...(all ? { all: true } : {}), ...(howMuch ? { howMuch: true } : {}) };
}
export { WITHDRAW_AMOUNT_ASK };

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
 * The ID document a customer types at the ID step (founder 2026-10-12, the
 * Lisa case: a foreign national with a Capitec account could not withdraw
 * because the step wanted a 13-digit SA ID). 13 digits is a South African ID;
 * 6 to 12 letters and digits with at least one digit is a passport or foreign
 * ID number (the issuing country is asked next). Pure.
 *   → { idType: 'RSAID', idNumber } | { idType: 'PASSPORT', idNumber } | null
 */
export function parseIdDocument(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 60) return null;
  const digitsOnly = raw.replace(/[\s-]/g, '');
  if (/^\d{13}$/.test(digitsOnly)) return { idType: 'RSAID', idNumber: digitsOnly };
  // "My passport is FN123456" / "passport no: FN 123456": the token with a digit in it.
  const cleaned = raw.toUpperCase().replace(/\b(?:MY|PASSPORT|FOREIGN|ID|NUMBER|NO|NR|IS|IT'?S|DOCUMENT|PERMIT)\b[.:#]?/g, ' ').replace(/[^A-Z0-9 -]/g, ' ').trim();
  const joined = cleaned.replace(/[\s-]+/g, '');
  if (/^(?=[A-Z0-9]*\d)[A-Z0-9]{6,12}$/.test(joined) && cleaned.split(/\s+/).filter(Boolean).length <= 3) return { idType: 'PASSPORT', idNumber: joined };
  return null;
}

/**
 * Countries that issue the passports and IDs WaPay's customers hold, ISO
 * alpha-2 (OTT fills country_of_issue "ZA" and nationality "ZA" itself when
 * nothing is sent, so alpha-2 is the shape its rail reads). Names, demonyms
 * and the two-letter code all match.
 */
export const ISSUING_COUNTRIES = Object.freeze({
  ZW: ['Zimbabwe', 'zimbabwean', 'zim'], MW: ['Malawi', 'malawian'], MZ: ['Mozambique', 'mozambican', 'mocambique', 'moçambique'],
  LS: ['Lesotho', 'mosotho', 'basotho'], SZ: ['Eswatini', 'swaziland', 'swazi', 'liswati'], BW: ['Botswana', 'motswana', 'batswana'],
  NA: ['Namibia', 'namibian'], ZM: ['Zambia', 'zambian'], AO: ['Angola', 'angolan'], CD: ['DR Congo', 'democratic republic of congo', 'democratic republic of the congo', 'drc', 'congolese', 'congo kinshasa', 'congo'],
  CG: ['Republic of the Congo', 'congo brazzaville', 'republic of congo'], TZ: ['Tanzania', 'tanzanian'], KE: ['Kenya', 'kenyan'], UG: ['Uganda', 'ugandan'],
  RW: ['Rwanda', 'rwandan'], BI: ['Burundi', 'burundian'], ET: ['Ethiopia', 'ethiopian'], SO: ['Somalia', 'somali', 'somalian'], ER: ['Eritrea', 'eritrean'],
  NG: ['Nigeria', 'nigerian'], GH: ['Ghana', 'ghanaian'], CM: ['Cameroon', 'cameroonian'], SN: ['Senegal', 'senegalese'], CI: ["Côte d'Ivoire", 'ivory coast', 'ivorian', 'cote d ivoire'],
  MG: ['Madagascar', 'malagasy'], MU: ['Mauritius', 'mauritian'], SS: ['South Sudan', 'south sudanese'], SD: ['Sudan', 'sudanese'], EG: ['Egypt', 'egyptian'],
  MA: ['Morocco', 'moroccan'], PK: ['Pakistan', 'pakistani'], BD: ['Bangladesh', 'bangladeshi'], IN: ['India', 'indian'], CN: ['China', 'chinese'], LK: ['Sri Lanka', 'sri lankan'],
  GB: ['United Kingdom', 'uk', 'britain', 'great britain', 'british', 'england', 'english', 'scotland', 'scottish', 'wales', 'welsh'], IE: ['Ireland', 'irish'],
  DE: ['Germany', 'german'], NL: ['Netherlands', 'holland', 'dutch'], PT: ['Portugal', 'portuguese'], FR: ['France', 'french'], IT: ['Italy', 'italian'], BE: ['Belgium', 'belgian'],
  US: ['United States', 'usa', 'united states of america', 'america', 'american'], CA: ['Canada', 'canadian'], AU: ['Australia', 'australian'], NZ: ['New Zealand', 'new zealander'],
  BR: ['Brazil', 'brazilian'], ZA: ['South Africa', 'south african', 'rsa', 'sa'],
});
/** The country's name for the customer ("ZW" → "Zimbabwe"). */
export const countryName = (code) => ISSUING_COUNTRIES[String(code || '').toUpperCase()]?.[0] || String(code || '');
/** "Zimbabwe", "I'm Malawian", "ZW", "from the DRC" → the ISO alpha-2 code, or null. Pure. */
export function parseCountry(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 60) return null;
  const code = t.replace(/[^A-Za-z]/g, '');
  if (code.length === 2 && /^[A-Za-z]{2}\W*$/.test(t) && ISSUING_COUNTRIES[code.toUpperCase()]) return code.toUpperCase();
  const s = ' ' + t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  let best = null;
  for (const [cc, names] of Object.entries(ISSUING_COUNTRIES)) {
    for (const n of names) {
      const k = ' ' + n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z' ]+/g, ' ').trim() + ' ';
      // Two-letter aliases ("uk", "sa") only as the whole answer: "sa" inside a sentence is too easy to hit.
      if (k.trim().length <= 2 && s.trim() !== k.trim()) continue;
      if (s.includes(k) && (!best || k.length > best.len)) best = { cc, len: k.length };
    }
  }
  return best ? best.cc : null;
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
  // Methods that need the same amount are named together: "cash at an Absa ATM, cash at a Nedbank ATM or an FNB eWallet (R68 with the fee)".
  const groups = [...new Set(short.map(needOf))].sort((a, b) => a - b).map((need) => {
    const names = short.filter((m) => needOf(m) === need).map((m) => METHOD_SHORT[m] || PAYOUT_METHODS[m]?.label);
    return `${names.length > 1 ? names.slice(0, -1).join(', ') + ' or ' + names.at(-1) : names[0]} (${R(need)} with the fee)`;
  });
  const hint = short.length
    ? `\n\n💡 With ${R(balanceCents)} you cannot use ${groups.join(', nor ')} yet. Say *add money* to top up, or ` +
      (covered.length ? `reply ${covered.map((m) => `*${options.indexOf(m) + 1}*`).join(' or ')} for ${covered.map((m) => METHOD_SHORT[m] || PAYOUT_METHODS[m]?.label).join(' or ')}.` : 'come back once your balance covers it.')
    : '';
  return `💸 *Withdraw from WaPay*\n\nYou have ${R(balanceCents)} available. How would you like it?\n\n` +
    options.map((m, i) => `${NUM[i]} ${methodLine(m, limits, balanceCents)}`).join('\n') +
    `\n\nReply ${options.map((_, i) => i + 1).join(', ').replace(/, (\d)$/, ' or $1')}. Reply "cancel" to stop.` + hint;
};
const shortMenu = (options = ALL_METHODS) => `Reply ${options.map((m, i) => `*${i + 1}* for ${METHOD_NAMES[m]}`).join(', ')}.`;

const KYC_ASK = `🪪 Withdrawals need a once-off identity check on your phone. Reply *VERIFY* and I'll send you the secure link, or "cancel".`;
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
  return { identity: identity ? { fullName: identity.fullName, idLast3: identity.idLast3, idType: identity.idType || 'RSAID', countryOfIssue: identity.countryOfIssue || null } : null, destinations: (destinations || []).map((d) => ({ id: d.id, method: d.method, family: d.family || DESTINATION_FAMILY[d.method] || null, label: d.label, nickname: d.nickname || null, fingerprint: d.fingerprint || null })) };
}

/**
 * Start (or gate) a withdrawal for an onboarded customer. Returns null when
 * withdrawals are switched off (the caller keeps the coming-soon answer).
 */
export async function startWithdraw({ prisma: prismaClient = prisma, account, ask = {}, deps = {} }) {
  if (!payoutEnabled()) return null;
  if (await readPayoutFreeze({ prisma: prismaClient, accountId: account?.id, fallbackProfile: account?.profile || null })) return { state: null, text: FROZEN_PAYOUT_COPY };
  // The global hold (founder 2026-10-24): the flow does not start while pay-outs are paused.
  if (await isPayoutHeld({ prisma: prismaClient })) return { state: null, text: PAYOUT_HOLD_COPY };
  const kyc = account?.profile?.kyc || {};
  if (kycRequired() && !accountKycVerified(account)) {
    return { state: 'PAYOUT_KYC', data: {}, text: kyc.status === 'PENDING' || kyc.status === 'PENDING_REVIEW' ? KYC_PENDING : KYC_ASK };
  }
  // After the identity check: a bare "withdraw" picks up the ask the check interrupted (lib/kyc-resume.js).
  if (!ask.amountCents && !ask.method && !ask.all && !ask.howMuch && accountKycVerified(account)) {
    const pending = takePendingWithdraw(account?.profile);
    if (pending) { ask = { ...ask, ...pending }; clearPendingWithdraw({ prisma: prismaClient, accountId: account.id }).catch(() => {}); }
  }
  const balances = await (deps.payoutBalances || realPayoutBalances)({ prisma: prismaClient, accountId: account.id });
  // Money that arrived in the last two hours, read once: it prices the express fee on every quote below (2026-10-24).
  const receipts = await (deps.recentReceipts || realRecentReceipts)({ prisma: prismaClient, accountId: account.id }).catch(() => []);
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
    // Founder 2026-10-12 (the Lisa case): her money first and where it is, then the
    // minimum; never the same line again: the fuller picture, then a person.
    const cheapest = options.find((m) => needAt(m, limits[m]) === needAll);
    const [situation, history] = await Promise.all([
      (deps.moneySituation || realMoneySituation)({ prisma: prismaClient, account }).catch(() => null),
      (deps.gateHistory || realGateHistory)({ prisma: prismaClient, accountId: account.id, gate: SHORT_GATE }).catch(() => ({ count: 0, personAsked: false })),
    ]);
    const repeats = history?.count || 0;
    let personAsked = !!history?.personAsked;
    if (repeats >= 2 && !personAsked) {
      // The third time (or later, if no alert has gone yet): a person. The reply only says so when the alert actually went.
      const alert = stuckAlert({ account, balanceCents: balances.totalCents, needCents: needAll, situation });
      // The e-mail and its WhatsApp twin to the ops numbers (founder 2026-10-19); either arriving means a person was asked.
      const [sent, wa] = await Promise.all([
        (deps.sendOpsAlert || realSendOpsAlert)(alert).catch(() => ({ success: false })),
        (deps.opsPersonAlert || realOpsPersonAlert)({ text: alert.text, key: `${account.id}:${new Date().toISOString().slice(0, 10)}`, prisma: prismaClient }).catch(() => ({ sent: 0 })),
      ]);
      personAsked = !!sent?.success || (wa?.sent || 0) > 0;
    }
    const reply = shortGateReply({ account, balanceCents: balances.totalCents, needCents: needAll, minCents: limits[cheapest]?.minCents ?? minAll, cheapestLabel: { PAYSHAP: 'PayShap', RTC: 'bank transfer', CASHSEND: 'Absa cash', NEDCASH: 'Nedbank cash', EWALLET: 'eWallet' }[cheapest] || 'PayShap', situation, repeats, personAsked });
    return { state: null, text: reply.text, refs: reply.refs };
  }
  if (ask.howMuch && !ask.method) return { state: null, text: howMuchAnswer({ balanceCents: balances.totalCents, options, limits, receipts }) };
  const saved = await savedDetailsFor({ prisma: prismaClient, account, deps });
  // After a PIN reset without an ID check, only destinations saved before it (2026-10-14).
  const coolOff = (deps.pinResetCoolOff || realCoolOff)({ account });
  if (coolOff?.until && !(saved.destinations || []).length) return { state: null, text: coolOffText(coolOff.until, { none: true }) };
  const method = offeredMethodFor(ask.method, options);
  const data = { amountCents: ask.amountCents || null, method, intentId: newIntentId(), recipient: {}, balanceCents: balances.totalCents, receipts, options, limits, fields, kycName: account?.profile?.kyc?.fullName || null, identity: saved.identity, saved: saved.destinations, ...(coolOff?.until ? { coolOffUntil: new Date(coolOff.until).toISOString() } : {}) };
  // The pay-out rules that can bite THIS account, said once up front (founder 2026-10-20: explain the cap).
  data.rulesNote = rulesNote({ createdAt: account?.createdAt, verified: accountKycVerified(account), balanceCents: balances.totalCents }) || null;
  // "All my money": the most this method can take with its fee.
  if (data.method && !data.amountCents && ask.all) data.amountCents = affordableMaxCents({ method: data.method, balanceCents: data.balanceCents, limits, receipts: data.receipts }) || null;
  // "To my bank account" with no amount: straight into the bank method with the price and the numbers (founder 2026-10-12).
  if (data.method && !data.amountCents && METHOD_FAMILY[data.method] === 'BANK' && affordableMaxCents({ method: data.method, balanceCents: data.balanceCents, limits, receipts: data.receipts }) != null) return bankOpener(data);
  if (data.method) return nextAfterMethod({ account, data });
  return { state: 'PAYOUT_METHOD', data, text: methodMenu(balances.totalCents, options, limits) };
}

/**
 * The method the customer (or the agent) asked for, mapped onto what is
 * offered: a bank-family method that is not on the merchant becomes the bank
 * method that is (RTC asked, PayShap offered); a named bank's cash product that
 * is not offered is left to the menu. Never silently dropped to the menu when
 * the family is served (founder 2026-10-12). Pure.
 */
export function offeredMethodFor(asked, options = ALL_METHODS) {
  if (!asked) return null;
  if (options.includes(asked)) return asked;
  if (METHOD_FAMILY[asked] === 'BANK' || asked === 'BANK') return BANK_METHODS.find((m) => options.includes(m)) || null;
  return null;
}

/**
 * "How much can I withdraw?": the most each way can take with its fee, from
 * this balance. "💸 You have R350. The most you can withdraw right now: R342
 * by PayShap to your bank account (R8 fee), or R300 as cash at an Absa or
 * Nedbank ATM (R18 fee). Say *withdraw* and the amount, like "withdraw 342"."
 */
function howMuchAnswer({ balanceCents, options, limits, receipts = null }) {
  const bank = BANK_METHODS.find((m) => options.includes(m));
  const lim = (m) => limits?.[m] || { minCents: MIN_PAYOUT_CENTS, maxCents: MAX_PAYOUT_CENTS };
  const bankMax = bank ? affordableMaxCents({ method: bank, balanceCents, limits, receipts }) : null;
  const cashBest = CASH_METHODS.filter((m) => options.includes(m))
    .map((m) => ({ m, max: affordableMaxCents({ method: m, balanceCents, limits, receipts }) }))
    .filter((x) => x.max != null)
    .sort((a, b) => b.max - a.max)[0] || null;
  const parts = [];
  const feeAt = (m, cents) => quoteOn({ balanceCents, receipts }, m, cents, lim(m)).feeCents;
  if (bankMax != null) parts.push(`${R(bankMax)} by ${bank === 'PAYSHAP' ? 'PayShap' : 'bank transfer'} to your bank account (${R(feeAt(bank, bankMax))} fee)`);
  if (cashBest) parts.push(`${R(cashBest.max)} as cash at ${cashPlaces(options)} (${R(feeAt(cashBest.m, cashBest.max))} fee, paid in R50 and R100 notes)`);
  const example = bankMax != null ? bankMax : cashBest?.max;
  return `💸 You have ${R(balanceCents)}. The most you can withdraw right now: ${parts.join(', or ')}. Say *withdraw* and the amount, like "withdraw ${R(example).slice(1)}".`;
}

/** "15 Oct at 19:15", in SAST. */
const sastWhen = (d) => { const x = new Date(new Date(d).getTime() + 2 * 3600 * 1000); return `${x.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][x.getUTCMonth()]} at ${String(x.getUTCHours()).padStart(2, '0')}:${String(x.getUTCMinutes()).padStart(2, '0')}`; };
/** The cool-off after a PIN reset without an ID check: said with the time it ends and what still works. */
function coolOffText(until, { none = false } = {}) {
  return none
    ? `🔒 Your PIN was reset recently, so for your safety withdrawals open again on ${sastWhen(until)} (only to accounts or numbers saved before the reset until then, and you have none saved). Airtime, data, electricity and everything else work now.`
    : `🔒 Your PIN was reset recently, so for your safety, until ${sastWhen(until)} a withdrawal can only go to an account or number saved before the reset. Pick one from the list, or withdraw to a new one after that time.`;
}
const coolingNow = (data) => !!data?.coolOffUntil && new Date(data.coolOffUntil).getTime() > Date.now();

/** Cash methods on offer as bank names: "an Absa or Nedbank ATM". */
function cashPlaces(options) {
  const names = CASH_METHODS.filter((m) => options.includes(m)).map((m) => ({ CASHSEND: 'Absa', NEDCASH: 'Nedbank', EWALLET: 'FNB' }[m]));
  if (!names.length) return null;
  return `an ${names.length > 1 ? names.slice(0, -1).join(', ') + ' or ' + names.at(-1) : names[0]} ATM`;
}

/**
 * "PayShap to your bank account: R8 fee, the cheapest way into your bank. You
 * have R86.50, so up to R78. No bank account? Cash at an Absa or Nedbank ATM
 * costs from R18. How much?" The situation and the price first, the amount
 * question merged in (founder 2026-10-12, his "lets do a withdrawal to my bank
 * account" got the whole menu).
 */
function bankOpener(data) {
  const options = data.options || ALL_METHODS;
  const lim = limitsFor(data);
  const cap = affordableMaxCents({ method: data.method, balanceCents: data.balanceCents, limits: data.limits, receipts: data.receipts });
  const fee = R(needAt(data.method, lim) - lim.minCents);
  const name = data.method === 'PAYSHAP' ? 'PayShap' : 'A bank transfer';
  const cheapest = data.method === 'PAYSHAP' || !options.includes('PAYSHAP') ? ', the cheapest way into your bank' : '';
  const upTo = cap >= lim.maxCents ? `one withdrawal can be up to ${R(lim.maxCents)}` : `so up to ${R(cap)}`;
  const cashMethods = CASH_METHODS.filter((m) => options.includes(m));
  const cashFrom = cashMethods.length ? Math.min(...cashMethods.map((m) => { const l = data.limits?.[m] || { minCents: MIN_PAYOUT_CENTS, maxCents: MAX_PAYOUT_CENTS }; return needAt(m, l) - l.minCents; })) : null;
  const cash = cashFrom != null ? ` No bank account? Cash at ${cashPlaces(options)} costs from ${R(cashFrom)}.` : '';
  return { state: 'PAYOUT_AMOUNT', data, text: `🏦 ${name} to your bank account: ${fee} fee${cheapest}. You have ${R(data.balanceCents)}, ${upTo}.${cash} How much?${data.rulesNote ? ' ' + data.rulesNote : ''}` };
}

async function liveProviders(deps) {
  if (deps.resolveProviders) return deps.resolveProviders();
  if (!payoutConfigured()) return null;
  return realResolveProviders({}).catch(() => null);
}
const limitsFor = (data) => data?.limits?.[data.method] || { minCents: MIN_PAYOUT_CENTS, maxCents: MAX_PAYOUT_CENTS };
const totalAt = (method, amountCents, lim) => quotePayout({ method, amountCents, minCents: lim.minCents, maxCents: lim.maxCents }).totalCents;
/**
 * The quote on this withdrawal's data, with the express fee (2026-10-24): money that reached the balance
 * less than two hours ago (data.receipts, read once at the start) doubles the fee for the part of a
 * pay-out that needs it. `ex` carries the decision for the customer's explanation line.
 */
function quoteOn(data, method, amountCents, lim) {
  const base = quotePayout({ method, amountCents, minCents: lim.minCents, maxCents: lim.maxCents });
  if (!data?.receipts?.length) return { ...base, ex: null };
  const ex = expressFor({ balanceCents: data.balanceCents, receipts: data.receipts, amountCents, normalFeeCents: base.feeCents });
  if (!ex.express) return { ...base, ex };
  return { ...quotePayout({ method, amountCents, minCents: lim.minCents, maxCents: lim.maxCents, feeMultiplier: ex.multiplier }), ex };
}
/** The minimum for a method plus the fee at that minimum: what the balance must cover to use it at all. */
const needAt = (method, lim) => totalAt(method, lim.minCents, lim);
const totalAtNormal = (method, amountCents, lim) => totalAt(method, amountCents, lim);

/**
 * The largest whole-rand amount inside the method's limits whose amount plus
 * fee fits the balance; null when even the minimum plus its fee does not.
 * Founder test 2026-09-17: R66 against CashSend (R50 minimum, R18 fee) was
 * bounced between "you can withdraw up to R48" and "R48 is below the R50
 * minimum". Fees are banded and never fall as the amount rises, so the
 * total is monotonic and a binary search on whole rands is exact.
 */
export function affordableMaxCents({ method, balanceCents, limits, receipts = null }) {
  const lim = limits?.[method] || { minCents: MIN_PAYOUT_CENTS, maxCents: MAX_PAYOUT_CENTS };
  const balance = Number.isFinite(Number(balanceCents)) ? Number(balanceCents) : 0;
  // With fresh money the fee can double part-way up (2026-10-24); the total still never falls as the amount rises.
  const totalAt = (m, cents, l) => (receipts?.length ? quoteOn({ balanceCents: balance, receipts }, m, cents, l).totalCents : totalAtNormal(m, cents, l));
  if (!PAYOUT_METHODS[method] || totalAt(method, lim.minCents, lim) > balance) return null;
  let lo = Math.floor(lim.minCents / 100);
  let hi = Math.floor(Math.min(lim.maxCents, balance) / 100);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (totalAt(method, mid * 100, lim) <= balance) lo = mid; else hi = mid - 1;
  }
  const cents = lo * 100;
  if (!isCashMethod(method)) return cents;
  // Cash is paid out in R50 and R100 notes: the ceiling is the largest multiple of the step that still fits.
  const stepped = Math.floor(cents / CASH_STEP_CENTS) * CASH_STEP_CENTS;
  return stepped >= lim.minCents ? stepped : null;
}
/** Cash at an ATM must be a multiple of CASH_STEP_CENTS (R50). Bank methods take any amount. */
const cashAmountOk = (method, amountCents) => !isCashMethod(method) || amountCents % CASH_STEP_CENTS === 0;
const stepR = () => R(CASH_STEP_CENTS);

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
      if (!cashAmountOk(m, amountCents)) return null;
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
  const atMin = quoteOn(data, data.method, lim.minCents, lim);
  const need = atMin.totalCents;
  const fact = 'With ' + R(data.balanceCents) + ' you cannot use ' +
    (METHOD_SHORT[data.method] || PAYOUT_METHODS[data.method]?.label) + ' yet: the ' +
    R(lim.minCents) + ' minimum plus the ' + R(need - lim.minCents) + ' fee is ' + R(need) + '.' +
    (atMin.ex?.express ? ' ' + expressFeeLine(atMin.ex) : '');
  // The code already knows which methods the balance covers and the most each
  // can pay, so it names ONE and offers it (founder review 2026-09-18).
  const family = METHOD_FAMILY[data.method] || null;
  const ranked = options
    .filter((m) => m !== data.method)
    .map((m) => ({ method: m, max: affordableMaxCents({ method: m, balanceCents: data.balanceCents, limits: data.limits, receipts: data.receipts }) }))
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
  const cap = affordableMaxCents({ method: data.method, balanceCents: data.balanceCents, limits: data.limits, receipts: data.receipts });
  const top = cap == null ? lim.maxCents : Math.min(lim.maxCents, cap);
  const step = isCashMethod(data.method) ? ', in multiples of ' + stepR() + ' (ATMs pay out R50 and R100 notes)' : '';
  return { state: 'PAYOUT_AMOUNT', data, text: 'How much would you like to withdraw by ' + def.label + '? Between ' + R(lim.minCents) + ' and ' + R(top) + step + '. You have ' + R(data.balanceCents) + ' available; the fee comes off your balance on top of the amount.' + (data.rulesNote ? ' ' + data.rulesNote : '') };
}
/** A method label that opens a sentence: 'cash at a Nedbank ATM' -> 'Cash at a...'. */
const sentence = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s);
const METHOD_SHORT = { PAYSHAP: 'PayShap', RTC: 'a bank transfer', CASHSEND: 'cash at an Absa ATM', NEDCASH: 'cash at a Nedbank ATM', EWALLET: 'an FNB eWallet' };
/** The reply when a pay-out rule stops the amount: the cap keeps the amount step, the KYC threshold opens the VERIFY step when the check is switched on. */
function rulesStop({ rules, data, amountCents = null }) {
  const clean = { ...data, offerMethod: null, offerAmountCents: null, ...(amountCents ? { amountCents } : {}) };
  if (rules.error === 'DAILY_CAP') return { state: 'PAYOUT_AMOUNT', data: clean, text: dailyCapCopy(rules) };
  return { state: rules.kycConfigured ? 'PAYOUT_KYC' : 'PAYOUT_AMOUNT', data: clean, text: kycThresholdCopy(rules) };
}
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
  if (!cashAmountOk(data.method, amountCents)) {
    // ATMs cannot dispense R70: offer the nearest multiple below (and name the one above).
    const below = Math.floor(amountCents / CASH_STEP_CENTS) * CASH_STEP_CENTS;
    const above = below + CASH_STEP_CENTS;
    const cap = affordableMaxCents({ method: data.method, balanceCents: data.balanceCents, limits: data.limits, receipts: data.receipts });
    const offer = below >= lim.minCents && cap != null && below <= cap ? below : above <= lim.maxCents && cap != null && above <= cap ? above : null;
    const name = METHOD_SHORT[data.method] || PAYOUT_METHODS[data.method]?.label;
    const lead = R(amountCents) + ' cannot be paid out as cash: ATMs give R50 and R100 notes, so ' + name + ' takes multiples of ' + stepR() + ' (' + [1, 2, 3].map((n) => R(CASH_STEP_CENTS * n)).join(', ') + ' and so on).';
    if (offer) return { state: 'PAYOUT_AMOUNT', data: { ...data, offerMethod: null, offerAmountCents: offer }, text: lead + ' Reply *YES* for ' + R(offer) + ', or type another amount.' };
    return { state: 'PAYOUT_AMOUNT', data, text: lead + ' Please type an amount like ' + R(Math.max(lim.minCents, CASH_STEP_CENTS)) + ', or "cancel".' };
  }
  const q = quoteOn(data, data.method, amountCents, lim);
  if (q.totalCents > data.balanceCents) {
    // A cheaper method may still carry the full amount: offer that before
    // asking the customer to settle for less (founder review 2026-09-18).
    const leadFee = 'With the ' + R(q.feeCents) + ' fee that is more than you have by ' +
      (METHOD_SHORT[data.method] || PAYOUT_METHODS[data.method]?.label) + ', but';
    const offerFee = offerSwitch({ data, amountCents, lead: leadFee });
    if (offerFee) return offerFee;
    const cap = affordableMaxCents({ method: data.method, balanceCents: data.balanceCents, limits: data.limits, receipts: data.receipts });
    if (cap == null) return methodUnaffordable(data);
    // The fee is banded, so it is quoted AT the ceiling, never at the amount
    // the customer typed, and the ceiling is offered rather than stated.
    const capQ = quoteOn(data, data.method, cap, lim);
    const why = q.ex?.express ? ' ' + expressFeeLine(q.ex) : '';
    return {
      state: 'PAYOUT_AMOUNT',
      data: { ...data, offerMethod: null, offerAmountCents: cap },
      text: 'With the ' + R(capQ.feeCents) + ' fee, ' + R(cap) + ' is the most you can take by ' +
        (METHOD_SHORT[data.method] || PAYOUT_METHODS[data.method]?.label) + ' right now (' + R(cap) +
        ' to you, ' + R(capQ.totalCents) + ' off your balance).' + why + ' Withdraw ' + R(cap) + '? Reply *YES*, or type a smaller amount.',
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
  if (affordableMaxCents({ method, balanceCents: data.balanceCents, limits: data.limits, receipts: data.receipts }) == null) return methodUnaffordable(withMethod);
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
  // "Yes" / "that one" / "the saved one" to a list of one is that one (founder 2026-10-09); "the first one" is the first.
  if (/^\W*(?:the )?first(?: one)?\W*$/.test(s)) return choices[0];
  if (choices.length === 1 && /^\W*(?:yes|yebo|ewe|ja|y|yeah|yep|ok|okay|sure|that(?: one)?|the saved one|same|the same one|use it|use that|that number|this one)\W*$/.test(s)) return choices[0];
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
  if (affordableMaxCents({ method: data.method, balanceCents: data.balanceCents, limits: data.limits, receipts: data.receipts }) == null) return methodUnaffordable(data);
  if (!data.amountCents) return amountAsk(data);
  const bad = validateAmount(data, data.amountCents);
  if (bad) return bad;
  return recipientAsk(data);
}
const nameSource = (data) => (DESTINATION_FAMILY[data.method] === 'BANK' ? 'bank account' : 'ID');
// Founder 2026-10-12 (the Lisa case): a passport or foreign ID works too; the issuing country is asked next.
const ID_ASK = `The bank needs your ID number for this payout, and it must match the account holder. Type your 13-digit South African ID number, or your passport or foreign ID number. Or "cancel".`;
const COUNTRY_ASK = `Which country issued that passport or ID? Reply with the country, like Zimbabwe, Malawi or Mozambique. If it is a South African ID number, type all 13 digits instead.`;
/** "ID number: •••083" or "Passport / foreign ID: •••456 (Zimbabwe)": the confirmation's ID line, masked. */
function idLineOf({ idType, last3, countryOfIssue, saved = false }) {
  if (!last3) return null;
  if (idType === 'PASSPORT') return `Passport / foreign ID: •••${last3}${countryOfIssue ? ` (${countryName(countryOfIssue)}${saved ? ', saved' : ''})` : saved ? ' (saved)' : ''}`;
  return `ID number: •••${last3}${saved ? ' (saved)' : ''}`;
}
/** What the save offer and the saved reply call the document. */
const idNounOf = (idType) => (idType === 'PASSPORT' ? 'passport or ID number' : 'ID number');
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
    return { state: 'PAYOUT_ID', data, text: ID_ASK };
  }
  return confirmAsk(data);
}

/** The fee rose between the confirmation and the pay-out: say so, nothing moved, start again. */
export function feeChangedCopy(out) {
  const when = out?.normalFromAt ? ` From ${sastClock(out.normalFromAt)} the fee is ${R(out.normalFeeCents)} again.` : '';
  return `💸 The fee for this pay-out is now ${R(out?.feeCents)}, not the ${R(out?.expectedFeeCents)} you confirmed, because money reached your balance less than 2 hours ago.${when} Nothing was sent and nothing has left your balance. Say *withdraw* to start again.`;
}

export function confirmAsk(data) {
  const lim = limitsFor(data);
  const q = quoteOn(data, data.method, data.amountCents, lim);
  const r = data.recipient;
  const saved = r.savedLabel ? r.savedLabel : null;
  const where = saved
    ? (DESTINATION_FAMILY[data.method] === 'BANK' ? `${saved}${data.method === 'PAYSHAP' ? ' by PayShap' : ''}` : saved)
    : data.method === 'RTC' ? `account ${r.account_number} at ${r.branch_name || r.branch_code}` : data.method === 'PAYSHAP' ? `account ${r.account_number} at ${r.branch_name || r.branch_code} by PayShap` : data.method === 'NEDCASH' ? `a Nedbank ATM (withdrawal code to ${r.mobile})` : data.method === 'EWALLET' ? `an FNB eWallet on ${r.mobile} (cash at any FNB ATM)` : `an Absa ATM or a Pick n Pay / Boxer till (collection code to ${r.mobile})`;
  const name = data.kycName || r.fullName || data.identity?.fullName || null;
  const idLine = r.id_number
    ? idLineOf({ idType: r.id_type, last3: String(r.id_number).slice(-3), countryOfIssue: r.country_of_issue })
    : data.identity?.idLast3 ? idLineOf({ idType: data.identity.idType, last3: data.identity.idLast3, countryOfIssue: data.identity.countryOfIssue, saved: true }) : null;
  const lines = [
    'Please confirm:',
    '',
    `💸 Withdraw *${R(data.amountCents)}* to ${where}`,
    name ? `Name on the account: ${name}` : null,
    idLine,
    q.ex?.express ? `Fee: ${R(q.feeCents)} (double the usual ${R(q.ex.normalFeeCents)})` : `Fee: ${R(q.feeCents)}`,
    q.ex?.express ? expressFeeLine(q.ex) : null,
    `Total leaving your balance: *${R(q.totalCents)}* (${R(data.amountCents)} + ${R(q.feeCents)} fee)`,
    `Balance after: *${R(Math.max(0, (data.balanceCents || 0) - q.totalCents))}*`,
    '',
    'Reply *YES* to continue to your PIN, or *NO* to cancel.',
  ].filter((l) => l !== null);
  return { state: 'PAYOUT_CONFIRM', data: { ...data, feeCents: q.feeCents, totalCents: q.totalCents, express: !!q.ex?.express }, text: lines.join('\n') };
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

const SKIP_NAME = /^\W*(?:skip|leave it|no name|none|nothing|not now|no thanks|no thank you|thanks|thank you|cool|great|fine|done|that'?s fine|it'?s fine)\W*$/i;
const NO_BANK_RE = /\b(?:no|don'?t have(?: a| any)?|do not have(?: a| any)?|haven'?t got(?: a| any)?|without(?: a| any)?|not got(?: a| any)?)\s+bank(?:\s+account)?\b/i;
const ALL_RE = /^\W*(?:all(?: of it| of my money| my money| of my balance| my balance| the money)?|everything|the lot|max(?:imum)?|as much as (?:i can|possible)|the most)\W*(?:please)?\W*$/i;
/** No bank account: the cash methods on offer, one of them straight away when only one is served. */
function noBankAnswer({ account, data }) {
  const options = data.options || ALL_METHODS;
  const cash = CASH_METHODS.filter((m) => options.includes(m));
  if (!cash.length) return { state: 'PAYOUT_METHOD', data: { ...data, method: null }, text: `Withdrawals without a bank account are cash at an ATM, and that is not available right now. ${shortMenu(options)} Or "cancel".` };
  if (cash.length === 1) return nextAfterMethod({ account, data: { ...data, method: cash[0], offerMethod: null, offerAmountCents: null } });
  const fromFee = Math.min(...cash.map((m) => { const l = data.limits?.[m] || { minCents: MIN_PAYOUT_CENTS, maxCents: MAX_PAYOUT_CENTS }; return needAt(m, l) - l.minCents; }));
  const lines = cash.map((m) => `*${options.indexOf(m) + 1}* for ${METHOD_SHORT[m]}`).join(', or ');
  return { state: 'PAYOUT_METHOD', data: { ...data, method: null, offerMethod: null }, text: `No problem: cash needs no bank account, only a cellphone for the SMS code (from ${R(fromFee)} fee, in multiples of ${stepR()}). Reply ${lines}.` };
}

const YES_RE = /^\W*(?:yes|yebo|ewe|ja|ee|eya|y|yeah|yep|ok|okay|sure|please|do it|switch|proceed|continue|confirm|save)\W*$/i;
const NO_RE = /^\W*(?:no|nope|nah|n|nee|cha|hayi|no thanks|no thank you|rather not|not now|don'?t|do not)\W*$/i;

/**
 * One customer reply inside the flow (everything except the PIN, which the
 * processor verifies before calling executeWithdraw).
 */
export async function handleWithdrawReply({ prisma: prismaClient = prisma, account, state, data = {}, text, deps = {} }) {
  const t = String(text || '').trim();
  // The global hold (founder 2026-10-24) ends a withdrawal in progress before it asks for anything else.
  // Saving details after a pay-out the rail already accepted is not a pay-out, so it carries on.
  if (state !== 'PAYOUT_SAVE' && (await isPayoutHeld({ prisma: prismaClient }))) return { state: null, text: PAYOUT_HOLD_COPY };
  // "Save these details for next time?" after a pay-out the rail accepted. A
  // yes-only write and never a trap: YES saves, NO keeps nothing, anything
  // else keeps nothing AND is answered as a fresh message (passthrough).
  if (state === 'PAYOUT_SAVE') {
    // The optional name question after a bare YES (founder 2026-10-12): a name sets it,
    // a no or a plain "ok" leaves it, anything else is answered as a new message.
    if (data.nicknameFor) {
      if (SKIP_NAME.test(t)) return { state: null, text: `👍 Kept as ${data.nicknameLabel || 'it is'}, without a name.` };
      const a = parseSaveAnswer(t);
      if (a.kind === 'no' || (a.kind === 'yes' && !a.nickname)) return { state: null, text: `👍 Kept as ${data.nicknameLabel || 'it is'}, without a name.` };
      if (!a.nickname) return { state: null, passthrough: true };
      const named = await (deps.setNickname || realSetNickname)({ prisma: prismaClient, accountId: account.id, id: data.nicknameFor, nickname: a.nickname }).catch(() => ({ ok: false }));
      if (!named?.ok) return { state: null, text: `I could not save the name just now. The details are still saved as ${data.nicknameLabel || 'they were'}.` };
      return { state: null, text: `✅ Called it *${named.nickname}*: ${named.label}. Next time you withdraw, say "${named.nickname.toLowerCase()}" to use it.` };
    }
    const answer = parseSaveAnswer(t);
    if (answer.kind === 'yes') {
      const r = data.recipient || {};
      const kept = [];
      let savedDest = null;
      // The customer's own WhatsApp number is theirs by definition: named "Mine" without a question.
      const ownNumber = DESTINATION_FAMILY[data.method] === 'CASH' && !!r.mobile && normaliseMsisdn(r.mobile) === normaliseMsisdn(String(account.msisdn || account.waId || ''));
      if (data.saveDestination) {
        const d = await (deps.saveDestination || realSaveDestination)({ prisma: prismaClient, accountId: account.id, method: data.method, recipient: r, nickname: answer.nickname || (ownNumber ? 'mine' : null) }).catch(() => ({ ok: false }));
        if (d?.ok) { kept.push(d.label); savedDest = d; }
      }
      if (data.saveIdentity && r.fullName && r.id_number) {
        const idType = r.id_type === 'PASSPORT' ? 'PASSPORT' : 'RSAID';
        const s = await (deps.saveIdentity || realSaveIdentity)({ prisma: prismaClient, accountId: account.id, fullName: r.fullName, idNumber: r.id_number, idType, countryOfIssue: idType === 'PASSPORT' ? r.country_of_issue : null }).catch(() => ({ ok: false }));
        if (s?.ok) kept.push(`your name and ${idNounOf(idType)} ending ${s.idLast3}`);
      }
      if (!kept.length) return { state: null, text: `I could not save those details just now, so nothing is kept. Your withdrawal is not affected.` };
      // A bare YES for a number that is not their own WhatsApp number: ask once what to call it (optional).
      if (savedDest?.id && !answer.nickname && !ownNumber) {
        return { state: 'PAYOUT_SAVE', data: { nicknameFor: savedDest.id, nicknameLabel: savedDest.label }, text: `✅ Saved, encrypted: ${kept.join(' and ')}. What should I call it? Reply *mine*, or a name like *mother*. Say "forget my bank details" any time and they are erased.` };
      }
      const nick = answer.nickname || (ownNumber && savedDest ? 'Mine' : null);
      const as = nick ? ` as *${nick}*` : '';
      return { state: null, text: `✅ Saved${as}, encrypted: ${kept.join(' and ')}. Next time you withdraw, just pick it from the list${nick ? ` or say "${nick.toLowerCase()}"` : ''}. Say "forget my bank details" any time and they are erased.` };
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
  // "I don't have a bank account" after the bank opener (or at the menu): cash, which needs none.
  if ((state === 'PAYOUT_METHOD' || state === 'PAYOUT_AMOUNT') && NO_BANK_RE.test(t)) return noBankAnswer({ account, data });
  // "All of it" / "everything" at the amount step: the most this method can take with its fee.
  if (state === 'PAYOUT_AMOUNT' && data.method && ALL_RE.test(t)) {
    const cap = affordableMaxCents({ method: data.method, balanceCents: data.balanceCents, limits: data.limits, receipts: data.receipts });
    if (cap != null) { const bad = validateAmount(data, cap); return bad || recipientAsk({ ...data, amountCents: cap, offerMethod: null, offerAmountCents: null }); }
  }
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
    // The pay-out rules at the amount step, so nobody types bank details for a pay-out that cannot happen.
    const rules = await checkPayoutRules({ prisma: prismaClient, account, amountCents });
    if (!rules.ok) {
      // The identity check interrupts the ask: keep it, so the flow continues by itself once verified.
      if (rules.error === 'KYC_REQUIRED') await rememberPendingWithdraw({ prisma: prismaClient, accountId: account.id, ask: { amountCents, method: data.method || null } });
      return rulesStop({ rules, data, amountCents });
    }
    return recipientAsk({ ...data, amountCents });
  }
  if (state === 'PAYOUT_MOBILE') {
    const chosen = pickSavedDestination(t, data.savedChoices);
    if (chosen) return afterRecipient({ ...data, recipient: { ...data.recipient, savedId: chosen.id, savedLabel: chosen.label } });
    if (coolingNow(data)) return { state, data, text: coolOffText(data.coolOffUntil) };
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
    if (coolingNow(data)) return { state, data, text: coolOffText(data.coolOffUntil) };
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
    const doc = parseIdDocument(t);
    // The country of a passport or foreign ID typed one message ago.
    if (data.idPending && !(doc && doc.idType === 'RSAID')) {
      const cc = parseCountry(t);
      if (!cc) return { state, data, text: `I did not recognise that country. ${COUNTRY_ASK}` };
      // A South African number with no letters is a mistyped ID, not a passport.
      if (cc === 'ZA' && /^\d+$/.test(data.idPending)) return { state, data: { ...data, idPending: null }, text: `A South African ID number has 13 digits. Please type it again, or your passport number, or "cancel".` };
      const { idPending, ...rest } = data;
      return confirmAsk({ ...rest, recipient: { ...data.recipient, id_number: idPending, id_type: 'PASSPORT', country_of_issue: cc } });
    }
    if (!doc) return { state, data, text: `That does not look like an ID number. ${ID_ASK}` };
    if (doc.idType === 'RSAID') {
      const { id_type, country_of_issue, ...recipient } = data.recipient || {};
      return confirmAsk({ ...data, idPending: null, recipient: { ...recipient, id_number: doc.idNumber } });
    }
    return { state, data: { ...data, idPending: doc.idNumber }, text: COUNTRY_ASK };
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
  if (state === 'PAYOUT_ID') return /^\D*\d[\d\s]{11,14}\D*$/.test(t) || !!parseIdDocument(t) || (!!data.idPending && !!parseCountry(t));
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
  if (state === 'PAYOUT_ID') return data?.idPending ? COUNTRY_ASK : `Please type your 13-digit South African ID number, or your passport or foreign ID number.`;
  if (state === 'PAYOUT_CONFIRM') return confirmAsk(data).text;
  return `Reply "withdraw" to start again.`;
}

/**
 * A late answer to a withdrawal that timed out (BUGLOG #111, Lisa
 * 2026-10-15: she typed her ID four hours after the question; the flow had
 * expired at 30 minutes, her ID went to the AI, and the AI asked for her PIN
 * and wrote "Your payout is being confirmed now" with nothing sent). The
 * next message is read against the step that expired:
 *   'RESUME'     an answer to a details step (account, bank, cellphone, name,
 *                ID): the withdrawal carries on where it stopped; the
 *                confirmation that follows shows everything before any PIN;
 *   'RECONFIRM'  "yes" at the confirmation or a PIN at the PIN step: nothing
 *                is approved late; the confirmation is shown again, fresh;
 *   'STOPPED'    an answer to a step older than WAPAY_PAYOUT_RESUME_HOURS
 *                (default 24): said plainly, never handed to the AI;
 *   null         anything else: the message is new.
 * Pure.
 */
export const RESUME_HOURS = () => Math.max(0, Number(process.env.WAPAY_PAYOUT_RESUME_HOURS ?? 24));
const RESUME_STEPS = ['PAYOUT_ACCOUNT', 'PAYOUT_BRANCH', 'PAYOUT_MOBILE', 'PAYOUT_NAME', 'PAYOUT_ID'];
const COURTESY = /^\W*(?:good|hi|hello|hey|morning|afternoon|evening|thanks|thank|ok|okay|yes|no|sorry|please|sharp|cool|what|why|how|when|where|is|are|did|can)\b/i;
export function lateWithdrawAnswer({ state, data, text, account = null, setAt, now = Date.now() } = {}) {
  if (!data?.method || !data?.amountCents) return null;
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t || wantsAnotherFlow(t) || CANCEL_RE.test(t)) return null;
  let kind = null;
  if (RESUME_STEPS.includes(state)) {
    if (state === 'PAYOUT_NAME' && (SKIP_NAME.test(t) || COURTESY.test(t))) return null;
    if (stepInputParses(state, t, data, account)) kind = 'RESUME';
  } else if (state === 'PAYOUT_CONFIRM' && /^\W*(yes|yebo|ewe|ja|y|confirm|ok|okay)\W*$/i.test(t)) kind = 'RECONFIRM';
  else if (state === 'PAYOUT_PIN' && /^\s*\d{4,6}\s*$/.test(t)) kind = 'RECONFIRM';
  if (!kind) return null;
  const at = Date.parse(setAt || '');
  if (!at || now - at > RESUME_HOURS() * 3600 * 1000) return 'STOPPED';
  return kind;
}

/**
 * lateWithdrawAnswer with the money read again: hours have passed, so the
 * balance and the PIN-reset cool-off are fetched fresh, never carried.
 * Returns { resume: true, state, data } (carry on with this message),
 * a step { state, data, text } (send it), or null (a new message).
 */
export async function resumeLateWithdraw({ prisma: prismaClient = prisma, account, state, data, text, setAt, deps = {}, now = Date.now() } = {}) {
  const kind = lateWithdrawAnswer({ state, data, text, account, setAt, now });
  if (!kind) return null;
  const stopped = { state: null, text: `⏱️ Your withdrawal of ${R(data.amountCents)} stopped because it waited too long for a reply, so I did not use what you just sent. Nothing was sent and your money has not moved. Say *withdraw* to start again.` };
  if (kind === 'STOPPED') return stopped;
  const balances = await (deps.payoutBalances || realPayoutBalances)({ prisma: prismaClient, accountId: account.id }).catch(() => null);
  if (!balances) return stopped;
  const receipts = await (deps.recentReceipts || realRecentReceipts)({ prisma: prismaClient, accountId: account.id }).catch(() => []);
  const cool = (deps.pinResetCoolOff || realCoolOff)({ account });
  const { coolOffUntil, ...rest } = data;
  const fresh = { ...rest, balanceCents: balances.totalCents, receipts, ...(cool?.until ? { coolOffUntil: new Date(cool.until).toISOString() } : {}) };
  if (kind === 'RESUME') return { resume: true, state, data: fresh };
  const c = confirmAsk(fresh);
  const pinLine = state === 'PAYOUT_PIN' ? ' I did not use the PIN you just sent.' : '';
  return { ...c, text: `⏱️ This withdrawal waited a while, so I am checking it with you again before your PIN.${pinLine} Nothing has been sent yet.\n\n${c.text}` };
}

/** True only when OTT itself acknowledged the request (a real payout status); false for a timeout or an unreadable answer. */
export function payoutHandedOver(outcome) {
  const o = String(outcome || '');
  return o !== '' && o !== 'TRANSPORT_INDETERMINATE' && o !== 'UNKNOWN' && !o.startsWith('HTTP_');
}

/** What a PENDING pay-out will do when it lands: the bank's own notice, or the SMS and the steps. */
function pendingArrival(method, mobile) {
  if (DESTINATION_FAMILY[method] === 'BANK') return `When the bank confirms it, the credit shows in your bank's own app or SMS as well.`;
  const to = mobile ? `•••${String(mobile).replace(/\D/g, '').slice(-4)}` : 'the number you gave';
  return `When it is paid, the code comes by SMS to ${to} and I will send you the collection steps here.`;
}

/** After a verified PIN: the one call that moves money. */
export async function executeWithdraw({ prisma: prismaClient = prisma, account, data, pinProof = null, deps = {} }) {
  // The PIN proof, first (BUGLOG #112): this customer typed their PIN for
  // this intent and this amount within two minutes. Without it nothing is
  // read, held or sent. The real verifier always: no dependency can stand in.
  const proof = verifyPinProof(pinProof, { accountId: account?.id, intentId: data?.intentId, amountCents: data?.amountCents });
  if (!proof.ok) {
    console.error(JSON.stringify({ type: 'withdraw_refused_no_pin_proof', accountId: account?.id || null, reason: proof.reason }));
    return { state: null, done: false, text: `🔒 I could not confirm your PIN for this withdrawal, so nothing was sent and nothing has left your balance. Say *withdraw* to start again.` };
  }
  const rec = { ...(data.recipient || {}) };
  // The PIN-reset cool-off, read again right before money moves.
  if (!rec.savedId) {
    const cool = (deps.pinResetCoolOff || realCoolOff)({ account });
    if (cool?.until) return { state: null, done: false, text: `${coolOffText(cool.until)} Nothing was sent and nothing has left your balance.` };
  }
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
    if (identity?.idNumber && !rec.id_number) {
      rec.id_number = identity.idNumber;
      if (identity.idType === 'PASSPORT') Object.assign(rec, { id_type: 'PASSPORT', country_of_issue: identity.countryOfIssue || null });
    }
  }
  // A passport or foreign ID goes with its kind, its issuing country and the
  // same country as nationality (OTT fills both as "ZA" when nothing is sent);
  // an SA ID goes exactly as before, without id_type.
  const idKind = rec.id_type === 'PASSPORT' ? 'PASSPORT' : 'RSAID';
  if (idKind === 'PASSPORT') Object.assign(rec, { id_type: passportIdType(), nationality: rec.country_of_issue });
  else { delete rec.id_type; delete rec.country_of_issue; delete rec.nationality; }
  const { fullName, savedId, savedLabel, ...wire } = rec;
  const recipient = { ...recipientName(account, fullName || identity?.fullName || null), ...wire };
  const out = await (deps.requestPayout || realRequestPayout)({ prisma: prismaClient, account, intentId: data.intentId, method: data.method, amountCents: data.amountCents, recipient, client: deps.client, providers: deps.providers, authorization: pinProof, expectedFeeCents: Number.isInteger(data.feeCents) ? data.feeCents : null });

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
    const what = [saveDestination ? destinationLabel(data.method, wire) : null, saveIdentity ? `your name and ${idNounOf(idKind)} ending ${String(wire.id_number).slice(-3)}` : null].filter(Boolean).join(' and ');
    const savedRec = { fullName: fullName || null, id_number: wire.id_number || null, id_type: idKind, country_of_issue: idKind === 'PASSPORT' ? wire.country_of_issue || null : null, account_number: wire.account_number || null, branch_code: wire.branch_code || null, branch_name: wire.branch_name || null, mobile: wire.mobile || null };
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
  if (out.error === 'PAYOUT_HOLD') return { state: null, done: false, text: PAYOUT_HOLD_COPY };
  // The fee went up after the confirmation because money arrived in between (the express fee, 2026-10-24).
  if (out.error === 'FEE_CHANGED') return { state: null, done: false, text: feeChangedCopy(out) };
  // The fraud triage asked for a person's check first (lib/payout-triage.js, 2026-10-24).
  if (out.error === 'REVIEW') return { state: null, done: false, text: PAYOUT_REVIEW_COPY };
  if (out.error === 'FROZEN') return { state: null, done: false, text: FROZEN_PAYOUT_COPY };
  if (out.error === 'DAILY_CAP') return { state: null, done: false, text: dailyCapCopy(out).replace(/Type a smaller amount, or "cancel"\.$/, 'Say "withdraw" to try a smaller amount.') };
  if (out.error === 'KYC_REQUIRED' && out.reason) {
    await rememberPendingWithdraw({ prisma: prismaClient, accountId: account.id, ask: { amountCents: data.amountCents, method: data.method || null } });
    return { state: out.kycConfigured ? 'PAYOUT_KYC' : null, data, done: false, text: kycThresholdCopy(out) };
  }
  if (out.error === 'FLOAT_SHORT') {
    // Our float, not their bank (BUGLOG #129): say so, keep the money where it is, name the person only when the alert went.
    return { state: null, done: false, text: `❌ This withdrawal could not be made right now: our pay-out account is being topped up. Nothing has left your balance and your money is safe. Try again a little later${out.alerted ? '; a person from the WaPay team has been told' : ''}. Say "withdraw" when you want to try again.` };
  }
  const why = out.error === 'INSUFFICIENT_FUNDS' ? `you no longer have ${R(out.totalCents || (data.totalCents || 0))} available` : out.error === 'KYC_REQUIRED' ? 'your identity check has not cleared yet' : out.error === 'NO_PROVIDER' ? 'that pay-out method is not available right now' : out.error === 'BAD_RECIPIENT' ? `the ${String(out.field || 'details').replace('_', ' ')} was not accepted` : out.error === 'DISABLED' || out.error === 'NOT_CONFIGURED' ? 'withdrawals are not switched on yet' : out.error === 'REQUEST_INVALID' ? 'the bank rail could not read our request (our side, not yours) and we are fixing it' : `the bank rail declined it (${out.error || 'unknown'})`;
  return { state: null, done: false, text: `❌ The withdrawal did not go through: ${why}. Nothing has left your balance. Say "withdraw" to try again.` };
}
