/**
 * The conversation knowledge base: how each WaPay transaction type works, in
 * the words of a knowledgeable friend (founder review 2026-09-15: "Can I buy
 * electricity?" started the electricity flow, "Can they withdraw the OTT
 * voucher for money?" started a withdrawal, "If I send someone money, can
 * they withdraw it?" was read as a menu choice).
 *
 * One entry per topic. Every number comes from the same constants and fee
 * functions the flows use, so the explanation can never drift from what the
 * flow does. Three consumers:
 *   - matchHowItWorksAsk(text): a QUESTION about a capability or process
 *     (never an imperative with an amount or a number, which is a command);
 *   - howItWorksAnswer(topic, ctx): the deterministic reply, hooked in the
 *     processor before any flow starts and used as the in-flow aside;
 *   - howItWorksFacts(ctx): the HOW IT WORKS block for the AI's knowledge, so
 *     free-text questions the matcher misses still get the right steps;
 *   - docs/CONVERSATION_KNOWLEDGE_BASE.md is generated from TOPICS
 *     (scripts/gen-knowledge-base-doc.mjs).
 *
 * English; the processor localizes. Customer copy rules: no em dashes, never
 * a betting word, never name the payout partner, never promise a date.
 */
import { feeSchedule, payoutLive } from './fee-facts.js';
import { MIN_PAYOUT_CENTS, MAX_PAYOUT_CENTS, methodLimits } from './payouts.js';
import { MIN_DEPOSIT_CENTS, MAX_DEPOSIT_CENTS, PAYREQ_FREE_BELOW_CENTS } from './deposits.js';
import { MIN_REQUEST_CENTS, MAX_REQUEST_CENTS } from './payment-requests.js';
import { cashoutFeeCents } from './ledger-core.js';
import { OTT_PIN_DIGITS, OTT_EXPIRY_MONTHS, ottAcceptedFacts as ottAcceptedFactsData, ottRedemptionFacts, ottAcceptanceAnswer, lookupOttMerchant } from './ott-acceptance.js';

/** Withdrawal fees straight from the fee table, independent of the payout switch (the switch decides what is SAID, not what the table holds). */
const withdrawFees = () => ({ payshapCents: cashoutFeeCents('PAYSHAP', 10000), cashsend: [[70000, cashoutFeeCents('CASHSEND', 70000)], [150000, cashoutFeeCents('CASHSEND', 150000)], [Infinity, cashoutFeeCents('CASHSEND', 300000)]] });

// VAS bounds live in the preview routes (pages/api/vas/*/preview.js); mirrored here, locked by tests.
export const VAS_LIMITS = { AIRTIME: [500, 100000], ELECTRICITY: [1000, 500000], VOUCHER: [1000, 100000] };

const R = (cents) => (cents % 100 === 0 ? `R${cents / 100}` : `R${(cents / 100).toFixed(2)}`);
const pct = (bps) => `${(bps / 100).toString().replace(/\.0$/, '')}%`;

/** Which withdrawal method a sentence names, if any ('CASH' = any ATM cash, unspecified bank). */
export function detectMethod(text) {
  const t = String(text || '').toLowerCase();
  if (/\babsa\b|cash ?-?send/.test(t)) return 'CASHSEND';
  if (/\bnedbank\b/.test(t)) return 'NEDCASH';
  if (/\bfnb\b|e-?wallet/.test(t)) return 'EWALLET';
  if (/payshap|\bshap\b/.test(t)) return 'PAYSHAP';
  if (/bank transfer|\beft\b|\brtc\b|account number|(?:to|into) (?:my |a )?bank/.test(t)) return 'PAYSHAP';
  if (/\batm\b|\bcash\b/.test(t)) return 'CASH';
  return null;
}
/** "How do I…", "instructions", "steps", "once I get the PIN": the customer wants the walkthrough, not the one-liner. */
export function wantsSteps(text) {
  return /\b(how (?:do|can|does|would|to) (?:i|you|it|we|one)|instructions?|steps?|step by step|guide|walk me|explain|show me how|what happens|process|once i (?:get|have)|after i (?:get|have)|use the atm|at the atm|collect)\b/i.test(String(text || ''));
}
const METHOD_NAME = { PAYSHAP: 'PayShap to your bank account', RTC: 'a bank transfer', CASHSEND: 'cash at an Absa ATM or a Pick n Pay / Boxer till', NEDCASH: 'cash at a Nedbank ATM', EWALLET: 'an FNB eWallet collected at any FNB ATM' };
/** What the customer does after the SMS arrives. Generic enough to stay true; the SMS carries the exact codes. */
function collectionSteps(method) {
  if (method === 'CASHSEND') return `Collecting at Absa: go to any Absa ATM (or a Pick n Pay or Boxer till), choose *CashSend*, enter the cellphone number that received the SMS and the codes in that SMS, and take the cash. No card needed. The cash stays collectable for 30 days.`;
  if (method === 'NEDCASH') return `Collecting at Nedbank: go to any Nedbank ATM, choose *Cardless services*, enter the cellphone number that received the SMS and the withdrawal code in that SMS, and take the cash. No card needed.`;
  if (method === 'EWALLET') return `Collecting your eWallet: go to any FNB ATM, choose *Cardless services* then *eWallet*, enter the cellphone number that received the SMS and the ATM PIN in that SMS, choose the amount, and take the cash. No card or bank account needed.`;
  if (method === 'PAYSHAP') return `PayShap lands directly in your bank account, usually within minutes; there is nothing to collect.`;
  return `Collecting cash: the SMS tells you exactly which codes to enter. At an Absa ATM choose CashSend, at a Nedbank ATM choose Cardless services, at an FNB ATM choose Cardless services then eWallet; enter the cellphone number that received the SMS and the codes, and take the cash. No card needed.`;
}
const OFFER = (example) => `Want me to take you through it step by step? Reply *YES* and I will start, or say "${example}" any time. 😊`;

/**
 * TOPICS: id → { title, keywords (topic detection), answer(ctx) -> string }.
 * ctx: { withdrawLive, wicodeLive, fuelPartners: string[], ottFacts: string, providers: [] }
 */
export const TOPICS = {
  withdraw: {
    title: 'Withdrawing money (cash-out)',
    keywords: /\b(withdraw\w*|cash ?-?out|take (?:my |the )?money out|money out|get (?:my )?cash|atm|payshap|bank transfer|(?:to|into) (?:my |a )?bank)\b/i,
    startCommand: 'withdraw',
    example: 'withdraw R50',
    /** The short, specific answer: the method the customer named, its fee, its minimum, what they need. */
    brief(ctx) {
      if (!(ctx.withdrawLive ?? payoutLive())) return TOPICS.withdraw.answer(ctx);
      const m = detectMethod(ctx.text || '');
      const w = withdrawFees();
      const lim = (method) => methodLimits(method, ctx.providers || []);
      const cashFee = R(w.cashsend[0][1]);
      if (m === 'CASHSEND') return `✅ Yes. You can collect cash at any Absa ATM or a Pick n Pay / Boxer till, no bank account needed: ${cashFee} fee up to R700, from ${R(lim('CASHSEND').minCents)}. You need the cellphone number that will get the SMS code and your 13-digit ID number.`;
      if (m === 'NEDCASH') return `✅ Yes. You can collect cash at any Nedbank ATM with a code sent by SMS, no bank account needed: ${cashFee} fee up to R700, from ${R(lim('NEDCASH').minCents)}. You need the cellphone number for the SMS and your 13-digit ID number.`;
      if (m === 'EWALLET') return `✅ Yes. An FNB eWallet: the code comes by SMS and you collect the cash at any FNB ATM, no bank account needed: ${cashFee} fee up to R700, from ${R(lim('EWALLET').minCents)}. You need the cellphone number for the SMS and your 13-digit ID number.`;
      if (m === 'PAYSHAP') return `✅ Yes. PayShap moves money into your own bank account in minutes for ${R(w.payshapCents)}, from ${R(lim('PAYSHAP').minCents)}. You need your account number and bank, plus your 13-digit ID number.`;
      if (m === 'CASH') return `✅ Yes. You can collect cash at an Absa or Nedbank ATM, a Pick n Pay / Boxer till, or as an FNB eWallet at any FNB ATM, no bank account needed: ${cashFee} fee up to R700, from ${R(Math.min(lim('CASHSEND').minCents, lim('NEDCASH').minCents, lim('EWALLET').minCents))}. You need a cellphone number for the SMS code and your 13-digit ID number.`;
      return `✅ Yes. You can move money to your own bank account by PayShap (${R(w.payshapCents)}, minutes) or collect cash at an Absa or Nedbank ATM, a Pick n Pay / Boxer till, or as an FNB eWallet (from ${cashFee}). Withdrawals start at ${R(Math.min(lim('PAYSHAP').minCents, lim('CASHSEND').minCents, lim('NEDCASH').minCents, lim('EWALLET').minCents))} and you need your 13-digit ID number.`;
    },
    answer(ctx) {
      if (!(ctx.withdrawLive ?? payoutLive())) {
        return `🏧 Taking money out of WaPay is not available just yet, but it is coming soon. For now your balance works for airtime, data, electricity, WaPay vouchers, sending money and getting paid.`;
      }
      const w = withdrawFees();
      const ps = methodLimits('PAYSHAP', ctx.providers || []);
      const cs = w.cashsend;
      const m = detectMethod(ctx.text || '');
      const collect = `\n\n${collectionSteps(m === 'CASH' ? null : m)}`;
      return (
        `🏧 Yes, you can take money out of WaPay. Here is how it works:\n\n` +
        `1️⃣ Say *withdraw* and the amount, for example "withdraw R200" (between ${R(ps.minCents)} and ${R(ps.maxCents)}).\n` +
        `2️⃣ Choose how: *PayShap* to your own bank account (${R(w.payshapCents)} fee, arrives in minutes), or *cash* at an Absa or Nedbank ATM, a Pick n Pay / Boxer till, or as an FNB eWallet collected at any FNB ATM, no bank account needed (${R(cs[0][1])} fee up to ${R(cs[0][0])}, ${R(cs[1][1])} up to ${R(cs[1][0])}, ${R(cs[2][1])} above).\n` +
        `3️⃣ Give the details the bank needs: your account number and bank for PayShap, or the cellphone number that will collect the cash, plus your 13-digit SA ID number.\n` +
        `4️⃣ Confirm, then enter your WaPay PIN. The amount plus the fee leaves your balance, you get a reference straight away, and I message you the moment the bank confirms.\n\n` +
        `A once-off identity check applies before your first withdrawal. The money must go to an account or a person in your own name.` +
        collect
      );
    },
  },
  send: {
    title: 'Sending money to another person',
    startCommand: 'send money',
    example: 'send R50 to 083 123 4567',
    brief(ctx) {
      const s = feeSchedule();
      const live = ctx.withdrawLive ?? payoutLive();
      const asksWithdraw = /\b(withdraw|cash|bank|take .* out)\b/i.test(ctx.text || '');
      return `✅ Yes. Say "send R50 to 083 123 4567" or share a contact card; confirm and enter your PIN. If they are on WaPay it lands in their balance instantly and it is free; if not, they get a WaPay voucher PIN by WhatsApp (${R(s.send.voucherGiftCents)} fee). ${asksWithdraw ? (live ? `They can spend it, send it on, or withdraw it to their own bank account (${R(withdrawFees().payshapCents)}) or as ATM cash (from ${R(withdrawFees().cashsend[0][1])}) after a once-off identity check.` : 'They can spend it or send it on; cash withdrawals are coming soon.') : 'They can spend it on airtime, data, electricity or vouchers, or send it on.'}`;
    },
    keywords: /\b(send\w* (?:money|cash|r\d+|someone|to)|transfer\w* (?:money|to)|pay (?:a |my )?(?:friend|someone|family|brother|sister|mother|father|mom|dad)|give (?:someone|them) money|can they (?:withdraw|use|spend|get))\b/i,
    answer(ctx) {
      const s = feeSchedule();
      const w = withdrawFees();
      const live = ctx.withdrawLive ?? payoutLive();
      return (
        `💸 Sending money is simple: say "send R50 to 083 123 4567", use a saved name like "send R50 to Philly", or share a contact card from your phone. Confirm, enter your PIN, done.\n\n` +
        `If the person is on WaPay the money lands in their WaPay balance instantly and it is free. If they are not, they receive a WaPay voucher PIN by WhatsApp (${R(s.send.voucherGiftCents)} fee, ${R(VAS_LIMITS.VOUCHER[0])} to ${R(VAS_LIMITS.VOUCHER[1])}) which they can spend online wherever OTT vouchers are accepted, or load into WaPay by joining.\n\n` +
        (live
          ? `What can they do with it? Spend it on airtime, data, electricity or vouchers, send it on, or withdraw it to their own bank account (${R(w.payshapCents)}) or as cash at an Absa ATM (from ${R(w.cashsend[0][1])}) after a once-off identity check.`
          : `What can they do with it? Spend it on airtime, data, electricity or vouchers, or send it on. Cash withdrawals are coming soon.`)
      );
    },
  },
  ott: {
    title: 'WaPay (OTT) vouchers: buying and where they work',
    startCommand: 'buy an OTT voucher',
    example: 'buy an OTT voucher for R100',
    brief(ctx) {
      const t = ctx.text || '';
      if (lookupOttMerchant(t)) return ottAcceptanceAnswer(t);
      if (/\b(cash|withdraw|money out|bank|exchange|refund)\b/i.test(t)) {
        const live = ctx.withdrawLive ?? payoutLive();
        return `❌ No. An OTT voucher cannot be exchanged for cash or paid into a bank account; it is spent online at partners that take it (Talk360, fibertime, Pay@ bills, Xash and others). ${live ? `If you want cash, withdraw from your WaPay balance instead: PayShap to your bank (${R(withdrawFees().payshapCents)}) or ATM cash (from ${R(withdrawFees().cashsend[0][1])}).` : 'Keep the money in your WaPay balance if you may need it as cash later.'}`;
      }
      if (/\b(where|accept\w*|use|spend|work)\b/i.test(t)) return `🎟️ ${ottAcceptedFactsData()}`;
      return `🎟️ A WaPay voucher is an OTT voucher: a ${OTT_PIN_DIGITS}-digit PIN (${R(VAS_LIMITS.VOUCHER[0])} to ${R(VAS_LIMITS.VOUCHER[1])}) that arrives here in the chat and is spent online at partners such as Talk360, fibertime, Pay@ and Xash, never at a shop till and never for cash. Buying one for yourself is free.`;
    },
    keywords: /\b(ott|vouchers? (?:accepted|work|be used|spend)|accept\w* (?:the |an? )?vouchers?|where (?:can|do) i (?:use|spend) (?:the |my |an? )?voucher|buy (?:an? )?voucher|voucher code|voucher pin)\b/i,
    answer(ctx) {
      // A named merchant gets a yes or no first ("is it accepted at Checkers?").
      const named = ctx.text && lookupOttMerchant(ctx.text) ? `${ottAcceptanceAnswer(ctx.text)}\n\n` : '';
      return (
        named +
        `🎟️ A WaPay voucher is an OTT voucher: a ${OTT_PIN_DIGITS}-digit PIN worth the amount you choose (${R(VAS_LIMITS.VOUCHER[0])} to ${R(VAS_LIMITS.VOUCHER[1])}). Say "buy an OTT voucher for R100", confirm, enter your PIN, and the PIN arrives right here in the chat. Buying one for yourself is free.\n\n` +
        (named ? '' : `Where it works: ${ottAcceptedFactsData()}\n\n`) +
        `Good to know: ${ottRedemptionFacts()}`
      );
    },
  },
  electricity: {
    title: 'Prepaid electricity',
    startCommand: 'buy electricity',
    example: 'buy R100 electricity',
    brief() { return `💡 Yes: prepaid electricity for any meter, ${R(VAS_LIMITS.ELECTRICITY[0])} to ${R(VAS_LIMITS.ELECTRICITY[1])}, no WaPay fee. You give the meter number, confirm, enter your PIN, and the 20-digit token arrives here in the chat within about a minute.`; },
    keywords: /\b(electricity|prepaid power|units|meter|eskom|city power|kwh)\b/i,
    answer() {
      return (
        `💡 Yes, you can buy prepaid electricity for any meter, from ${R(VAS_LIMITS.ELECTRICITY[0])} to ${R(VAS_LIMITS.ELECTRICITY[1])}, with no WaPay fee.\n\n` +
        `Say "buy R100 electricity", give me the meter number (11 to 13 digits, on your meter or an old slip), confirm, and enter your PIN. The 20-digit token arrives here in the chat, usually within a minute; some municipalities take up to about 90 seconds. Type the token into your meter and you are done.`
      );
    },
  },
  airtime: {
    title: 'Airtime',
    startCommand: 'buy airtime',
    example: 'buy R50 airtime',
    brief() { return `📱 Yes: airtime for your number or any SA number on Vodacom, MTN, Cell C or Telkom, ${R(VAS_LIMITS.AIRTIME[0])} to ${R(VAS_LIMITS.AIRTIME[1])}, no WaPay fee, loaded within seconds after your PIN.`; },
    keywords: /\b(airtime|top ?up my (?:phone|number)|recharge)\b/i,
    answer() {
      return `📱 Yes: airtime for your own number or any South African number, ${R(VAS_LIMITS.AIRTIME[0])} to ${R(VAS_LIMITS.AIRTIME[1])}, Vodacom, MTN, Cell C or Telkom, no WaPay fee. Say "buy R50 airtime" for yourself, or "send R20 airtime to 083 123 4567" for someone else. Confirm, PIN, and it lands within seconds.`;
    },
  },
  data: {
    title: 'Data bundles',
    startCommand: 'buy data',
    example: 'show MTN bundles',
    brief() { return `📶 Yes: daily, weekly and monthly bundles for Vodacom, MTN, Cell C and Telkom, for your number or anyone else's, no WaPay fee, loaded within seconds after your PIN.`; },
    keywords: /\b(data|bundles?|gigs?|gb|mb|wifi)\b/i,
    answer() {
      return `📶 Yes: daily, weekly and monthly data bundles for Vodacom, MTN, Cell C and Telkom, for your number or anyone else's, no WaPay fee. Say "show MTN bundles" to browse, or "buy 1GB data" to go straight to it. Confirm, PIN, and the bundle is loaded within seconds.`;
    },
  },
  deposit: {
    title: 'Adding money (deposits)',
    startCommand: 'deposit',
    example: 'deposit R100',
    brief() {
      const s = feeSchedule();
      const ex = s.deposit.examples.slice(0, 2).map((e) => `${R(e.amountCents)} costs ${R(e.totalCents)}`).join(', ');
      return `💳 Two ways: by card, Instant EFT, Apple Pay or Google Pay through a secure link (${pct(s.deposit.bps)} + ${R(s.deposit.fixedCents)} on top, rounded up: ${ex}; ${R(MIN_DEPOSIT_CENTS)} to ${R(MAX_DEPOSIT_CENTS)}), or with cash by buying a Blu voucher at any major till and sending me the code (the voucher network keeps ${pct(s.cashVoucher.keptBps)}, so R100 adds ${R(s.cashVoucher.creditedPerHundred)}).`;
    },
    keywords: /\b(deposit\w*|add money|load money|top ?up (?:my )?(?:wallet|wapay|balance)|put money|fund my|how (?:do|can) i pay in)\b/i,
    answer() {
      const s = feeSchedule();
      const ex = s.deposit.examples.map((e) => `${R(e.amountCents)} costs ${R(e.totalCents)}`).join(', ');
      return (
        `💳 Two ways to add money.\n\n` +
        `*Card, Instant EFT, Apple Pay or Google Pay:* say "deposit R100" (${R(MIN_DEPOSIT_CENTS)} to ${R(MAX_DEPOSIT_CENTS)}) and I send you a secure payment link. The fee is ${pct(s.deposit.bps)} + ${R(s.deposit.fixedCents)} on top, rounded up to the next rand (${ex}); the full amount lands in your balance the moment the payment clears and I message you.\n\n` +
        `*Cash at a till:* ask any major retailer for a Blu Voucher for the amount you want, then send me the voucher code. The voucher network keeps ${pct(s.cashVoucher.keptBps)}, so a R100 voucher adds ${R(s.cashVoucher.creditedPerHundred)}.`
      );
    },
  },
  request: {
    title: 'Getting paid (please pay me links)',
    startCommand: 'please pay me',
    example: 'please pay me R150',
    brief() {
      const s = feeSchedule();
      return `🙏 Yes: say "please pay me R150" and share the link anywhere; the payer pays exactly that, free from a WaPay balance or by card, and the money lands in your balance instantly. Requests under ${R(PAYREQ_FREE_BELOW_CENTS)} cost you nothing; above that ${pct(s.request.bps)} + ${R(s.request.fixedCents)} comes off what you receive.`;
    },
    keywords: /\b(pay ?me|payment link|pay link|request(?:ing)? money|get paid|invoice|ask (?:someone|them|him|her) to pay|collect money)\b/i,
    answer() {
      const s = feeSchedule();
      return (
        `🙏 Say "please pay me R150" and I create a link you can share anywhere (WhatsApp, SMS, email). Amounts from ${R(MIN_REQUEST_CENTS)} to ${R(MAX_REQUEST_CENTS)}; the link lasts 7 days and can be paid once.\n\n` +
        `The person paying always pays exactly the amount, with no fee: free from their WaPay balance, or by card or Instant EFT. On requests under ${R(PAYREQ_FREE_BELOW_CENTS)} you pay nothing either; above that ${pct(s.request.bps)} + ${R(s.request.fixedCents)} comes off what you receive (a ${R(s.request.example.amountCents)} request pays you ${R(s.request.example.netCents)}). The money lands in your WaPay balance instantly and both of you get a confirmation.`
      );
    },
  },
  fuel: {
    title: 'Fuel vouchers',
    startCommand: 'buy fuel',
    example: 'buy fuel',
    brief(ctx) { return TOPICS.fuel.answer(ctx); },
    keywords: /\b(fuel|petrol|diesel|garage|filling station|wicode)\b/i,
    answer(ctx) {
      if (ctx.wicodeLive) {
        const names = (ctx.fuelPartners || []).join(' and ') || 'participating';
        return `⛽ Yes: say "buy fuel" and the amount, confirm, enter your PIN, and I send you a UniFuel voucher code to use at participating ${names} stations. Give the code to the attendant before they start filling up; if you use less than the value, the balance stays yours and I send a fresh code for it.`;
      }
      return `⛽ Fuel vouchers are coming to WaPay soon, and we are just as excited as you are! I will tell you the moment they go live. In the meantime your money works for airtime, data, electricity, vouchers, sending and getting paid.`;
    },
  },
  balance: {
    title: 'Balance, vouchers and history',
    startCommand: 'balance',
    example: 'balance',
    brief() { return TOPICS.balance.answer(); },
    keywords: /\b(my balance|check (?:my )?balance|how much (?:money )?(?:do i have|is in)|my vouchers|voucher history|my transactions|statement|history)\b/i,
    answer() {
      return `💰 Say "balance" any time to see what you have. "My vouchers" lists the vouchers you have bought with their values and status. If a payment or deposit has not shown up yet, ask "did my payment go through" and I check the ledger for you.`;
    },
  },
  business: {
    title: 'WaPay for Business',
    startCommand: 'business account',
    example: 'business account',
    brief() { return `🏪 Yes. Say "business account" and your trading name, and you get a WaPay for Business portal: customers, itemised please-pay-me links, QR codes and who has paid.`; },
    keywords: /\b(business account|for my (?:shop|business|spaza|salon)|get paid by (?:my )?customers|business portal)\b/i,
    answer() {
      return `🏪 Yes. Say "business account", give your trading name, and you get a WaPay for Business portal: keep your customers, send itemised please-pay-me links, share QR codes, and see who has paid. Say "business login" for your portal code any time.`;
    },
  },
};

const QUESTION_START = /^\W*(can|could|does|do|is|are|how|what|when|where|why|if|will|would|should|am|which|who|may|might|tell me|explain|i want to know|i would like to know|please explain)\b/i;
const COMMAND_SHAPE = /\bR\s?\d|\b\d{2,}\b/;   // an amount or a number: that is a command, the flow handles it
const NOT_HOW = /\b(please pay me|business login|cancel|stop|yes|no|mine)\b/i;
// Real balance / history asks are commands the ledger answers; never explain them instead.
const BALANCE_ASK = /\b(balance|how much (?:money )?(?:do i|have i|is in)|my vouchers|my transactions|did my (?:payment|deposit))\b/i;

/** True when the message reads as a question about a capability or process, not a command. */
export function looksLikeQuestion(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return /\?/.test(t) || QUESTION_START.test(t);
}

/**
 * "Can I buy electricity?" -> 'electricity'; "How do I withdraw?" -> 'withdraw';
 * "buy R50 electricity" -> null (a command); "50" -> null.
 */
export function matchHowItWorksAsk(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 240) return null;
  if (!looksLikeQuestion(t)) return null;
  if (COMMAND_SHAPE.test(t.replace(/\?/g, ''))) return null;
  if (NOT_HOW.test(t) && !/\?/.test(t)) return null;
  if (BALANCE_ASK.test(t)) return null;
  // "Is it accepted at Checkers?": a named shop plus accept/take/use/work is an OTT acceptance question.
  if (/\b(accept\w*|takes?|taking|use|used|work|works|pay|paying|spend|redeem)\b/i.test(t) && lookupOttMerchant(t)) return 'ott';
  // A question about the voucher itself ("can they withdraw the OTT voucher for money?") is an OTT question.
  if (/\b(ott|vouchers?)\b/i.test(t) && TOPICS.ott.keywords.test(t)) return 'ott';
  // Withdraw-with-send: "if I send someone money, can they withdraw it?" is a SEND question.
  if (TOPICS.send.keywords.test(t) && /\b(they|them|someone|friend|family|recipient|person)\b/i.test(t)) return 'send';
  for (const [id, topic] of Object.entries(TOPICS)) if (topic.keywords.test(t)) return id;
  return null;
}

export function howItWorksAnswer(topic, ctx = {}) {
  const t = TOPICS[topic];
  if (!t) return null;
  return t.answer(ctx);
}

/**
 * The short answer to a "can I…" question: the specific fact for what was
 * asked (2 to 4 sentences), then the offer to walk through it. The processor
 * parks a HOWTO_OFFER state so that "YES" starts the flow.
 */
export function howItWorksBrief(topic, ctx = {}) {
  const t = TOPICS[topic];
  if (!t) return null;
  const body = t.brief ? t.brief(ctx) : t.answer(ctx).split('\n\n')[0];
  const comingSoon = /coming soon|not available just yet/i.test(body);
  return comingSoon ? body : `${body}\n\n${OFFER(t.example)}`;
}

/** Compact version for the AI knowledge block: one paragraph per topic. */
export function howItWorksFacts(ctx = {}) {
  const lines = Object.entries(TOPICS).map(([id, t]) => `- ${t.title}: ${t.answer(ctx).replace(/\n+/g, ' ').replace(/\*/g, '')}`);
  return `HOW IT WORKS (answer capability and process questions from THIS, step by step, warmly, and end with the exact words to say to start; never start a flow yourself, never send a menu):\n${lines.join('\n')}`;
}
