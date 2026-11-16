/**
 * The capability registry: the ONE list of what WaPay can do for a customer,
 * and the per-customer gate for each item, that every customer-facing surface
 * renders from (the home screen, the Help Menu, the onboarding product list
 * and the model prompt). Agent recon 2026-09-13: the truth about what is live
 * was duplicated in six places and each drifted on its own; v1.4 handover:
 * build the agent from a registry, not from more regex.
 *
 * Rules kept here (do not weaken):
 * - Every gate is the SAME helper the flow itself uses (lib/vas-config.js,
 *   lib/payouts.js, lib/business-auth.js), so nothing is advertised to a
 *   customer the flow will refuse (payout pilot gate discipline).
 * - Every fee line is built from feeSchedule(), the same functions that charge
 *   the fee, so the bot can never quote a number the ledger does not charge.
 * - Every limit is the constant the flow validates against.
 * - Customer copy: English (the processor localizes), no em dashes, never a
 *   betting word, never a date promise, never the payout partner's name.
 * - This module describes; it never executes. Nothing here touches the
 *   ledger, a provider or a database.
 */
import { isCategoryEnabledForWaId, isRailLiveFor, launchScope, worksTodaySentence, comingSoonPhrases, joinAnd } from './vas-config.js';
import { payoutAllowedFor, MIN_PAYOUT_CENTS, MAX_PAYOUT_CENTS } from './payouts.js';
import { mayRegister } from './business-auth.js';
import { feeSchedule } from './fee-facts.js';
import { TOPICS, VAS_LIMITS } from './how-it-works.js';
import { isWicodeLive, advertisedFuelPartners } from './spend-catalogue.js';
import { MIN_DEPOSIT_CENTS, MAX_DEPOSIT_CENTS } from './deposits.js';
import { MIN_REQUEST_CENTS, MAX_REQUEST_CENTS } from './payment-requests.js';
import { pinOnDemandFor } from './onboarding-flags.js';

const R = (cents) => (cents % 100 === 0 ? `R${cents / 100}` : `R${(cents / 100).toFixed(2)}`);
const pct = (bps) => `${(bps / 100).toString().replace(/\.0$/, '')}%`;

/**
 * Fuel liveness for ONE customer: the wiCode PRODUCTION flag
 * (WAPAY_WICODE_LIVE, read at call time like lib/spend-catalogue.js) narrowed
 * by the optional VAS_ALLOWLIST_FUEL pilot list, the same shape as the
 * processor's private fuelLiveFor and lib/vas-config.js's allowlist idiom.
 * Founder-only live testing in prod = flag true + allowlist of one number;
 * full go-live = flag true, allowlist unset.
 */
export function fuelLiveFor(waId) {
  if (!isWicodeLive()) return false;
  return allowlistPasses('FUEL', waId);
}

/** VAS_ALLOWLIST_<CATEGORY>: unset or empty = everyone; otherwise named waIds only. */
function allowlistPasses(category, waId) {
  const raw = process.env[`VAS_ALLOWLIST_${String(category || '').toUpperCase()}`];
  if (!raw) return true;
  const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true;
  return allowed.includes(String(waId || '').trim());
}

/**
 * The OTT voucher load rail (the second cash-in rail, tried when Blu does not
 * recognise a PIN) exists only when the merchant key is configured; the
 * processor's attemptOttRedemption returns false without it.
 */
function ottLoadConfigured() {
  return !!process.env.OTT_MERCHANT_API_KEY;
}

/** Fuel bounds, mirrored from pages/api/vas/fuel/preview.js (env-overridable). */
function fuelLimits() {
  return {
    minCents: Number(process.env.WAPAY_FUEL_MIN_CENTS) || 5000,
    maxCents: Number(process.env.WAPAY_FUEL_MAX_CENTS) || 50000,
  };
}

const NO_PRODUCT_FEE = () => `No WaPay fee, you pay the product price.`;

/** The PIN while the deferred PIN covers the customer (WAPAY_PIN_ON_DEMAND, docs/ONBOARDING.md §5). */
export const PIN_ON_DEMAND_ONE_LINER = 'Your WaPay PIN is set when you first pay out or send money, never at sign-up: you choose it right then, or now by saying "PIN". Forgot it later? A code comes to this WhatsApp number, then you type the new PIN twice.';
export const PIN_ON_DEMAND_HELP_LINE = `🔐 *PIN* - set when you first pay out or send; "PIN" to set it now, "forgot PIN" for a new one`;
const POLICY_OPEN = { minKycTier: 0, consents: [], adviceClass: 'none' };

/**
 * CAPABILITIES, in display order. Each descriptor:
 *   id, label, emoji, oneLiner (customer voice), startCommand (the exact
 *   words that start it), example, liveFor({ waId, account }) -> boolean,
 *   comingSoonLine (advertised while off) or null, feeLine() -> string from
 *   feeSchedule(), limits { minCents, maxCents } or null, policy, topicId
 *   (lib/how-it-works.js TOPICS key or null), helpLine (the Help Menu line),
 *   helpAlways (the help line stays even when liveFor is false: BUSINESS,
 *   because the command answers everyone, with a waitlist for the uninvited).
 */
export const CAPABILITIES = [
  {
    id: 'BALANCE',
    label: 'Balance',
    emoji: '💰',
    oneLiner: 'See what you have, the vouchers you bought and your recent transactions.',
    startCommand: 'balance',
    example: 'balance',
    liveFor: () => true,
    comingSoonLine: null,
    feeLine: () => `Free.`,
    limits: null,
    policy: POLICY_OPEN,
    topicId: 'balance',
    helpLine: `💰 *Balance* - "What's my balance?"`,
  },
  {
    id: 'AIRTIME',
    label: 'Airtime',
    emoji: '📱',
    oneLiner: 'Buy airtime for your number or any other SA number, paid from your balance.',
    startCommand: 'buy airtime',
    example: 'buy R50 airtime',
    liveFor: ({ waId } = {}) => isCategoryEnabledForWaId('AIRTIME', waId),
    comingSoonLine: null,
    feeLine: NO_PRODUCT_FEE,
    limits: { minCents: VAS_LIMITS.AIRTIME[0], maxCents: VAS_LIMITS.AIRTIME[1] },
    policy: POLICY_OPEN,
    topicId: 'airtime',
    helpLine: `📱 *Airtime* - "Buy R50 airtime"`,
  },
  {
    id: 'DATA',
    label: 'Data',
    emoji: '📶',
    oneLiner: 'Buy a data bundle for any SA number on any network.',
    startCommand: 'buy data',
    example: 'show MTN bundles',
    liveFor: ({ waId } = {}) => isCategoryEnabledForWaId('DATA', waId),
    comingSoonLine: null,
    feeLine: NO_PRODUCT_FEE,
    limits: null,
    policy: POLICY_OPEN,
    topicId: 'data',
    helpLine: `📶 *Data* - "Buy 1GB data"`,
  },
  {
    id: 'ELECTRICITY',
    label: 'Electricity',
    emoji: '💡',
    oneLiner: 'Buy prepaid electricity for any meter and get the token right here.',
    startCommand: 'buy electricity',
    example: 'buy R100 electricity',
    liveFor: ({ waId } = {}) => isCategoryEnabledForWaId('ELECTRICITY', waId),
    comingSoonLine: null,
    feeLine: NO_PRODUCT_FEE,
    limits: { minCents: VAS_LIMITS.ELECTRICITY[0], maxCents: VAS_LIMITS.ELECTRICITY[1] },
    policy: POLICY_OPEN,
    topicId: 'electricity',
    helpLine: `💡 *Electricity* - "Buy R100 electricity"`,
  },
  {
    id: 'SEND',
    label: 'Send money',
    emoji: '💸',
    oneLiner: 'Send money to any SA number from your balance, free: it lands in their WaPay balance, straight away if they use WaPay or when they join.',
    startCommand: 'send money',
    example: 'send R50 to 083 123 4567',
    liveFor: () => true,
    comingSoonLine: null,
    // A send moves balance to balance, never a voucher (founder 2026-10-18, BUGLOG #117).
    feeLine: () => 'Free, to anyone. If they never join, it comes back to you after 30 days.',
    // Voucher gift bounds (pages/api/vas/voucher/preview.js); wallet-to-wallet sends share them.
    limits: { minCents: VAS_LIMITS.VOUCHER[0], maxCents: VAS_LIMITS.VOUCHER[1] },
    policy: POLICY_OPEN,
    topicId: 'send',
    helpLine: `💸 *Send money* - "Send R50 to 083...", or just share a contact from your phone`,
  },
  {
    id: 'OTT_SELF',
    label: 'OTT voucher',
    emoji: '🎟️',
    oneLiner: 'Buy a WaPay (OTT) voucher for yourself from your balance and get the PIN in this chat.',
    startCommand: 'buy an OTT voucher',
    example: 'buy an OTT voucher for R100',
    liveFor: ({ waId } = {}) => isRailLiveFor('OTT_VOUCHER', waId),
    comingSoonLine: null,
    feeLine: () => `Free, paid from your balance.`,
    limits: { minCents: VAS_LIMITS.VOUCHER[0], maxCents: VAS_LIMITS.VOUCHER[1] },
    policy: POLICY_OPEN,
    topicId: 'ott',
    helpLine: null,
  },
  {
    id: 'REQUEST_MONEY',
    label: 'Get paid',
    emoji: '🙏',
    oneLiner: 'Make a please-pay-me link that says what it is for and share it anywhere; the money lands in your balance when they pay. "my links" lists the open links, with a reminder to forward and a way to cancel each.',
    startCommand: 'please pay me',
    example: 'please pay me R150 for braids',
    liveFor: () => true,
    comingSoonLine: null,
    feeLine: () => {
      const s = feeSchedule();
      return `The person paying never pays a fee. Free on requests under ${R(s.request.freeBelowCents)}; above that ${pct(s.request.bps)} + ${R(s.request.fixedCents)} comes off what you receive.`;
    },
    limits: { minCents: MIN_REQUEST_CENTS, maxCents: MAX_REQUEST_CENTS },
    policy: POLICY_OPEN,
    topicId: 'request',
    helpLine: `🙏 *Get paid* - "please pay me R150 for braids", then forward the link. "my links" to track them`,
  },
  {
    id: 'DEPOSIT_CARD',
    label: 'Deposit',
    emoji: '💳',
    oneLiner: 'Add money by card, Instant EFT, Apple Pay or Google Pay with a secure payment link.',
    startCommand: 'deposit',
    example: 'deposit R100',
    liveFor: () => true,
    comingSoonLine: null,
    feeLine: () => {
      const s = feeSchedule();
      return `${pct(s.deposit.bps)} + ${R(s.deposit.fixedCents)} on top of the amount, rounded up to the next rand; the full amount lands in your balance.`;
    },
    limits: { minCents: MIN_DEPOSIT_CENTS, maxCents: MAX_DEPOSIT_CENTS },
    policy: POLICY_OPEN,
    topicId: 'deposit',
    helpLine: `💳 *Deposit* - "Deposit R100"`,
  },
  {
    id: 'DEPOSIT_VOUCHER',
    label: 'Cash voucher',
    emoji: '💵',
    oneLiner: 'Add cash: buy a Blu voucher at any till and send me the PIN to load it.',
    startCommand: 'redeem voucher',
    example: 'redeem voucher',
    liveFor: ({ waId } = {}) => isRailLiveFor('BLU_LOAD', waId),
    comingSoonLine: null,
    feeLine: () => {
      const s = feeSchedule();
      return `The voucher network keeps ${pct(s.cashVoucher.keptBps)}, so a R100 voucher adds ${R(s.cashVoucher.creditedPerHundred)} to your balance.`;
    },
    limits: null,
    policy: POLICY_OPEN,
    topicId: 'deposit',
    helpLine: `🎟️ *Voucher* - "Redeem voucher"`,
  },
  {
    id: 'VOUCHER_LOAD',
    label: 'OTT voucher load',
    emoji: '🎟️',
    oneLiner: 'Have an OTT voucher? Send me the PIN and I load its value into your balance.',
    startCommand: 'redeem voucher',
    example: 'redeem voucher',
    liveFor: ({ waId } = {}) => ottLoadConfigured() && isRailLiveFor('OTT_LOAD', waId),
    comingSoonLine: null,
    feeLine: () => {
      const s = feeSchedule();
      return `The voucher network keeps ${pct(s.cashVoucher.keptBps)}, so a R100 voucher adds ${R(s.cashVoucher.creditedPerHundred)} to your balance.`;
    },
    limits: null,
    policy: POLICY_OPEN,
    topicId: 'deposit',
    helpLine: null,
  },
  {
    id: 'WITHDRAW',
    label: 'Withdraw',
    emoji: '🏧',
    oneLiner: 'Take money out to your own bank account, or as cash at an ATM with no bank account needed.',
    startCommand: 'withdraw',
    example: 'withdraw R200',
    liveFor: ({ waId } = {}) => payoutAllowedFor(waId),
    comingSoonLine: `🏧 *Withdraw*: coming soon`,
    feeLine: () => {
      const s = feeSchedule();
      if (!s.withdraw.live) return `Not available just yet, so there is no withdrawal fee to quote today.`;
      const cs = s.withdraw.cashsend;
      return `${R(s.withdraw.payshapCents)} by PayShap to your bank, ${R(s.withdraw.rtcCents)} for a bank transfer, cash ${R(cs[0][1])} up to ${R(cs[0][0])}, ${R(cs[1][1])} up to ${R(cs[1][0])}, ${R(cs[2][1])} above that.`;
    },
    limits: { minCents: MIN_PAYOUT_CENTS, maxCents: MAX_PAYOUT_CENTS },
    policy: { minKycTier: 1, consents: [], adviceClass: 'none' },
    topicId: 'withdraw',
    helpLine: `🏧 *Withdraw* - "withdraw R200" to your bank or as cash at an ATM`,
  },
  {
    id: 'FUEL',
    label: 'Fuel',
    emoji: '⛽',
    oneLiner: 'Buy a UniFuel fuel voucher from your balance and use it at participating stations.',
    startCommand: 'buy fuel',
    example: 'buy fuel',
    liveFor: ({ waId } = {}) => fuelLiveFor(waId),
    comingSoonLine: `⛽ *Fuel vouchers*: coming soon`,
    feeLine: () => `No WaPay fee, you pay the voucher value.`,
    get limits() { return fuelLimits(); },
    policy: POLICY_OPEN,
    topicId: 'fuel',
    helpLine: `⛽ *Fuel* - "buy fuel"`,
  },
  {
    id: 'BUSINESS',
    label: 'Business',
    emoji: '🏪',
    oneLiner: 'Open a WaPay for Business account to get paid by your customers with links and QR codes.',
    startCommand: 'business account',
    example: 'business account',
    liveFor: ({ waId, account } = {}) => mayRegister(waId || account?.msisdn),
    comingSoonLine: null,
    feeLine: () => {
      const s = feeSchedule();
      return `Free to open. Please-pay-me links are free under ${R(s.request.freeBelowCents)}; above that ${pct(s.request.bps)} + ${R(s.request.fixedCents)} comes off what you receive.`;
    },
    limits: null,
    policy: POLICY_OPEN,
    topicId: 'business',
    helpLine: `🏪 *Business* - "business account" to get paid by your customers`,
    helpAlways: true,
  },
  {
    // Referrals (docs/REFERRALS.md, 2026-10-20): one forwardable message with the member's own
    // link, only when they ask for it. Rewards are tracked; an amount is promised only while
    // WAPAY_REFERRAL_REWARD_CENTS is on, and never here.
    id: 'INVITE',
    label: 'Invite a friend',
    emoji: '🤝',
    oneLiner: 'Get your own WaPay invite to forward to friends; we count who joins through it.',
    startCommand: 'invite',
    example: 'invite a friend',
    liveFor: () => true,
    comingSoonLine: null,
    feeLine: () => `Free.`,
    limits: null,
    policy: POLICY_OPEN,
    topicId: null,
    helpLine: `🤝 *Invite a friend* - "invite" for your link to share`,
  },
  {
    // Founder 2026-10-14 (Lisa stuck after one wrong PIN): the reset is a real command, so the
    // model names this one and never invents another ("type reset PIN" looped four times).
    id: 'PIN_RESET',
    label: 'Forgot PIN',
    emoji: '🔐',
    oneLiner: 'Set a new WaPay PIN if you forgot it, it is locked, or you want to change it: a code comes to this WhatsApp number, then you type the new PIN twice. Whatever was waiting for the PIN carries on after.',
    startCommand: 'forgot PIN',
    example: 'I forgot my PIN',
    liveFor: () => true,
    comingSoonLine: null,
    feeLine: () => `Free.`,
    limits: null,
    policy: POLICY_OPEN,
    topicId: null,
    helpLine: `🔐 *Forgot PIN* - "forgot PIN" to set a new one`,
    // The deferred PIN (WAPAY_PIN_ON_DEMAND, 2026-10-22): while the switch covers the customer the PIN
    // is described as set on the first pay-out or send, never as a sign-up step. Off: the lines above.
    oneLinerFor: (ctx = {}) => (pinOnDemandFor({ waId: ctx.waId || null, account: ctx.account || null }) ? PIN_ON_DEMAND_ONE_LINER : null),
    helpLineFor: (ctx = {}) => (pinOnDemandFor({ waId: ctx.waId || null, account: ctx.account || null }) ? PIN_ON_DEMAND_HELP_LINE : null),
  },
];

const BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

export function capabilityById(id) {
  return BY_ID.get(String(id || '').toUpperCase()) || null;
}

export function isCapabilityLiveFor(id, ctx = {}) {
  const c = capabilityById(id);
  if (!c) return false;
  try { return !!c.liveFor(ctx); } catch { return false; }
}

/** Live descriptors for this customer, in display order. */
export function capabilitiesFor(ctx = {}) {
  return CAPABILITIES.filter((c) => isCapabilityLiveFor(c.id, ctx));
}

/**
 * The product lines of the home screen (renderHome in the processor), in
 * its order and with its emoji; withdraw and fuel carry their coming-soon
 * line while off. Join with '\n' to splice into the home message.
 */
export function homeLines(ctx = {}) {
  const live = (id) => isCapabilityLiveFor(id, ctx);
  const buy = ['AIRTIME', 'DATA', 'ELECTRICITY'].filter(live).map((id) => capabilityById(id).label.toLowerCase());
  const lines = [];
  // Launch scope (2026-10-18): live products get their line; everything that is off is
  // named once in a coming-soon line, cash deposits and the virtual card included (founder).
  if (buy.length) lines.push(`🛒 *Buy*: ${buy.join(', ')}`);
  lines.push(`💸 *Send*: "send R50 to 083..."`);
  lines.push(`🙏 *Get Paid*: "please pay me R150 for braids" → forward your link · "my links" to track them`);
  lines.push(live('DEPOSIT_VOUCHER') ? `💳 *Deposit*: "deposit R100" or a Blu voucher` : `💳 *Deposit*: "deposit R100" by card or Instant EFT`);
  if (live('FUEL')) lines.push(`⛽ *Fuel*: "buy fuel" for participating stations`);
  lines.push(live('WITHDRAW') ? `🏧 *Withdraw*: "withdraw R200" to your bank, or cash at an ATM` : capabilityById('WITHDRAW').comingSoonLine);
  const soon = comingSoonPhrases(launchScope(ctx.waId || ctx.account?.waId || null), { wicodeLive: live('FUEL') });
  if (soon.length) lines.push(`🔜 *Coming soon*: ${joinAnd(soon)}`);
  // Referrals (docs/REFERRALS.md, 2026-10-20): the invite is asked for, never pushed; the home card only names the word.
  lines.push(`🤝 *Invite*: "invite" to share WaPay with a friend`);
  // The web portal (2026-10-22, founder): the same account in a browser, named on every home card.
  lines.push(`🌐 *Web*: app.wapay.co.za - WaPay in your browser`);
  lines.push(`📄 *Transactions* · ⚙️ *Settings*`);
  return lines;
}

/** The Help Menu lines (the processor's "help" reply), one per advertised capability. */
export function helpLines(ctx = {}) {
  return CAPABILITIES
    .filter((c) => c.helpLine && (c.helpAlways || isCapabilityLiveFor(c.id, ctx)))
    .map((c) => (typeof c.helpLineFor === 'function' && c.helpLineFor(ctx)) || c.helpLine);
}

/** One line per live capability for the model prompt. Off capabilities are never named. */
export function promptLines(ctx = {}) {
  const lines = capabilitiesFor(ctx).map((c) => `- ${c.label}: ${(typeof c.oneLinerFor === 'function' && c.oneLinerFor(ctx)) || c.oneLiner} Start: "${c.startCommand}". ${c.feeLine()}`);
  // Launch scope (2026-10-18): the model is told what is coming soon in the same list, so it
  // never offers or starts it (the Pay agent improvised an airtime offer on launch day).
  const soon = comingSoonPhrases(launchScope(ctx.waId || ctx.account?.waId || null), { wicodeLive: isCapabilityLiveFor('FUEL', ctx) });
  if (soon.length) lines.push(`- Coming soon, not available today (never offer, start or explain these; say coming soon, then what works): ${joinAnd(soon)}.`);
  return lines;
}

/**
 * A short product list for the fallback reply: what EVERY customer can do
 * today. A switch that is on but narrowed to an allowlist is not "everyone",
 * so it stays out; what is off is named once as coming soon.
 */
export function welcomeLines() {
  const everyone = (id) => isCapabilityLiveFor(id, {});
  const lines = [];
  const buy = [['AIRTIME', 'airtime'], ['DATA', 'data'], ['ELECTRICITY', 'prepaid electricity']].filter(([id]) => everyone(id)).map(([, n]) => n);
  if (buy.length) lines.push(`📱 Buy ${joinAnd(buy)}`);
  lines.push(`💸 Send money to friends and family on WhatsApp`);
  lines.push(`🙏 Get paid with a "please pay me" link`);
  lines.push(everyone('DEPOSIT_VOUCHER') ? `💳 Add money by card or with a Blu voucher from any till` : `💳 Add money by card or Instant EFT`);
  lines.push(`💰 See your balance and transactions any time`);
  const withdrawEveryone = isCapabilityLiveFor('WITHDRAW', {}) && !process.env.WAPAY_PAYOUT_ALLOWLIST;
  const fuelEveryone = isCapabilityLiveFor('FUEL', {}) && !process.env.VAS_ALLOWLIST_FUEL;
  if (withdrawEveryone) lines.push(`🏧 Withdraw to your bank or as cash at an ATM`);
  if (fuelEveryone) {
    const partners = advertisedFuelPartners().map((p) => p.name).join(' and ');
    lines.push(`⛽ Buy fuel vouchers for participating ${partners} stations`);
  }
  const soon = comingSoonPhrases(launchScope(null), { wicodeLive: fuelEveryone });
  if (soon.length) lines.push(`🔜 Coming soon: ${joinAnd(soon)}`);
  return lines;
}

/** The launch scope for one customer plus the two gates this registry owns (withdraw, fuel). */
export function launchScopeFor(ctx = {}) {
  const waId = ctx.waId || ctx.account?.waId || null;
  return { ...launchScope(waId), withdrawLive: payoutAllowedFor(waId), wicodeLive: fuelLiveFor(waId) };
}

/** "Right now you can ..." for one customer, from the same gates every surface uses. */
export function worksToday(ctx = {}) {
  const s = launchScopeFor(ctx);
  return worksTodaySentence({ scope: s, withdrawLive: s.withdrawLive, wicodeLive: s.wicodeLive });
}
