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
import { payoutRules } from './payout-rules.js';
import { expressRules } from './payout-express.js';
import { primaryCardRail, adumoEnabled } from './adumo.js';
import { launchScope, prepaidNames } from './vas-config.js';

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
    // A send moves balance to balance, to anyone, free (founder 2026-10-18, BUGLOG #117).
    send: { toAnyoneCents: 0, ottSelfCents: 0 },
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
// Launch scope (2026-10-18, lib/vas-config.js): a fee is quoted only for what the customer can use today.
function voucherLine(s, scope = launchScope(null)) {
  if (!scope.bluLoad) return `💵 Cash top-ups with a Blu voucher at a till are coming soon, so there is no cash top-up fee to quote today.`;
  return `💵 Adding cash with a Blu voucher at a till: the voucher network keeps ${pct(s.cashVoucher.keptBps)}, so a R100 voucher adds ${R(s.cashVoucher.creditedPerHundred)} to your balance. The till sometimes charges its own fee.`;
}
function sendLines(s, scope = launchScope(null)) {
  return `💸 Sending money from your balance is free, to any SA number: it lands in their WaPay balance, straight away if they use WaPay or when they join (if they never do, it comes back to you after 30 days). ${scope.voucher ? 'Buying an OTT voucher for yourself is free.' : 'Buying an OTT voucher for yourself is coming soon.'}`;
}
function prepaidLine(scope = launchScope(null), { forModel = false } = {}) {
  const on = prepaidNames(scope, { live: true });
  const off = prepaidNames(scope, { live: false });
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const payer = forModel ? 'the customer pays' : 'you pay';
  if (!on) return `📱 Airtime, data and electricity are coming soon, so there is no product fee to quote today.`;
  return `📱 ${cap(on)}: no WaPay fee, ${payer} the product price.${off ? ` ${cap(off)} ${/ and /.test(off) ? 'are' : 'is'} coming soon.` : ''}`;
}
function requestLines(s) {
  const above = `${pct(s.request.bps)} + ${R(s.request.fixedCents)}`;
  return `🙏 Please-pay-me links: the person paying never pays a fee. You pay nothing on requests under ${R(s.request.freeBelowCents)}; above that ${above} comes off what you receive (a ${R(s.request.example.amountCents)} request pays you ${R(s.request.example.netCents)}).`;
}
/**
 * The withdrawal rules in one sentence, from the same settings the money path reads (founder 2026-10-24):
 * the double fee on money under two hours old, the cap in any 24 hours, the ID check above its threshold.
 */
export function withdrawRulesLine(env = process.env) {
  const r = payoutRules(env);
  const x = expressRules(env);
  const hours = Math.round(x.windowMs / 3600000);
  const parts = [];
  if (x.multiplier > 1 && x.windowMs > 0) parts.push(`Money that reached your balance less than ${hours} hour${hours === 1 ? '' : 's'} ago costs ${x.multiplier === 2 ? 'double' : `${x.multiplier} times`} the fee to withdraw.`);
  parts.push(`You can withdraw up to ${R(r.dailyCapCents)} in any 24 hours${r.kycMode === 'threshold' ? `, and more than ${R(r.kycDailyCents)} in 24 hours needs a once-off ID check` : ''}.`);
  return parts.join(' ');
}

function withdrawLines(s) {
  if (!s.withdraw.live) return `🏧 Cash withdrawals are not available just yet, but they are coming soon, so there is no withdrawal fee to quote today.`;
  const cs = s.withdraw.cashsend;
  return `🏧 Withdrawals: ${R(s.withdraw.payshapCents)} to your bank account by PayShap, ${R(s.withdraw.rtcCents)} for a bank transfer, and cash at an Absa or Nedbank ATM or a Pick n Pay / Boxer till for ${R(cs[0][1])} up to ${R(cs[0][0])}, ${R(cs[1][1])} up to ${R(cs[1][0])}, ${R(cs[2][1])} above that. ${withdrawRulesLine()} Say "withdraw R200" to start.`;
}

/**
 * The deterministic answer to a fee question. `amountCents` (optional) makes
 * the deposit example exact for the amount the customer named.
 */
export function feeAnswer(topic = 'general', amountCents = null, { withdrawLive = payoutLive(), scope = launchScope(null) } = {}) {
  const s = feeSchedule({ withdrawLive });
  switch (topic) {
    case 'deposit': return `${depositLines(s, amountCents)}\n\n${voucherLine(s, scope)}\n\nSay "deposit R100" (any amount from R10) and I will send you a secure payment link. 😊`;
    case 'voucher': return scope.bluLoad
      ? `${voucherLine(s, scope)}\n\n${depositLines(s, amountCents)}\n\nSend me the voucher code when you have it and I will load it straight away. 😊`
      : `${voucherLine(s, scope)}\n\n${depositLines(s, amountCents)}\n\nSay "deposit R100" (any amount from R10) and I will send you a secure payment link. 😊`;
    case 'send': return `${sendLines(s, scope)}\n\nJust say "send R50 to 083…" or share a contact from your phone. 😊`;
    case 'ott': return scope.voucher
      ? `${sendLines(s, scope)}\n\nSay "buy an OTT voucher" and I will sort it out from your balance. 😊`
      : `${sendLines(s, scope)} 😊`;
    case 'request': return `${requestLines(s)}\n\nSay "please pay me R150" and I will make you a link to share. 😊`;
    case 'withdraw': return `${withdrawLines(s)} 😊`;
    default:
      return `💰 *What WaPay costs*\n\n${depositLines(s, amountCents)}\n\n${voucherLine(s, scope)}\n\n${sendLines(s, scope)}\n\n${requestLines(s)}\n\n${withdrawLines(s)}\n\n${prepaidLine(scope)}\n\nNo monthly fees, ever. 😊`;
  }
}

/** The FEES block for the AI's knowledge: the same facts, numbers included. */
export function feeFacts({ withdrawLive = payoutLive(), scope = launchScope(null) } = {}) {
  const s = feeSchedule({ withdrawLive });
  return (
    `FEES YOU CAN QUOTE (exact, in rand, computed from the live fee tables; quote them plainly when asked what something costs; these numbers count as given to you):\n` +
    `- ${depositLines(s, null)}\n- ${voucherLine(s, scope)}\n- ${sendLines(s, scope)}\n- ${requestLines(s)}\n- ${withdrawLines(s)}\n- ${prepaidLine(scope, { forModel: true }).replace(/^📱 /, '')} No monthly fees.`
  );
}
