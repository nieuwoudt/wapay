/**
 * The capability registry (lib/capabilities.js): one list, one gate per
 * item, every surface rendered from it. Locks: ids unique and every
 * how-it-works topic reachable; gates follow the flows' own env switches;
 * the home and help lines are the processor's current copy verbatim; the
 * model prompt never names something the gate refuses; no betting words.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CAPABILITIES, capabilitiesFor, capabilityById, isCapabilityLiveFor, fuelLiveFor,
  homeLines, helpLines, promptLines, welcomeLines,
} from '../lib/capabilities.js';
import { TOPICS } from '../lib/how-it-works.js';
import { payoutAllowedFor } from '../lib/payouts.js';

const processorSource = readFileSync(
  fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)),
  'utf8'
);

function withEnv(env, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const PILOT = '27787051175';
const OTHER = '27780000001';
// NEUTRAL = nothing set: the shipped default. Launch scope (2026-10-18): airtime, data, electricity,
// the Blu voucher load, the OTT load and the OTT self-purchase are OFF until their VAS_LIVE_<KEY> is set.
const NEUTRAL = { WAPAY_LAUNCH_HOLD: undefined, WAPAY_PAYOUT_ENABLED: undefined, WAPAY_PAYOUT_ALLOWLIST: undefined, WAPAY_WICODE_LIVE: undefined, VAS_ALLOWLIST_FUEL: undefined, VAS_ALLOWLIST_ELECTRICITY: undefined, VAS_ALLOWLIST_AIRTIME: undefined, VAS_ALLOWLIST_DATA: undefined, VAS_ALLOWLIST_BLU_LOAD: undefined, VAS_LIVE_AIRTIME: undefined, VAS_LIVE_DATA: undefined, VAS_LIVE_ELECTRICITY: undefined, VAS_LIVE_BLU_LOAD: undefined, VAS_LIVE_OTT_LOAD: undefined, VAS_LIVE_OTT_VOUCHER: undefined, OTT_MERCHANT_API_KEY: undefined, WAPAY_BUSINESS_SIGNUPS: undefined, WAPAY_BUSINESS_MSISDNS: undefined };
// Every launch switch on, for the world the pre-launch copy locks describe.
const LAUNCH_ON = { VAS_LIVE_AIRTIME: 'true', VAS_LIVE_DATA: 'true', VAS_LIVE_ELECTRICITY: 'true', VAS_LIVE_BLU_LOAD: 'true', VAS_LIVE_OTT_VOUCHER: 'true', WAPAY_LAUNCH_HOLD: 'off' };

const EXPECTED_IDS = ['BALANCE', 'AIRTIME', 'DATA', 'ELECTRICITY', 'SEND', 'OTT_SELF', 'REQUEST_MONEY', 'DEPOSIT_CARD', 'DEPOSIT_VOUCHER', 'VOUCHER_LOAD', 'WITHDRAW', 'FUEL', 'BUSINESS', 'INVITE', 'PIN_RESET'];

test('every descriptor is complete, ids are unique and the expected set', () => {
  const ids = CAPABILITIES.map((c) => c.id);
  assert.deepEqual([...new Set(ids)].sort(), [...EXPECTED_IDS].sort());
  assert.equal(ids.length, new Set(ids).size, 'ids unique');
  for (const c of CAPABILITIES) {
    assert.equal(typeof c.label, 'string');
    assert.ok(c.emoji, `${c.id} emoji`);
    assert.match(c.oneLiner, /\.$/, `${c.id} oneLiner is a sentence`);
    assert.ok(c.startCommand && c.example, `${c.id} start/example`);
    assert.equal(typeof c.liveFor, 'function');
    assert.equal(typeof c.feeLine(), 'string');
    assert.ok(c.limits === null || (Number.isInteger(c.limits.minCents) && Number.isInteger(c.limits.maxCents) && c.limits.minCents < c.limits.maxCents), `${c.id} limits are integer cents`);
    assert.deepEqual(Object.keys(c.policy).sort(), ['adviceClass', 'consents', 'minKycTier']);
    assert.equal(c.policy.adviceClass, 'none');
    assert.deepEqual(c.policy.consents, []);
    assert.equal(c.policy.minKycTier, c.id === 'WITHDRAW' ? 1 : 0, `${c.id} KYC tier`);
    assert.ok(c.topicId === null || TOPICS[c.topicId], `${c.id} topicId ${c.topicId} exists in TOPICS`);
  }
  assert.equal(capabilityById('withdraw')?.id, 'WITHDRAW');
  assert.equal(capabilityById('NOPE'), null);
  assert.equal(isCapabilityLiveFor('NOPE', {}), false);
});

test('every how-it-works topic maps to a descriptor', () => {
  const covered = new Set(CAPABILITIES.map((c) => c.topicId));
  for (const key of Object.keys(TOPICS)) assert.ok(covered.has(key), `TOPICS.${key} has a descriptor`);
});

test('BALANCE is always live; WITHDRAW follows WAPAY_PAYOUT_ENABLED + WAPAY_PAYOUT_ALLOWLIST', () => {
  withEnv({ ...NEUTRAL }, () => {
    assert.equal(isCapabilityLiveFor('BALANCE', { waId: OTHER }), true);
    assert.equal(isCapabilityLiveFor('WITHDRAW', { waId: PILOT }), false, 'switch off: nobody');
  });
  withEnv({ ...NEUTRAL, WAPAY_PAYOUT_ENABLED: 'true' }, () => {
    assert.equal(isCapabilityLiveFor('WITHDRAW', { waId: OTHER }), true, 'switch on, no list: everyone');
  });
  withEnv({ ...NEUTRAL, WAPAY_PAYOUT_ENABLED: 'true', WAPAY_PAYOUT_ALLOWLIST: PILOT }, () => {
    assert.equal(isCapabilityLiveFor('WITHDRAW', { waId: PILOT }), payoutAllowedFor(PILOT));
    assert.equal(isCapabilityLiveFor('WITHDRAW', { waId: PILOT }), true);
    assert.equal(isCapabilityLiveFor('WITHDRAW', { waId: OTHER }), false, 'named testers only');
  });
});

test('FUEL follows WAPAY_WICODE_LIVE narrowed by VAS_ALLOWLIST_FUEL (fuelLiveFor is the same gate)', () => {
  withEnv({ ...NEUTRAL, VAS_ALLOWLIST_FUEL: PILOT }, () => {
    assert.equal(fuelLiveFor(PILOT), false, 'flag off: nobody, allowlist or not');
    assert.equal(isCapabilityLiveFor('FUEL', { waId: PILOT }), false);
  });
  withEnv({ ...NEUTRAL, WAPAY_WICODE_LIVE: 'true', WAPAY_LAUNCH_HOLD: 'off' }, () => {
    assert.equal(fuelLiveFor(OTHER), true, 'flag on, no list: everyone');
  });
  withEnv({ ...NEUTRAL, WAPAY_WICODE_LIVE: 'true', VAS_ALLOWLIST_FUEL: `${PILOT}, `, WAPAY_LAUNCH_HOLD: 'off' }, () => {
    assert.equal(fuelLiveFor(PILOT), true);
    assert.equal(fuelLiveFor(OTHER), false);
    assert.equal(isCapabilityLiveFor('FUEL', { waId: OTHER }), false);
  });
});

test('VAS categories respect VAS_ALLOWLIST_* (the electricity rollout idiom) on top of VAS_LIVE_*', () => {
  withEnv({ ...NEUTRAL, ...LAUNCH_ON, VAS_ALLOWLIST_ELECTRICITY: PILOT }, () => {
    assert.equal(isCapabilityLiveFor('ELECTRICITY', { waId: PILOT }), true);
    assert.equal(isCapabilityLiveFor('ELECTRICITY', { waId: OTHER }), false);
    assert.equal(isCapabilityLiveFor('AIRTIME', { waId: OTHER }), true, 'other categories untouched');
  });
  withEnv({ ...NEUTRAL, ...LAUNCH_ON }, () => {
    assert.equal(isCapabilityLiveFor('ELECTRICITY', { waId: OTHER }), true);
  });
  // Launch scope (2026-10-18): nothing set means OFF for everyone, the pilot number included.
  withEnv({ ...NEUTRAL }, () => {
    for (const id of ['AIRTIME', 'DATA', 'ELECTRICITY', 'OTT_SELF', 'DEPOSIT_VOUCHER', 'VOUCHER_LOAD']) {
      assert.equal(isCapabilityLiveFor(id, { waId: PILOT }), false, `${id} off by default`);
    }
    assert.equal(isCapabilityLiveFor('SEND', { waId: OTHER }), true, 'send money stays live (founder, 2026-10-18)');
  });
  withEnv({ ...NEUTRAL, VAS_LIVE_AIRTIME: 'true', VAS_ALLOWLIST_AIRTIME: PILOT, WAPAY_LAUNCH_HOLD: 'off' }, () => {
    assert.equal(isCapabilityLiveFor('AIRTIME', { waId: PILOT }), true, 'switch on + allowlist: the tester');
    assert.equal(isCapabilityLiveFor('AIRTIME', { waId: OTHER }), false, 'switch on + allowlist: nobody else');
  });
});

test('VOUCHER_LOAD needs the OTT merchant key AND its switch; DEPOSIT_VOUCHER follows VAS_LIVE_BLU_LOAD; BUSINESS follows mayRegister', () => {
  withEnv({ ...NEUTRAL }, () => {
    assert.equal(isCapabilityLiveFor('VOUCHER_LOAD', {}), false);
    assert.equal(isCapabilityLiveFor('BUSINESS', { waId: OTHER }), false, 'registration closed by default');
    assert.equal(isCapabilityLiveFor('DEPOSIT_VOUCHER', {}), false, 'the Blu till voucher is off until VAS_LIVE_BLU_LOAD (launch scope 2026-10-18)');
  });
  withEnv({ ...NEUTRAL, VAS_LIVE_BLU_LOAD: 'true', WAPAY_LAUNCH_HOLD: 'off' }, () => {
    assert.equal(isCapabilityLiveFor('DEPOSIT_VOUCHER', { waId: OTHER }), true);
  });
  withEnv({ ...NEUTRAL, OTT_MERCHANT_API_KEY: 'k' }, () => {
    assert.equal(isCapabilityLiveFor('VOUCHER_LOAD', { waId: OTHER }), false, 'the key alone does not switch the rail on');
  });
  withEnv({ ...NEUTRAL, OTT_MERCHANT_API_KEY: 'k', VAS_LIVE_OTT_LOAD: 'true', WAPAY_BUSINESS_MSISDNS: PILOT, WAPAY_LAUNCH_HOLD: 'off' }, () => {
    assert.equal(isCapabilityLiveFor('VOUCHER_LOAD', { waId: OTHER }), true);
    assert.equal(isCapabilityLiveFor('BUSINESS', { waId: PILOT }), true);
    assert.equal(isCapabilityLiveFor('BUSINESS', { waId: OTHER }), false);
  });
  withEnv({ ...NEUTRAL, WAPAY_BUSINESS_SIGNUPS: 'open' }, () => {
    assert.equal(isCapabilityLiveFor('BUSINESS', { waId: OTHER }), true);
  });
});

// The home card copy, verbatim (launch scope 2026-10-18, founder's home-card ask the same day):
// live products get their line; everything off is named once in the coming-soon line.
const BUY_ALL = `🛒 *Buy*: airtime, data, electricity`;
const SEND = `💸 *Send*: "send R50 to 083..."`;
// 2026-10-24: every link says what it is for, and "my links" tracks them (founder).
const GET_PAID = `🙏 *Get Paid*: "please pay me R150 for braids" → forward your link · "my links" to track them`;
const DEPOSIT_BLU = `💳 *Deposit*: "deposit R100" or a Blu voucher`;
const DEPOSIT_CARD = `💳 *Deposit*: "deposit R100" by card or Instant EFT`;
const HOME_TAIL = `📄 *Transactions* · ⚙️ *Settings*`;
// Referrals (docs/REFERRALS.md, 2026-10-20): the invite is named once on the card, right before the tail.
const INVITE = `🤝 *Invite*: "invite" to share WaPay with a friend`;
// The web portal line (2026-10-22): between the invite and the tail on every card.
const WEB = `🌐 *Web*: app.wapay.co.za - WaPay in your browser`;
const FUEL_ON = `⛽ *Fuel*: "buy fuel" for participating stations`;
const FUEL_OFF = `⛽ *Fuel vouchers*: coming soon`;
const WITHDRAW_ON = `🏧 *Withdraw*: "withdraw R200" to your bank, or cash at an ATM`;
const WITHDRAW_OFF = `🏧 *Withdraw*: coming soon`;
const SOON_ALL = `🔜 *Coming soon*: airtime, data, electricity, fuel vouchers, cash deposits with a Blu or OTT voucher and a virtual card`;
const SOON_PILOT = `🔜 *Coming soon*: top-ups with an OTT voucher and a virtual card`;
const SOON_OTHER = `🔜 *Coming soon*: fuel vouchers, top-ups with an OTT voucher and a virtual card`;
const HOME_HEAD_ON = [BUY_ALL, SEND, GET_PAID, DEPOSIT_BLU];
const HOME_HEAD_HOLD = [SEND, GET_PAID, DEPOSIT_CARD];

test('homeLines equals renderHome for a non-pilot number and for a pilot number', () => {
  // Nothing set (the shipped default, the master hold): no product that is off, one coming-soon line.
  withEnv({ ...NEUTRAL }, () => {
    assert.deepEqual(homeLines({ waId: OTHER }), [...HOME_HEAD_HOLD, WITHDRAW_OFF, SOON_ALL, INVITE, WEB, HOME_TAIL]);
  });
  // The hold outranks a switch and a tester list left on from an earlier rollout (the founder's own test, 2026-10-18).
  withEnv({ ...NEUTRAL, VAS_LIVE_ELECTRICITY: 'true', VAS_ALLOWLIST_ELECTRICITY: PILOT, WAPAY_WICODE_LIVE: 'true', VAS_ALLOWLIST_FUEL: PILOT, WAPAY_LAUNCH_HOLD: undefined }, () => {
    assert.deepEqual(homeLines({ waId: PILOT }), [...HOME_HEAD_HOLD, WITHDRAW_OFF, SOON_ALL, INVITE, WEB, HOME_TAIL]);
  });
  // A single switch on (hold released) shows only that product.
  withEnv({ ...NEUTRAL, WAPAY_LAUNCH_HOLD: 'off', VAS_LIVE_AIRTIME: 'true' }, () => {
    assert.equal(homeLines({ waId: OTHER })[0], `🛒 *Buy*: airtime`);
  });
  // Launch switches on, pilot lists set: the pilot sees both live, everyone else still sees coming soon.
  withEnv({ ...NEUTRAL, ...LAUNCH_ON, WAPAY_PAYOUT_ENABLED: 'true', WAPAY_PAYOUT_ALLOWLIST: PILOT, WAPAY_WICODE_LIVE: 'true', VAS_ALLOWLIST_FUEL: PILOT }, () => {
    assert.deepEqual(homeLines({ waId: PILOT }), [...HOME_HEAD_ON, FUEL_ON, WITHDRAW_ON, SOON_PILOT, INVITE, WEB, HOME_TAIL]);
    assert.deepEqual(homeLines({ waId: OTHER }), [...HOME_HEAD_ON, WITHDRAW_OFF, SOON_OTHER, INVITE, WEB, HOME_TAIL]);
  });
  // Phase 1 (2026-09-16): renderHome prints these lines BY CALLING the registry.
  assert.ok(processorSource.includes("${homeLines({ waId: from, account }).join('\\n')}"), 'renderHome renders homeLines');
  for (const line of [...HOME_HEAD_ON, ...HOME_HEAD_HOLD, FUEL_ON, FUEL_OFF, WITHDRAW_ON, WITHDRAW_OFF, SOON_ALL, INVITE, WEB, HOME_TAIL]) {
    assert.ok(!processorSource.includes(line) || line === HOME_TAIL, `no hand-written copy of: ${line}`);
  }
});

const HELP_HEAD = [
  `💰 *Balance* - "What's my balance?"`,
  `📱 *Airtime* - "Buy R50 airtime"`,
  `📶 *Data* - "Buy 1GB data"`,
  `💡 *Electricity* - "Buy R100 electricity"`,
  `💸 *Send money* - "Send R50 to 083...", or just share a contact from your phone`,
  `🙏 *Get paid* - "please pay me R150 for braids", then forward the link. "my links" to track them`,
  `💳 *Deposit* - "Deposit R100"`,
  `🎟️ *Voucher* - "Redeem voucher"`,
];
// Nothing set: no prepaid line, no voucher line (launch scope 2026-10-18).
const HELP_HEAD_HOLD = [
  `💰 *Balance* - "What's my balance?"`,
  `💸 *Send money* - "Send R50 to 083...", or just share a contact from your phone`,
  `🙏 *Get paid* - "please pay me R150 for braids", then forward the link. "my links" to track them`,
  `💳 *Deposit* - "Deposit R100"`,
];
const HELP_WITHDRAW = `🏧 *Withdraw* - "withdraw R200" to your bank or as cash at an ATM`;
const HELP_FUEL = `⛽ *Fuel* - "buy fuel"`;
const HELP_TAIL = `🏪 *Business* - "business account" to get paid by your customers`;
// Referrals (docs/REFERRALS.md, 2026-10-20): the invite line sits between business and the PIN reset.
const HELP_INVITE = `🤝 *Invite a friend* - "invite" for your link to share`;
const HELP_PIN = `🔐 *Forgot PIN* - "forgot PIN" to set a new one`;

test('helpLines equals the Help Menu lines, with withdraw and fuel only when live', () => {
  withEnv({ ...NEUTRAL }, () => {
    assert.deepEqual(helpLines({ waId: OTHER }), [...HELP_HEAD_HOLD, HELP_TAIL, HELP_INVITE, HELP_PIN]);
  });
  withEnv({ ...NEUTRAL, ...LAUNCH_ON }, () => {
    assert.deepEqual(helpLines({ waId: OTHER }), [...HELP_HEAD, HELP_TAIL, HELP_INVITE, HELP_PIN]);
  });
  withEnv({ ...NEUTRAL, ...LAUNCH_ON, WAPAY_PAYOUT_ENABLED: 'true', WAPAY_PAYOUT_ALLOWLIST: PILOT, WAPAY_WICODE_LIVE: 'true', VAS_ALLOWLIST_FUEL: PILOT, WAPAY_LAUNCH_HOLD: 'off' }, () => {
    assert.deepEqual(helpLines({ waId: PILOT }), [...HELP_HEAD, HELP_WITHDRAW, HELP_FUEL, HELP_TAIL, HELP_INVITE, HELP_PIN]);
    assert.deepEqual(helpLines({ waId: OTHER }), [...HELP_HEAD, HELP_TAIL, HELP_INVITE, HELP_PIN]);
  });
  // Phase 1 (2026-09-16): the Help Menu prints these lines BY CALLING the registry.
  const helpSrc = processorSource.slice(processorSource.indexOf('const helpMsg = `📋 *WaPay Help Menu*'), processorSource.indexOf('const helpMsg = `📋 *WaPay Help Menu*') + 400);
  assert.ok(helpSrc.includes("${helpLines({ waId: from, account }).join('\\n')}"), 'the help menu renders helpLines');
  for (const line of [...HELP_HEAD, ...HELP_HEAD_HOLD, HELP_WITHDRAW, HELP_FUEL, HELP_TAIL, HELP_INVITE, HELP_PIN]) {
    assert.ok(!helpSrc.includes(line), `no hand-written copy of: ${line}`);
  }
});

test('promptLines never names a capability the gate says is off, and names every live one', () => {
  const check = (ctx) => {
    const all = promptLines(ctx);
    const soonLines = all.filter((l) => l.startsWith('- Coming soon, not available today'));
    const lines = all.filter((l) => !l.startsWith('- Coming soon, not available today'));
    const live = capabilitiesFor(ctx);
    assert.equal(lines.length, live.length);
    assert.ok(soonLines.length <= 1, 'at most one coming-soon line');
    for (const l of soonLines) assert.match(l, /never offer, start or explain these/);
    for (const c of CAPABILITIES) {
      const named = lines.some((l) => l.startsWith(`- ${c.label}:`));
      assert.equal(named, isCapabilityLiveFor(c.id, ctx), `${c.id} named=${named}`);
    }
    for (const l of lines) assert.match(l, /^- .+: .+ Start: ".+"\. .+$/);
  };
  withEnv({ ...NEUTRAL }, () => {
    check({ waId: OTHER });
    assert.ok(!promptLines({ waId: OTHER }).some((l) => /^- (Withdraw|Fuel):/.test(l)), 'off: withdraw and fuel unnamed as products');
    assert.ok(promptLines({ waId: OTHER }).some((l) => /^- Coming soon, not available today .*airtime, data, electricity/.test(l)), 'the model is told what is coming soon');
  });
  withEnv({ ...NEUTRAL, WAPAY_PAYOUT_ENABLED: 'true', WAPAY_PAYOUT_ALLOWLIST: PILOT, WAPAY_WICODE_LIVE: 'true', VAS_ALLOWLIST_FUEL: PILOT, OTT_MERCHANT_API_KEY: 'k', WAPAY_LAUNCH_HOLD: 'off' }, () => {
    check({ waId: PILOT });
    check({ waId: OTHER });
    assert.ok(promptLines({ waId: PILOT }).some((l) => l.startsWith('- Withdraw:') && /PayShap/.test(l)), 'live withdraw line carries the fee');
    assert.ok(!promptLines({ waId: OTHER }).some((l) => l.startsWith('- Withdraw:')));
  });
});

test('fee lines come from feeSchedule and limits from the flows', () => {
  assert.match(capabilityById('DEPOSIT_CARD').feeLine(), /4\.2% \+ R2\.30/);
  assert.match(capabilityById('DEPOSIT_VOUCHER').feeLine(), /keeps 6%.*adds R94/);
  // A send is free to anyone since 2026-10-18 (BUGLOG #117): balance to balance, never a voucher.
  assert.match(capabilityById('SEND').feeLine(), /Free, to anyone\. If they never join, it comes back to you after 30 days\./);
  assert.match(capabilityById('REQUEST_MONEY').feeLine(), /under R50/);
  withEnv({ ...NEUTRAL }, () => assert.match(capabilityById('WITHDRAW').feeLine(), /no withdrawal fee to quote/));
  withEnv({ ...NEUTRAL, WAPAY_PAYOUT_ENABLED: 'true' }, () => assert.match(capabilityById('WITHDRAW').feeLine(), /PayShap/));
  assert.deepEqual(capabilityById('DEPOSIT_CARD').limits, { minCents: 1000, maxCents: 300000 });
  assert.deepEqual(capabilityById('REQUEST_MONEY').limits, { minCents: 500, maxCents: 300000 });
  assert.deepEqual(capabilityById('WITHDRAW').limits, { minCents: 2000, maxCents: 300000 });
  assert.deepEqual(capabilityById('AIRTIME').limits, { minCents: 500, maxCents: 100000 });
  assert.deepEqual(capabilityById('FUEL').limits, { minCents: 5000, maxCents: 50000 });
});

test('welcomeLines is a short product list that only advertises what everyone has', () => {
  withEnv({ ...NEUTRAL }, () => {
    const lines = welcomeLines();
    assert.ok(lines.length >= 4 && lines.length <= 8);
    assert.ok(!lines.some((l) => /withdraw|fuel vouchers for/i.test(l)));
    // Launch scope (2026-10-18): what is off is named once as coming soon, never as a product.
    assert.ok(!lines.some((l) => /^📱 Buy/.test(l)), 'no prepaid line while off');
    assert.ok(lines.some((l) => /^🔜 Coming soon: airtime, data, electricity/.test(l)), 'the coming-soon line');
    assert.ok(lines.some((l) => l === `💳 Add money by card or Instant EFT`));
  });
  withEnv({ ...NEUTRAL, ...LAUNCH_ON }, () => {
    const lines = welcomeLines();
    assert.ok(lines.some((l) => l === `📱 Buy airtime, data and prepaid electricity`));
    assert.ok(lines.some((l) => l === `💳 Add money by card or with a Blu voucher from any till`));
  });
  withEnv({ ...NEUTRAL, VAS_LIVE_AIRTIME: 'true', VAS_ALLOWLIST_AIRTIME: PILOT, WAPAY_LAUNCH_HOLD: 'off' }, () => {
    assert.ok(!welcomeLines().some((l) => /^📱 Buy/.test(l)), 'a tester list is not "everyone"');
  });
  withEnv({ ...NEUTRAL, WAPAY_PAYOUT_ENABLED: 'true', WAPAY_PAYOUT_ALLOWLIST: PILOT }, () => {
    assert.ok(!welcomeLines().some((l) => /withdraw/i.test(l)), 'a pilot list is not "everyone"');
  });
  withEnv({ ...NEUTRAL, WAPAY_PAYOUT_ENABLED: 'true', WAPAY_WICODE_LIVE: 'true', WAPAY_LAUNCH_HOLD: 'off' }, () => {
    const lines = welcomeLines();
    assert.ok(lines.some((l) => /withdraw/i.test(l)));
    assert.ok(lines.some((l) => /participating Shell and Engen stations/.test(l)));
  });
});

test('no betting words and no em dashes anywhere in descriptor text or rendered lines', () => {
  const texts = [];
  for (const c of CAPABILITIES) texts.push(c.label, c.oneLiner, c.startCommand, c.example, c.comingSoonLine || '', c.helpLine || '', c.feeLine());
  for (const env of [{ ...NEUTRAL }, { ...NEUTRAL, ...LAUNCH_ON, VAS_LIVE_OTT_LOAD: 'true', WAPAY_PAYOUT_ENABLED: 'true', WAPAY_WICODE_LIVE: 'true', OTT_MERCHANT_API_KEY: 'k', WAPAY_BUSINESS_SIGNUPS: 'open', WAPAY_LAUNCH_HOLD: 'off' }]) {
    withEnv(env, () => {
      for (const c of CAPABILITIES) texts.push(c.feeLine());
      texts.push(...homeLines({ waId: OTHER }), ...helpLines({ waId: OTHER }), ...promptLines({ waId: OTHER }), ...welcomeLines());
    });
  }
  for (const t of texts) {
    assert.ok(!/bet|wager|casino|odds/i.test(t), `betting word in: ${t}`);
    assert.ok(!/[—–]/.test(t), `dash in: ${t}`);
  }
});
