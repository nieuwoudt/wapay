/**
 * Launch scope (2026-10-18, the ad launch day). The founder: airtime, data,
 * electricity, cash top-ups with Blu and OTT vouchers and buying an OTT
 * voucher for yourself are built and testable but NOT active for customers;
 * every surface says "coming soon" (never a date) until the matching switch
 * is set. "Send money" stays live. Withdrawals, card deposits and pay links
 * are untouched. lib/vas-config.js is the one place every gate reads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  VAS_LIVE, VAS_CATEGORY_CONFIG, RAILS, isCategoryLive, isCategoryEnabledForWaId, isRailLive, isRailLiveFor,
  launchScope, comingSoonPhrases, worksTodaySentence, comingSoonReply, prepaidNames, joinAnd, getLiveCategories,
} from '../lib/vas-config.js';
import { homeLines, helpLines, welcomeLines, promptLines, worksToday, launchScopeFor, isCapabilityLiveFor } from '../lib/capabilities.js';
import { CAN_DO } from '../lib/ad-flow.js';
import { scopeFromEnv } from '@wapay/ai';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const processor = read('../pages/api/webhooks/message-processor-v2.js');
const orchestrator = read('../packages/ai/src/orchestrator.ts');
const vasConfigSrc = read('../lib/vas-config.js');

const PILOT = '27787051175';
const OTHER = '27780000002';
const SWITCHES = ['VAS_LIVE_AIRTIME', 'VAS_LIVE_DATA', 'VAS_LIVE_ELECTRICITY', 'VAS_LIVE_BLU_LOAD', 'VAS_LIVE_OTT_LOAD', 'VAS_LIVE_OTT_VOUCHER'];
const LISTS = ['VAS_ALLOWLIST_AIRTIME', 'VAS_ALLOWLIST_DATA', 'VAS_ALLOWLIST_ELECTRICITY', 'VAS_ALLOWLIST_BLU_LOAD', 'VAS_ALLOWLIST_OTT_LOAD', 'VAS_ALLOWLIST_OTT_VOUCHER'];
const NEUTRAL = Object.fromEntries([...SWITCHES, ...LISTS, 'OTT_MERCHANT_API_KEY', 'WAPAY_PAYOUT_ENABLED', 'WAPAY_PAYOUT_ALLOWLIST', 'WAPAY_WICODE_LIVE', 'VAS_ALLOWLIST_FUEL'].map((k) => [k, undefined]));

function withEnv(env, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const NO_DATE = /\b(january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|tomorrow|20\d\d)\b/i;
const BANNED = /\b(bet|bets|betting|wager|casino|odds|gambl\w*)\b|[—–]/i;

test('the six switches are off by default, read at call time, and =true turns each on for everyone', () => {
  withEnv(NEUTRAL, () => {
    for (const k of ['AIRTIME', 'DATA', 'ELECTRICITY']) {
      assert.equal(VAS_LIVE[k], false, `${k} default`);
      assert.equal(VAS_CATEGORY_CONFIG[k].enabled, false);
      assert.equal(VAS_CATEGORY_CONFIG[k].comingSoon, true);
      assert.equal(isCategoryLive(k), false);
      assert.equal(isCategoryEnabledForWaId(k, PILOT), false, `${k}: the pilot number too`);
    }
    for (const r of Object.keys(RAILS)) assert.equal(isRailLive(r), false, `${r} default`);
    assert.deepEqual(getLiveCategories(), []);
    const s = launchScope(OTHER);
    assert.deepEqual(s, { airtime: false, data: false, electricity: false, anyVas: false, allVas: false, bluLoad: false, ottLoad: false, voucher: false });
  });
  for (const [env, key] of [['VAS_LIVE_AIRTIME', 'AIRTIME'], ['VAS_LIVE_DATA', 'DATA'], ['VAS_LIVE_ELECTRICITY', 'ELECTRICITY']]) {
    withEnv({ ...NEUTRAL, [env]: 'true' }, () => {
      assert.equal(VAS_LIVE[key], true, `${env} read at call time, not at import`);
      assert.equal(isCategoryEnabledForWaId(key, OTHER), true);
      assert.deepEqual(getLiveCategories(), [key]);
    });
    withEnv({ ...NEUTRAL, [env]: 'TRUE ' }, () => assert.equal(VAS_LIVE[key], true, 'case and whitespace tolerant'));
    withEnv({ ...NEUTRAL, [env]: 'false' }, () => assert.equal(VAS_LIVE[key], false));
    withEnv({ ...NEUTRAL, [env]: '' }, () => assert.equal(VAS_LIVE[key], false, 'empty means unset'));
  }
  withEnv({ ...NEUTRAL, VAS_LIVE_BLU_LOAD: 'true' }, () => assert.equal(isRailLiveFor('BLU_LOAD', OTHER), true));
  withEnv({ ...NEUTRAL, VAS_LIVE_OTT_VOUCHER: 'true' }, () => assert.equal(launchScope(OTHER).voucher, true));
  withEnv({ ...NEUTRAL, VAS_LIVE_OTT_LOAD: 'true' }, () => assert.equal(launchScope(OTHER).ottLoad, false, 'the OTT load rail also needs the merchant key'));
  withEnv({ ...NEUTRAL, VAS_LIVE_OTT_LOAD: 'true', OTT_MERCHANT_API_KEY: 'k' }, () => assert.equal(launchScope(OTHER).ottLoad, true));
  // The env surface is exactly the documented one (no second spelling anywhere).
  for (const env of SWITCHES) assert.ok(vasConfigSrc.includes(`'${env}'`), env);
});

test('VAS_ALLOWLIST_<KEY> narrows an ON switch to the named testers, for rails as for categories', () => {
  withEnv({ ...NEUTRAL, VAS_LIVE_AIRTIME: 'true', VAS_ALLOWLIST_AIRTIME: ` ${PILOT},` }, () => {
    assert.equal(isCategoryEnabledForWaId('AIRTIME', PILOT), true);
    assert.equal(isCategoryEnabledForWaId('AIRTIME', OTHER), false);
    assert.equal(isCategoryLive('AIRTIME'), true, 'the global check is the switch alone');
    assert.equal(launchScope(PILOT).airtime, true);
    assert.equal(launchScope(OTHER).airtime, false);
  });
  withEnv({ ...NEUTRAL, VAS_LIVE_BLU_LOAD: 'true', VAS_ALLOWLIST_BLU_LOAD: PILOT }, () => {
    assert.equal(isRailLiveFor('BLU_LOAD', PILOT), true);
    assert.equal(isRailLiveFor('BLU_LOAD', OTHER), false);
    assert.equal(isCapabilityLiveFor('DEPOSIT_VOUCHER', { waId: OTHER }), false);
  });
  withEnv({ ...NEUTRAL, VAS_ALLOWLIST_AIRTIME: PILOT }, () => {
    assert.equal(isCategoryEnabledForWaId('AIRTIME', PILOT), false, 'an allowlist never switches anything on');
  });
});

test('the coming-soon words: what is off, what works, never a date, never a banned word', () => {
  withEnv(NEUTRAL, () => {
    const s = launchScope(OTHER);
    assert.deepEqual(comingSoonPhrases(s), ['airtime, data, electricity', 'fuel vouchers', 'cash top-ups with Blu and OTT vouchers']);
    assert.equal(prepaidNames(s, { live: false }), 'airtime, data and electricity');
    assert.equal(prepaidNames(s), '');
    assert.equal(worksTodaySentence({ scope: s, withdrawLive: true }), 'Right now you can get paid with a "please pay me" link, add money by card or Instant EFT, send money to any SA number and withdraw to your bank or as cash at an ATM.');
    assert.equal(worksTodaySentence({ scope: s, withdrawLive: false }), 'Right now you can get paid with a "please pay me" link, add money by card or Instant EFT and send money to any SA number.');
    const r = comingSoonReply('Airtime', { emoji: '📱', scope: s, withdrawLive: true });
    assert.match(r, /^📱 Airtime is coming soon on WaPay\. I will tell you the moment it is live\.\n\nRight now you can/);
    assert.match(comingSoonReply('Data bundles', { plural: true, scope: s }), /^🔜 Data bundles are coming soon on WaPay\. I will tell you the moment they are live\./);
    for (const t of [r, ...comingSoonPhrases(s), worksTodaySentence({ scope: s, withdrawLive: true })]) {
      assert.doesNotMatch(t, NO_DATE, t);
      assert.doesNotMatch(t, BANNED, t);
    }
  });
  withEnv({ ...NEUTRAL, VAS_LIVE_AIRTIME: 'true', VAS_LIVE_BLU_LOAD: 'true' }, () => {
    const s = launchScope(OTHER);
    assert.deepEqual(comingSoonPhrases(s, { wicodeLive: true }), ['data, electricity', 'top-ups with an OTT voucher']);
    assert.match(worksTodaySentence({ scope: s, withdrawLive: false, wicodeLive: false }), /add cash with a Blu voucher from any till, send money to any SA number and buy airtime\.$/);
  });
  assert.equal(joinAnd(['a']), 'a'); assert.equal(joinAnd(['a', 'b']), 'a and b'); assert.equal(joinAnd(['a', 'b', 'c']), 'a, b and c');
});

test('the registry in the shipped default: no prepaid or voucher product advertised, send and pay links live, withdraw as the payout gate says', () => {
  withEnv({ ...NEUTRAL, WAPAY_PAYOUT_ENABLED: 'true' }, () => {
    const home = homeLines({ waId: OTHER });
    assert.equal(home[0], `🛒 *Buy*: airtime, data and electricity, coming soon`);
    assert.equal(home[1], `💸 *Send*: "send R50 to 083..."`);
    assert.equal(home[3], `💳 *Deposit*: "deposit R100" by card or Instant EFT`);
    assert.ok(home.includes(`🏧 *Withdraw*: "withdraw R200" to your bank, or cash at an ATM`), 'withdraw untouched');
    const help = helpLines({ waId: OTHER }).join('\n');
    assert.doesNotMatch(help, /Airtime|Data|Electricity|Redeem voucher/);
    assert.match(help, /Send money/); assert.match(help, /Get paid/); assert.match(help, /Withdraw/);
    const prompt = promptLines({ waId: OTHER }).join('\n');
    assert.doesNotMatch(prompt, /^- (Airtime|Data|Electricity|Cash voucher|OTT voucher load|OTT voucher):/m);
    assert.match(prompt, /^- Send money:/m); assert.match(prompt, /^- Withdraw:/m);
    assert.ok(!welcomeLines().some((l) => /^📱 Buy/.test(l)));
    assert.equal(worksToday({ waId: OTHER }), 'Right now you can get paid with a "please pay me" link, add money by card or Instant EFT, send money to any SA number and withdraw to your bank or as cash at an ATM.');
    const sc = launchScopeFor({ waId: OTHER });
    assert.equal(sc.withdrawLive, true); assert.equal(sc.anyVas, false);
  });
});

test('the model is told the same truth: product truth built from the scope, coming-soon block present, withdraw line untouched', () => {
  assert.match(orchestrator, /export interface LaunchScope \{/);
  assert.match(orchestrator, /const PRODUCT_TRUTH = \(withdrawLive: boolean = process\.env\.WAPAY_PAYOUT_ENABLED === 'true', scope: LaunchScope = scopeFromEnv\(\)\): string =>/);
  assert.match(orchestrator, /COMING SOON, NOT AVAILABLE TODAY \(absolute\)/);
  assert.match(orchestrator, /scope\.bluLoad \? 'CASH — take cash to the till/);
  assert.match(orchestrator, /'- Airtime, data and prepaid electricity: COMING SOON, not available today\.'/);
  assert.match(orchestrator, /agentPrompt\(tier1\.domain, opts\.knowledge, opts\.withdrawLive, opts\.scope\)/);
  assert.doesNotMatch(orchestrator, /^- Add money, three ways:/m, 'the unconditional cash claim is gone');
  // The withdraw truth is exactly as before (payouts thread, 2026-10-18).
  assert.match(orchestrator, /\$\{withdrawLive \? '- Getting money OUT \(withdrawals\): LIVE\. The user types "withdraw" and an amount \(from R20\)/);
  withEnv(NEUTRAL, () => assert.deepEqual(scopeFromEnv(), { airtime: false, data: false, electricity: false, bluLoad: false, ottLoad: false, voucher: false }));
  withEnv({ ...NEUTRAL, VAS_LIVE_DATA: 'true' }, () => assert.equal(scopeFromEnv().data, true));
});

test('processor: every entry point of an off product answers coming soon; send money is not gated', () => {
  const head = (name, len = 700) => { const i = processor.indexOf(name); assert.ok(i > -1, name); return processor.slice(i, i + len); };
  // Airtime had no gate at all before 2026-10-18.
  assert.match(head('async function startAirtimePreviewAndConfirm('), /isCategoryEnabledForWaId\('AIRTIME', from\)/);
  assert.match(head('async function startElectricityPreviewAndConfirm('), /isCategoryEnabledForWaId\('ELECTRICITY', from\)/);
  assert.match(head('async function handleDataPurchaseFromSlots('), /isCategoryEnabledForWaId\('DATA', from\)/);
  assert.match(head("case 'BUY_AIRTIME':\n        // User wants to buy airtime"), /isCategoryEnabledForWaId\('AIRTIME', from\)/);
  assert.match(head("case 'BUY_AIRTIME': {"), /isCategoryEnabledForWaId\('AIRTIME', from\)/);
  for (const st of ['AIRTIME_PIN', 'DATA_PIN']) assert.match(head(`case '${st}':`), /isCategoryEnabledForWaId\('(AIRTIME|DATA)', from\)/, `${st} vend gate`);
  assert.match(head("case 'ELECTRICITY_PIN':", 4000), /categoryUnavailableMessage\('ELECTRICITY', from\)/);
  // The first harness run (2026-10-18) found four more ways in: the smart product query, the
  // context-aware airtime case, the orchestrator's electricity case and the parked ask states.
  assert.match(head('    if (hasElectricityIntent) {', 400), /isCategoryEnabledForWaId\('ELECTRICITY', from\)/);
  assert.match(head("    if (hasAirtimeIntent && !lowerText.includes('data')", 400), /isCategoryEnabledForWaId\('AIRTIME', from\)/);
  assert.match(head("        case 'AIRTIME':\n          // Airtime flow - start it", 400), /isCategoryEnabledForWaId\('AIRTIME', from\)/);
  assert.match(head("case 'BUY_ELECTRICITY': {", 300), /isCategoryEnabledForWaId\('ELECTRICITY', from\)/);
  assert.match(head('async function handleListAirtimeBundles(', 400), /isCategoryEnabledForWaId\('AIRTIME', from\)/);
  for (const [st, cat] of [['AIRTIME_AMOUNT', 'AIRTIME'], ['AIRTIME_MSISDN', 'AIRTIME'], ['AIRTIME_CONFIRM', 'AIRTIME'], ['ELECTRICITY_AMOUNT', 'ELECTRICITY'], ['ELECTRICITY_METER', 'ELECTRICITY'], ['DATA_MSISDN', 'DATA'], ['DATA_NETWORK', 'DATA'], ['DATA_PERIOD', 'DATA'], ['DATA_CONFIRM', 'DATA']]) {
    assert.match(head(`    case '${st}':`, 450), new RegExp(`isCategoryEnabledForWaId\\('${cat}', from\\)`), `${st} parked-state gate`);
  }
  // The per-customer gate everywhere; the global one only for menus.
  for (const k of ['AIRTIME', 'DATA', 'ELECTRICITY']) assert.ok(!processor.includes(`!isCategoryLive('${k}')`), `${k}: no global-only gate left`);
  // Voucher loads.
  assert.match(head("case 'VOUCHER_PIN':"), /cashLoadLiveFor\(from\)/);
  assert.match(head("case 'AWAITING_VOUCHER_PIN':"), /cashLoadLiveFor\(from\)/);
  assert.match(head("case 'REDEEM_VOUCHER':\n"), /cashLoadLiveFor\(from\)[\s\S]*DEPOSIT_CARD_AMOUNT/);
  assert.match(head("case 'REDEEM_VOUCHER': {"), /cashLoadLiveFor\(from\)[\s\S]*Not yet\. \$\{CASH_LOAD_SOON\}/);
  assert.match(head('async function handleVoucherRedemption('), /isRailLiveFor\('BLU_LOAD', from\)/);
  assert.match(head('async function attemptOttRedemption('), /isRailLiveFor\('OTT_LOAD', from\)/);
  assert.match(head("case 'AWAITING_DEPOSIT_METHOD': {"), /isRailLiveFor\('BLU_LOAD', from\)/);
  assert.match(processor, /!depositProfile\.preferredDepositMethod && isRailLiveFor\('BLU_LOAD', from\)/);
  // The OTT self-purchase only; the send flow itself is not gated (founder, 2026-10-18).
  assert.match(head('if (matchOttVoucherSelfRequest(text, slots)) {'), /isRailLiveFor\('OTT_VOUCHER', from\)/);
  assert.match(head('async function startVoucherGiftPreviewAndConfirm('), /intent === 'OTT_VOUCHER_SELF' && !isRailLiveFor\('OTT_VOUCHER', from\)/);
  assert.match(head("case 'SEND_VOUCHER': {"), /result\.slots\?\.self && !isRailLiveFor\('OTT_VOUCHER', from\)/);
  const gift = head('const gift = resolveGift({ slots, senderMsisdn: account.msisdn });', 300);
  assert.doesNotMatch(gift, /isRailLiveFor/, 'a send to a number is never refused by the voucher switch');
  // The old reply that claimed airtime while refusing a category is gone; the new one is the shared shape.
  assert.ok(!processor.includes('You can still buy airtime, data, or electricity right now'));
  assert.match(head('function categoryUnavailableMessage('), /comingSoonReply\(subject/);
  // Context and knowledge carry the scope.
  assert.match(processor, /scope: launchScope\(from\), waId: from, fuelPartners/);
  assert.match(processor, /feesBlock: feeFacts\(\{ withdrawLive, scope: launchScope\(from\) \}\)/);
  assert.match(head("let message = `🛍️ *Here is everything your WaPay money can do right now*", 1200), /liveCategories\.length[\s\S]*Coming soon:/);
});

test('the ad flow brief is unchanged: ad arrivals still hear the brief\'s own sentence', () => {
  assert.equal(CAN_DO.comingSoon, 'Airtime, data, electricity and fuel are coming soon.');
});
