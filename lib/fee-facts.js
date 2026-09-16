/**
 * Customer-facing fee facts, computed from the SAME functions that charge
 * the fees (lib/deposits.js, lib/ledger-core.js, lib/payouts.js), so the bot
 * can never quote a number the ledger does not charge (founder review
 * 2026-09-13: "how much does it cost to deposit money?" got a menu, then a
 * refusal, because no fee existed anywhere the bot could read).
 *
 * Two consumers:
 *   - matchFeeAsk(text) + feeAnswer(topic, amountCents): the deterministic
 *     reply to "how much does it cost to…", hooked into the processor BEFORE
 *     the keyword router (which used to swallow the question as a voucher
 *     redemption) and before the withdraw matcher.
 *   - feeFacts(): the FEES block injected into the AI's knowledge each turn,
 *     so a fee question that reaches the model gets the right number instead
 *     of "I don't want to guess".
 *
 * English; the processor localizes. Customer copy rules: no em dashes, never
 * a betting word, never name the payout partner.
 */
import { depositFeeCents, paymentRequestFeeCents, PAYREQ_FREE_BELOW_CENTS, cardRailFee, vatRegistered } from './deposits.js';
import { FEES, cashoutFeeCents } from './ledger-core.js';
import { primaryCardRail, adumoEnabled } from './adumo.js';

const R = (cents) => (cents % 100 === 0 ? `R${cents / 100}` : `R${(cents / 100).toFixed(2)}`);
const pct = (bps) => `${(bps / 100).toString().replace(/\.0$/, '')}%`;

export function payoutLive() {
  return process.env.WAPAY_PAYOUT_ENABLED === 'true';
}

/** The card rail a pay link settles on today (Adumo only when enabled + configured). */
function liveCardRail() {
  return adumoEnabled() && primaryCardRail() === 'ADUMO' ? 'ADUMO' : 'PAYFAST';
}

/** Structured facts; every number comes from the charging function. */
export function feeSchedule({ withdrawLive = payoutLive() } = {}) {
  const dep = cardRailFee('PAYFAST');
  const depExamples = [2000, 10000, 50000].map((c) => ({ amountCents: c, feeCents: depositFeeCents(c), totalCents: c + depositFeeCents(c) }));
  const rail = liveCardRail();
  const link = cardRailFee(rail);
  const linkExample = { amountCents: 10000, feeCents: paymentRequestFeeCents(10000, rail), netCents: 10000 - paymentRequestFeeCents(10000, rail) };
  const loadDiscountBps = FEES.load.BLU?.discountBps ?? 600;
  return {
    deposit: { bps: dep.bps, fixedCents: dep.fixedCents, examples: depExamples },
    cashVoucher: { keptBps: loadDiscountBps, creditedPerHundred: 10000 - Math.round((10000 * loadDiscountBps) / 10000) },
    send: { wapayToWapayCents: 0, voucherGiftCents: FEES.voucherGift.flatFeeCents, ottSelfCents: 0 },
    request: { freeBelowCents: PAYREQ_FREE_BELOW_CENTS, bps: link.bps, fixedCents: link.fixedCents, rail, vat: vatRegistered(), example: linkExample },
    withdraw: withdrawLive
      ? { live: true, payshapCents: cashoutFeeCents('PAYSHAP', 10000), rtcCents: cashoutFeeCents('RTC', 10000), cashsend: [[70000, cashoutFeeCents('CASHSEND', 70000)], [150000, cashoutFeeCents('CASHSEND', 150000)], [Infinity, cashoutFeeCents('CASHSEND', 300000)]] }
      : { live: false },
  };
}

const TOPIC_WORDS = [
  ['withdraw', /\b(withdraw\w*|cash ?-?out|pay ?-?out|atm|to my bank|bank transfer|payshap|cash ?send)\b/i],
  ['voucher', /\b(blu|cash vouchers?|vouchers? at|at the till|till|cash deposits?|deposit(ing)? cash|with cash|in cash)\b/i],
  ['deposit', /\b(deposit\w*|depsit|add(ing)? money|load(ing)? money|top ?up|put money|card|eft|apple pay|google pay|online)\b/i],
  ['request', /\b(pay ?me|payment link|pay link|request(ing)? money|get paid|link)\b/i],
  ['ott', /\b(ott)\b/i],
  ['send', /\b(send\w*|transfer\w*|gift\w*|sending money)\b/i],
];
const FEE_WORDS = /\b(fee|fees|cost|costs|costing|charge|charges|charging|price of|pricing|rate|rates|how much (does|do|will|would|is it|it) (it |this |that |you |wapay |a |the )?(cost|charge|charging|to)|is it free|for free|free to|what does it cost)\b/i;
const PRODUCT_PRICE = /\b(airtime|data|bundle|bundles|electricity|units|kwh|vodacom|mtn|cell ?c|telkom|fuel|petrol|diesel)\b/i;
const NOT_A_FEE_ASK = /\b(balance|do i have|have i got|is in my (account|wallet)|pay request|voucher pin)\b/i;

/**
 * "How much does it cost to deposit money on here?" -> 'deposit'.
 * Returns a topic ('deposit' | 'voucher' | 'send' | 'request' | 'withdraw' |
 * 'ott' | 'general') or null when the message is not a fee question. Product
 * PRICE questions ("how much is 1GB") are not fee questions and return null.
 */
export function matchFeeAsk(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 200) return null;
  if (NOT_A_FEE_ASK.test(t)) return null;
  if (!FEE_WORDS.test(t)) return null;
  if (PRODUCT_PRICE.test(t) && !/\bfee/i.test(t)) return null;
  for (const [topic, re] of TOPIC_WORDS) if (re.test(t)) return topic;
  return 'general';
}

/** Optional rand amount inside a fee question ("cost to deposit R100"). */
export function feeAskAmountCents(text) {
  const m = String(text || '').match(/\bR\s?(\d{1,5})(?:[.,](\d{1,2}))?\b/i);
  if (!m) return null;
  const whole = Number(m[1]); const frac = m[2] ? Number((m[2] + '0').slice(0, 2)) : 0;
  const cents = whole * 100 + frac;
  return cents > 0 ? cents : null;
}

function depositLines(s, amountCents) {
  const ex = amountCents && amountCents >= 1000 && amountCents <= 300000
    ? [{ amountCents, feeCents: depositFeeCents(amountCents), totalCents: amountCents + depositFeeCents(amountCents) }]
    : s.deposit.examples;
  const examples = ex.map((e) => `${R(e.amountCents)} costs ${R(e.totalCents)}`).join(', ');
  return `💳 Adding money by card, Instant EFT, Apple Pay or Google Pay costs ${pct(s.deposit.bps)} + ${R(s.deposit.fixedCents)}, rounded up to the next rand, on top of the amount. So ${examples}, and the full amount lands in your balance.`;
}
function voucherLine(s) {
  return `💵 Adding cash with a Blu voucher at a till: the voucher network keeps ${pct(s.cashVoucher.keptBps)}, so a R100 voucher adds ${R(s.cashVoucher.creditedPerHundred)} to your balance. The till sometimes charges its own fee.`;
}
function sendLines(s) {
  return `💸 Sending money to another WaPay user from your balance is free. Sending a WaPay voucher to any SA number costs ${R(s.send.voucherGiftCents)} flat. Buying an OTT voucher for yourself is free.`;
}
function requestLines(s) {
  const above = `${pct(s.request.bps)} + ${R(s.request.fixedCents)}`;
  return `🙏 Please-pay-me links: the person paying never pays a fee. You pay nothing on requests under ${R(s.request.freeBelowCents)}; above that ${above} comes off what you receive (a ${R(s.request.example.amountCents)} request pays you ${R(s.request.example.netCents)}).`;
}
function withdrawLines(s) {
  if (!s.withdraw.live) return `🏧 Cash withdrawals are not available just yet, but they are coming soon, so there is no withdrawal fee to quote today.`;
  const cs = s.withdraw.cashsend;
  return `🏧 Withdrawals: ${R(s.withdraw.payshapCents)} to your bank account by PayShap in minutes, ${R(s.withdraw.rtcCents)} for a bank transfer, and cash at an Absa or Nedbank ATM, a Pick n Pay / Boxer till, or as an FNB eWallet for ${R(cs[0][1])} up to ${R(cs[0][0])}, ${R(cs[1][1])} up to ${R(cs[1][0])}, ${R(cs[2][1])} above that. Say "withdraw R200" to start.`;
}

/**
 * The deterministic answer to a fee question. `amountCents` (optional) makes
 * the deposit example exact for the amount the customer named.
 */
export function feeAnswer(topic = 'general', amountCents = null, { withdrawLive = payoutLive() } = {}) {
  const s = feeSchedule({ withdrawLive });
  switch (topic) {
    case 'deposit': return `${depositLines(s, amountCents)}\n\n${voucherLine(s)}\n\nSay "deposit R100" (any amount from R10) and I will send you a secure payment link. 😊`;
    case 'voucher': return `${voucherLine(s)}\n\n${depositLines(s, amountCents)}\n\nSend me the voucher code when you have it and I will load it straight away. 😊`;
    case 'send': return `${sendLines(s)}\n\nJust say "send R50 to 083…" or share a contact from your phone. 😊`;
    case 'ott': return `${sendLines(s)}\n\nSay "buy an OTT voucher" and I will sort it out from your balance. 😊`;
    case 'request': return `${requestLines(s)}\n\nSay "please pay me R150" and I will make you a link to share. 😊`;
    case 'withdraw': return `${withdrawLines(s)} 😊`;
    default:
      return `💰 *What WaPay costs*\n\n${depositLines(s, amountCents)}\n\n${voucherLine(s)}\n\n${sendLines(s)}\n\n${requestLines(s)}\n\n${withdrawLines(s)}\n\n📱 Airtime, data and electricity: no WaPay fee, you pay the product price.\n\nNo monthly fees, ever. 😊`;
  }
}

/** The FEES block for the AI's knowledge: the same facts, numbers included. */
export function feeFacts({ withdrawLive = payoutLive() } = {}) {
  const s = feeSchedule({ withdrawLive });
  return (
    `FEES YOU CAN QUOTE (exact, in rand, computed from the live fee tables; quote them plainly when asked what something costs; these numbers count as given to you):\n` +
    `- ${depositLines(s, null)}\n- ${voucherLine(s)}\n- ${sendLines(s)}\n- ${requestLines(s)}\n- ${withdrawLines(s)}\n- Airtime, data and electricity: no WaPay fee, the customer pays the product price. No monthly fees.`
  );
}
