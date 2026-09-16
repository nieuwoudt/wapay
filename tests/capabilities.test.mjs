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
const NEUTRAL = { WAPAY_PAYOUT_ENABLED: undefined, WAPAY_PAYOUT_ALLOWLIST: undefined, WAPAY_WICODE_LIVE: undefined, VAS_ALLOWLIST_FUEL: undefined, VAS_ALLOWLIST_ELECTRICITY: undefined, OTT_MERCHANT_API_KEY: undefined, WAPAY_BUSINESS_SIGNUPS: undefined, WAPAY_BUSINESS_MSISDNS: undefined };

const EXPECTED_IDS = ['BALANCE', 'AIRTIME', 'DATA', 'ELECTRICITY', 'SEND', 'OTT_SELF', 'REQUEST_MONEY', 'DEPOSIT_CARD', 'DEPOSIT_VOUCHER', 'VOUCHER_LOAD', 'WITHDRAW', 'FUEL', 'BUSINESS'];

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
  withEnv({ ...NEUTRAL, WAPAY_WICODE_LIVE: 'true' }, () => {
    assert.equal(fuelLiveFor(OTHER), true, 'flag on, no list: everyone');
  });
  withEnv({ ...NEUTRAL, WAPAY_WICODE_LIVE: 'true', VAS_ALLOWLIST_FUEL: `${PILOT}, ` }, () => {
    assert.equal(fuelLiveFor(PILOT), true);
    assert.equal(fuelLiveFor(OTHER), false);
    assert.equal(isCapabilityLiveFor('FUEL', { waId: OTHER }), false);
  });
});

test('VAS categories respect VAS_ALLOWLIST_* (the electricity rollout idiom)', () => {
  withEnv({ ...NEUTRAL, VAS_ALLOWLIST_ELECTRICITY: PILOT }, () => {
    assert.equal(isCapabilityLiveFor('ELECTRICITY', { waId: PILOT }), true);
    assert.equal(isCapabilityLiveFor('ELECTRICITY', { waId: OTHER }), false);
    assert.equal(isCapabilityLiveFor('AIRTIME', { waId: OTHER }), true, 'other categories untouched');
  });
  withEnv({ ...NEUTRAL }, () => {
    assert.equal(isCapabilityLiveFor('ELECTRICITY', { waId: OTHER }), true);
  });
});

test('VOUCHER_LOAD is gated the way the OTT load rail is (merchant key present); BUSINESS follows mayRegister', () => {
  withEnv({ ...NEUTRAL }, () => {
    assert.equal(isCapabilityLiveFor('VOUCHER_LOAD', {}), false);
    assert.equal(isCapabilityLiveFor('BUSINESS', { waId: OTHER }), false, 'registration closed by default');
    assert.equal(isCapabilityLiveFor('DEPOSIT_VOUCHER', {}), true, 'the Blu till voucher is always on');
  });
  withEnv({ ...NEUTRAL, OTT_MERCHANT_API_KEY: 'k', WAPAY_BUSINESS_MSISDNS: PILOT }, () => {
    assert.equal(isCapabilityLiveFor('VOUCHER_LOAD', {}), true);
    assert.equal(isCapabilityLiveFor('BUSINESS', { waId: PILOT }), true);
    assert.equal(isCapabilityLiveFor('BUSINESS', { waId: OTHER }), false);
  });
  withEnv({ ...NEUTRAL, WAPAY_BUSINESS_SIGNUPS: 'open' }, () => {
    assert.equal(isCapabilityLiveFor('BUSINESS', { waId: OTHER }), true);
  });
});

// The processor's renderHome copy, verbatim (pages/api/webhooks/message-processor-v2.js).
const HOME_FIXED_HEAD = [
  `🛒 *Buy*: airtime, data, electricity`,
  `💸 *Send*: "send R10 airtime to 083..."`,
  `🙏 *Get Paid*: "please pay me R50" → share your link`,
  `💳 *Deposit*: "deposit R100" or a Blu voucher`,
];
const HOME_TAIL = `📄 *Transactions* · ⚙️ *Settings*`;
const FUEL_ON = `⛽ *Fuel*: "buy fuel" for participating stations`;
const FUEL_OFF = `⛽ *Fuel vouchers*: coming soon`;
const WITHDRAW_ON = `🏧 *Withdraw*: "withdraw R200" to your bank, or cash at an ATM`;
const WITHDRAW_OFF = `🏧 *Withdraw*: coming soon`;

test('homeLines equals renderHome for a non-pilot number and for a pilot number', () => {
  // Everything off: the two coming-soon lines.
  withEnv({ ...NEUTRAL }, () => {
    assert.deepEqual(homeLines({ waId: OTHER }), [...HOME_FIXED_HEAD, FUEL_OFF, WITHDRAW_OFF, HOME_TAIL]);
  });
  // Pilot lists set: the pilot sees both live, everyone else still sees coming soon.
  withEnv({ ...NEUTRAL, WAPAY_PAYOUT_ENABLED: 'true', WAPAY_PAYOUT_ALLOWLIST: PILOT, WAPAY_WICODE_LIVE: 'true', VAS_ALLOWLIST_FUEL: PILOT }, () => {
    assert.deepEqual(homeLines({ waId: PILOT }), [...HOME_FIXED_HEAD, FUEL_ON, WITHDRAW_ON, HOME_TAIL]);
    assert.deepEqual(homeLines({ waId: OTHER }), [...HOME_FIXED_HEAD, FUEL_OFF, WITHDRAW_OFF, HOME_TAIL]);
  });
  // Every home line is a string the processor prints today.
  for (const line of [...HOME_FIXED_HEAD, FUEL_ON, FUEL_OFF, WITHDRAW_ON, WITHDRAW_OFF, HOME_TAIL]) {
    assert.ok(processorSource.includes(line), `renderHome prints: ${line}`);
  }
});

const HELP_HEAD = [
  `💰 *Balance* - "What's my balance?"`,
  `📱 *Airtime* - "Buy R50 airtime"`,
  `📶 *Data* - "Buy 1GB data"`,
  `💡 *Electricity* - "Buy R100 electricity"`,
  `💸 *Send money* - "Send R50 to 083...", or just share a contact from your phone`,
  `💳 *Deposit* - "Deposit R100"`,
  `🎟️ *Voucher* - "Redeem voucher"`,
];
const HELP_WITHDRAW = `🏧 *Withdraw* - "withdraw R200" to your bank or as cash at an ATM`;
const HELP_FUEL = `⛽ *Fuel* - "buy fuel"`;
const HELP_TAIL = `🏪 *Business* - "business account" to get paid by your customers`;

test('helpLines equals the Help Menu lines, with withdraw and fuel only when live', () => {
  withEnv({ ...NEUTRAL }, () => {
    assert.deepEqual(helpLines({ waId: OTHER }), [...HELP_HEAD, HELP_TAIL]);
  });
  withEnv({ ...NEUTRAL, WAPAY_PAYOUT_ENABLED: 'true', WAPAY_PAYOUT_ALLOWLIST: PILOT, WAPAY_WICODE_LIVE: 'true', VAS_ALLOWLIST_FUEL: PILOT }, () => {
    assert.deepEqual(helpLines({ waId: PILOT }), [...HELP_HEAD, HELP_WITHDRAW, HELP_FUEL, HELP_TAIL]);
    assert.deepEqual(helpLines({ waId: OTHER }), [...HELP_HEAD, HELP_TAIL]);
  });
  const helpSrc = processorSource.slice(processorSource.indexOf('const helpMsg = `📋 *WaPay Help Menu*'));
  for (const line of [...HELP_HEAD, HELP_WITHDRAW, HELP_FUEL, HELP_TAIL]) {
    assert.ok(helpSrc.includes(line), `help menu prints: ${line}`);
  }
});

test('promptLines never names a capability the gate says is off, and names every live one', () => {
  const check = (ctx) => {
    const lines = promptLines(ctx);
    const live = capabilitiesFor(ctx);
    assert.equal(lines.length, live.length);
    for (const c of CAPABILITIES) {
      const named = lines.some((l) => l.startsWith(`- ${c.label}:`));
      assert.equal(named, isCapabilityLiveFor(c.id, ctx), `${c.id} named=${named}`);
    }
    for (const l of lines) assert.match(l, /^- .+: .+ Start: ".+"\. .+$/);
  };
  withEnv({ ...NEUTRAL }, () => {
    check({ waId: OTHER });
    assert.ok(!promptLines({ waId: OTHER }).some((l) => /withdraw|fuel/i.test(l)), 'off: withdraw and fuel unnamed');
  });
  withEnv({ ...NEUTRAL, WAPAY_PAYOUT_ENABLED: 'true', WAPAY_PAYOUT_ALLOWLIST: PILOT, WAPAY_WICODE_LIVE: 'true', VAS_ALLOWLIST_FUEL: PILOT, OTT_MERCHANT_API_KEY: 'k' }, () => {
    check({ waId: PILOT });
    check({ waId: OTHER });
    assert.ok(promptLines({ waId: PILOT }).some((l) => l.startsWith('- Withdraw:') && /PayShap/.test(l)), 'live withdraw line carries the fee');
    assert.ok(!promptLines({ waId: OTHER }).some((l) => l.startsWith('- Withdraw:')));
  });
});

test('fee lines come from feeSchedule and limits from the flows', () => {
  assert.match(capabilityById('DEPOSIT_CARD').feeLine(), /4\.2% \+ R2\.30/);
  assert.match(capabilityById('DEPOSIT_VOUCHER').feeLine(), /keeps 6%.*adds R94/);
  assert.match(capabilityById('SEND').feeLine(), /Free to another WaPay user.*R3 flat/);
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
    assert.ok(lines.length >= 4 && lines.length <= 6);
    assert.ok(!lines.some((l) => /withdraw|fuel/i.test(l)));
  });
  withEnv({ ...NEUTRAL, WAPAY_PAYOUT_ENABLED: 'true', WAPAY_PAYOUT_ALLOWLIST: PILOT }, () => {
    assert.ok(!welcomeLines().some((l) => /withdraw/i.test(l)), 'a pilot list is not "everyone"');
  });
  withEnv({ ...NEUTRAL, WAPAY_PAYOUT_ENABLED: 'true', WAPAY_WICODE_LIVE: 'true' }, () => {
    const lines = welcomeLines();
    assert.ok(lines.some((l) => /withdraw/i.test(l)));
    assert.ok(lines.some((l) => /participating Shell and Engen stations/.test(l)));
  });
});

test('no betting words and no em dashes anywhere in descriptor text or rendered lines', () => {
  const texts = [];
  for (const c of CAPABILITIES) texts.push(c.label, c.oneLiner, c.startCommand, c.example, c.comingSoonLine || '', c.helpLine || '', c.feeLine());
  withEnv({ ...NEUTRAL, WAPAY_PAYOUT_ENABLED: 'true', WAPAY_WICODE_LIVE: 'true', OTT_MERCHANT_API_KEY: 'k', WAPAY_BUSINESS_SIGNUPS: 'open' }, () => {
    for (const c of CAPABILITIES) texts.push(c.feeLine());
    texts.push(...homeLines({ waId: OTHER }), ...helpLines({ waId: OTHER }), ...promptLines({ waId: OTHER }), ...welcomeLines());
  });
  for (const t of texts) {
    assert.ok(!/bet|wager|casino|odds/i.test(t), `betting word in: ${t}`);
    assert.ok(!/[—–]/.test(t), `dash in: ${t}`);
  }
});
