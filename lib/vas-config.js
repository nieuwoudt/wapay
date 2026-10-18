/**
 * VAS and rail switches: what a customer may USE today, read at call time.
 *
 * Launch scope (founder, 2026-10-18, ad launch day): airtime, data,
 * electricity, cash top-ups with a Blu voucher, top-ups with an OTT voucher
 * and buying a WaPay (OTT) voucher for yourself are built and testable but
 * NOT active for customers. Every customer surface says "coming soon" (never
 * a date) until the matching switch is set in Vercel. "Send money" stays
 * live (founder, same day) and is not gated here; withdrawals are gated in
 * lib/payouts.js.
 *
 *   WAPAY_LAUNCH_HOLD (unset)       the master hold: everything below is off for everyone
 *   WAPAY_LAUNCH_HOLD=off           releases the hold; the per-key switches apply again
 *   VAS_LIVE_<KEY>=true             switches a key on for everyone
 *   VAS_ALLOWLIST_<KEY>=27...,27... narrows an ON key to named waIds (testers)
 *
 * Keys: AIRTIME, DATA, ELECTRICITY (prepaid, Blu); BLU_LOAD (cash top-up
 * with a Blu voucher PIN), OTT_LOAD (top-up with an OTT voucher PIN; also
 * needs OTT_MERCHANT_API_KEY), OTT_VOUCHER (buy a WaPay voucher for
 * yourself); LIFESTYLE, BILLPAY, REMITTANCE, GAMING (never launched);
 * FUEL follows WAPAY_WICODE_LIVE (docs/UNIFUEL_INTEGRATION.md).
 *
 * Everything here reads process.env when asked, never at import, so a flag
 * flip reaches a warm function without a cold start and a test process can
 * exercise both worlds (the old import-time map could not).
 */

/**
 * The master hold (founder, 2026-10-18 after testing from his own number, which sat
 * on two tester allowlists): while it holds, every switched product below is off
 * for EVERYONE, whatever the per-product switches and allowlists say, so the
 * shipped default is "coming soon" even where an older rollout left a switch on.
 * Unset = hold. WAPAY_LAUNCH_HOLD=off releases it and the per-product switches
 * and allowlists apply again.
 */
export function launchHold() {
  const raw = process.env.WAPAY_LAUNCH_HOLD;
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  return !/^(off|false|0|no|release|released|open)$/i.test(String(raw).trim());
}

function flag(name, dflt = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return dflt;
  return String(raw).trim().toLowerCase() === 'true';
}

/** LIVE toggles per VAS category. Getters: read at call time. */
export const VAS_LIVE = Object.freeze({
  get AIRTIME() { return !launchHold() && flag('VAS_LIVE_AIRTIME', false); },
  get DATA() { return !launchHold() && flag('VAS_LIVE_DATA', false); },
  get ELECTRICITY() { return !launchHold() && flag('VAS_LIVE_ELECTRICITY', false); },
  get LIFESTYLE() { return !launchHold() && flag('VAS_LIVE_LIFESTYLE', false); },
  get BILLPAY() { return !launchHold() && flag('VAS_LIVE_BILLPAY', false); },
  get REMITTANCE() { return !launchHold() && flag('VAS_LIVE_REMITTANCE', false); },
  get GAMING() { return !launchHold() && flag('VAS_LIVE_GAMING', false); },
  // Fuel (wiCode via UniFuel/Yoyo) is gated on the wiCode PRODUCTION flag:
  // Yoyo test vouchers do not work at pumps, so the customer-facing flow and
  // every real-redemption claim stay off until WAPAY_WICODE_LIVE=true
  // (see lib/spend-catalogue.js and docs/UNIFUEL_INTEGRATION.md).
  get FUEL() { return !launchHold() && process.env.WAPAY_WICODE_LIVE === 'true'; },
});

function categoryConfig(key, provider, displayName) {
  return Object.freeze({
    get enabled() { return !!VAS_LIVE[key]; },
    get comingSoon() { return !VAS_LIVE[key]; },
    provider,
    displayName,
  });
}

/**
 * VAS category status (derived from the LIVE flags at call time):
 * - enabled: live and purchasable
 * - comingSoon: advertised as not yet live
 * - provider: which provider handles this category
 */
export const VAS_CATEGORY_CONFIG = Object.freeze({
  AIRTIME: categoryConfig('AIRTIME', 'BLU', 'Mobile Airtime'),
  DATA: categoryConfig('DATA', 'BLU', 'Data Bundles'),
  ELECTRICITY: categoryConfig('ELECTRICITY', 'BLU', 'Prepaid Electricity'),
  LIFESTYLE: categoryConfig('LIFESTYLE', 'BLU', 'Entertainment Vouchers'),
  BILLPAY: categoryConfig('BILLPAY', 'BLU', 'Bill Payments (DStv)'),
  GAMING: categoryConfig('GAMING', 'BLU', 'Gaming Top-ups'),
  REMITTANCE: categoryConfig('REMITTANCE', 'BLU', 'Money Transfers'),
  FUEL: categoryConfig('FUEL', 'YOYO', 'Fuel Vouchers'),
});

/**
 * The cash-in and voucher rails, switched exactly like a VAS category
 * (VAS_LIVE_<KEY> / VAS_ALLOWLIST_<KEY>) but kept out of the product
 * category maps so a rail never renders as a product menu.
 */
export const RAILS = Object.freeze({
  BLU_LOAD: Object.freeze({ env: 'VAS_LIVE_BLU_LOAD', label: 'cash top-ups with a Blu voucher' }),
  OTT_LOAD: Object.freeze({ env: 'VAS_LIVE_OTT_LOAD', label: 'top-ups with an OTT voucher' }),
  OTT_VOUCHER: Object.freeze({ env: 'VAS_LIVE_OTT_VOUCHER', label: 'buying a WaPay (OTT) voucher for yourself' }),
});

/** VAS_ALLOWLIST_<KEY>: unset or empty = everyone; otherwise the named waIds only. */
export function allowlistPasses(key, waId) {
  const raw = process.env[`VAS_ALLOWLIST_${String(key || '').toUpperCase()}`];
  if (!raw) return true;
  const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true;
  return allowed.includes(String(waId || '').trim());
}

/** Is a VAS category enabled for purchase (for everyone, before any allowlist)? */
export function isCategoryEnabled(category) {
  const config = VAS_CATEGORY_CONFIG[String(category || '').toUpperCase()];
  return config?.enabled === true;
}

/**
 * The per-customer gate: the category switch narrowed by VAS_ALLOWLIST_<CATEGORY>.
 * Founder-only testing in prod = switch on + an allowlist of one number;
 * go-live for everyone = switch on, allowlist unset.
 */
export function isCategoryEnabledForWaId(category, waId) {
  if (!isCategoryEnabled(category)) return false;
  return allowlistPasses(category, waId);
}

/** Alias for the enabled check, to make intent gating explicit. */
export function isCategoryLive(category) {
  return isCategoryEnabled(category);
}

/** Is a rail switched on for everyone (before any allowlist)? */
export function isRailLive(rail) {
  const r = RAILS[String(rail || '').toUpperCase()];
  return r ? !launchHold() && flag(r.env, false) : false;
}

/** The per-customer rail gate: the switch narrowed by VAS_ALLOWLIST_<RAIL>. */
export function isRailLiveFor(rail, waId) {
  return isRailLive(rail) && allowlistPasses(rail, waId);
}

/** The OTT voucher load rail exists only with the merchant key configured. */
export function ottLoadConfigured() {
  return !!process.env.OTT_MERCHANT_API_KEY;
}

/**
 * Everything switched here, resolved for ONE customer. The object every
 * copy builder reads (how-it-works, fee facts, the spend catalogue, the
 * registry, the model's product truth) so the five surfaces cannot drift.
 */
export function launchScope(waId = null) {
  const airtime = isCategoryEnabledForWaId('AIRTIME', waId);
  const data = isCategoryEnabledForWaId('DATA', waId);
  const electricity = isCategoryEnabledForWaId('ELECTRICITY', waId);
  return Object.freeze({
    airtime,
    data,
    electricity,
    anyVas: airtime || data || electricity,
    allVas: airtime && data && electricity,
    bluLoad: isRailLiveFor('BLU_LOAD', waId),
    ottLoad: isRailLiveFor('OTT_LOAD', waId) && ottLoadConfigured(),
    voucher: isRailLiveFor('OTT_VOUCHER', waId),
  });
}

/** "a, b and c" */
export function joinAnd(items) {
  const list = (items || []).filter(Boolean);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** The prepaid products that are live (or, with live:false, not live) in a scope: "airtime, data and electricity". */
export function prepaidNames(scope, { live = true, and = true } = {}) {
  const s = scope || launchScope(null);
  const names = [['airtime', s.airtime], ['data', s.data], ['electricity', s.electricity]]
    .filter(([, on]) => !!on === live)
    .map(([n]) => n);
  return and ? joinAnd(names) : names.join(', ');
}

/** What is coming soon in this scope, in customer words, never a date. */
/** No card product exists yet; the home card names it as coming soon (founder, 2026-10-18). */
export const VIRTUAL_CARD_LIVE = false;

export function comingSoonPhrases(scope, { wicodeLive = VAS_LIVE.FUEL } = {}) {
  const s = scope || launchScope(null);
  const out = [];
  const off = prepaidNames(s, { live: false, and: false });
  if (off) out.push(off);
  if (!wicodeLive) out.push('fuel vouchers');
  if (!s.bluLoad && !s.ottLoad) out.push('cash deposits with a Blu or OTT voucher');
  else if (!s.bluLoad) out.push('cash deposits with a Blu voucher');
  else if (!s.ottLoad) out.push('top-ups with an OTT voucher');
  if (!VIRTUAL_CARD_LIVE) out.push('a virtual card');
  return out;
}

/**
 * "Right now you can ..." for one customer: only what the gates allow.
 * withdrawLive is the caller's payout gate (lib/payouts.js payoutAllowedFor);
 * the env default is the global switch.
 */
export function worksTodaySentence({ scope = null, withdrawLive = process.env.WAPAY_PAYOUT_ENABLED === 'true', wicodeLive = VAS_LIVE.FUEL } = {}) {
  const s = scope || launchScope(null);
  const parts = [`get paid with a "please pay me" link`, `add money by card or Instant EFT`];
  if (s.bluLoad) parts.push('add cash with a Blu voucher from any till');
  parts.push('send money to any SA number');
  const on = prepaidNames(s, { live: true });
  if (on) parts.push(`buy ${on}`);
  if (wicodeLive) parts.push('buy fuel vouchers');
  if (withdrawLive) parts.push('withdraw to your bank or as cash at an ATM');
  return `Right now you can ${joinAnd(parts)}.`;
}

/**
 * The one coming-soon reply shape: what was asked for, the promise to tell
 * them (no date), then what works today.
 */
export function comingSoonReply(subject, { plural = false, emoji = '🔜', ...rest } = {}) {
  return `${emoji} ${subject} ${plural ? 'are' : 'is'} coming soon on WaPay. I will tell you the moment ${plural ? 'they are' : 'it is'} live.\n\n${worksTodaySentence(rest)}`;
}

/** Is a VAS category marked coming soon? */
export function isCategoryComingSoon(category) {
  const config = VAS_CATEGORY_CONFIG[String(category || '').toUpperCase()];
  return config?.comingSoon === true;
}

/** Human-readable name for a category. */
export function getCategoryDisplayName(category) {
  const config = VAS_CATEGORY_CONFIG[String(category || '').toUpperCase()];
  return config?.displayName || category;
}

/** All enabled categories. */
export function getEnabledCategories() {
  return Object.keys(VAS_CATEGORY_CONFIG).filter((cat) => VAS_CATEGORY_CONFIG[cat].enabled === true);
}

/** Categories that are live today. */
export function getLiveCategories() {
  return Object.keys(VAS_LIVE).filter((cat) => VAS_LIVE[cat]);
}

/** All categories (for listing). */
export function getAllCategories() {
  return Object.entries(VAS_CATEGORY_CONFIG).map(([name, config]) => ({
    name,
    enabled: config.enabled,
    comingSoon: config.comingSoon,
    provider: config.provider,
    displayName: config.displayName,
  }));
}
