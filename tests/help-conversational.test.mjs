/**
 * Help-menu fallback regression guards (founder screenshot 2026-08-29:
 * "Where can I spend my WaPay money!" got the bare Help Menu, twice).
 *
 * Locks the three layers of the fix:
 * 1. The orchestrator prompts reserve HELP for explicit menu asks — a
 *    question with a subject must reach a conversational specialist.
 * 2. The processor's HELP dispatch answers question-shaped input with a
 *    real, warm spend-destinations reply; the menu only for explicit asks.
 * 3. The spend catalogue is data-driven, claim-gated on the wiCode
 *    production flag, betting-free, em-dash-free, and never date-promises.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildSpendDestinationsReply,
  buildBrainKnowledge,
  cashoutScript,
  redemptionGuide,
  catalogue,
  advertisedFuelPartners,
} from '../lib/spend-catalogue.js';

const processorSource = readFileSync(
  fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)),
  'utf8'
);
const engineSource = readFileSync(
  fileURLToPath(new URL('../packages/ai/src/orchestrator.ts', import.meta.url)),
  'utf8'
);

/** The HELP case body inside dispatchOrchestratorAction. */
function helpCaseSource() {
  const dispatchStart = processorSource.indexOf('async function dispatchOrchestratorAction');
  const start = processorSource.indexOf("case 'HELP'", dispatchStart);
  assert.ok(start > -1, "dispatch must keep a case 'HELP'");
  const end = processorSource.indexOf("case 'HOME'", start);
  assert.ok(end > start);
  return processorSource.slice(start, end);
}

// ---------------------------------------------------------------------------
// 1. Orchestrator prompts
// ---------------------------------------------------------------------------

test('fast-path HELP is reserved for explicit menu asks; subject questions go to a specialist', () => {
  assert.match(engineSource, /HELP: ONLY a bare, explicit ask for the menu/);
  assert.match(engineSource, /A question WITH A SUBJECT is never HELP/);
  assert.match(engineSource, /where can I spend my money/i, 'the founder phrasing is a named counter-example');
});

test('CHAT agent never answers a capability question with HELP', () => {
  assert.match(engineSource, /HELP: ONLY when the user explicitly asks for the help menu/);
  assert.match(engineSource, /is NEVER HELP/);
});

test('the Pay persona mandates warmth and emoji in every reply', () => {
  assert.match(engineSource, /PERSONALITY — you are "Pay"/);
  assert.match(engineSource, /Every reply carries one or two fitting emoji/);
  assert.match(engineSource, /Never use em or en dashes/);
});

test('the engine accepts injected knowledge and threads it into tier-2 prompts', () => {
  assert.match(engineSource, /OrchestrateOptions/);
  assert.match(engineSource, /agentPrompt\(tier1\.domain, opts\.knowledge\)/);
  assert.match(engineSource, /LIVE PRODUCT KNOWLEDGE/);
});

test('cash-out truth: coming soon, never a date, never the partner name, KYC at withdrawal only', () => {
  assert.match(engineSource, /not available YET/);
  assert.match(engineSource, /COMING SOON through our payouts partner/);
  assert.match(engineSource, /NEVER promise a date or name the partner/);
  assert.match(engineSource, /Identity verification will apply to withdrawals only/);
  assert.match(engineSource, /SPEND-ONLY/, 'the spend-only doctrine survives the rewrite');
  assert.match(engineSource, /CANNOT be exchanged for cash/, 'the OTT written answer survives');
});

// ---------------------------------------------------------------------------
// 2. Processor HELP dispatch
// ---------------------------------------------------------------------------

test('HELP dispatch: question-shaped input gets the spend answer, not the menu', () => {
  const helpCase = helpCaseSource();
  assert.match(helpCase, /explicitMenuAsk/, 'the explicit-menu gate exists');
  assert.match(
    helpCase,
    /buildSpendDestinationsReply\(\{ wicodeLive: fuelLiveFor\(from\) \}\)/,
    'the fallback answer is the data-driven spend reply, claim-gated per user'
  );
  assert.match(helpCase, /looksLikeReceipt\(reply\)/, 'a composed reply still passes the receipt guard');
  // The menu must be gated BEHIND the explicit-ask check, not before it.
  const gateAt = helpCase.indexOf('explicitMenuAsk');
  const menuAt = helpCase.indexOf('WaPay Help Menu');
  assert.ok(gateAt > -1 && menuAt > gateAt, 'the menu renders only after the explicit-ask gate');
  // The explicit gate itself only fires on bare commands.
  const gateMatch = helpCase.match(/const explicitMenuAsk = (\/.*\/i)\.test/);
  assert.ok(gateMatch, 'explicitMenuAsk is a plain one-line regex');
  // eslint-disable-next-line no-new-func
  const gate = new Function(`return ${gateMatch[1]};`)();
  assert.ok(gate.test('help'));
  assert.ok(gate.test('menu'));
  assert.ok(gate.test('  Options '));
  assert.ok(!gate.test('Where can I spend my WaPay money!'), 'the founder message is never a menu ask');
  assert.ok(!gate.test('how does WaPay work?'));
  assert.ok(!gate.test('who accepts wapay'));
});

test('the brain is fed the claim-gated spend knowledge on every AI turn, per user', () => {
  assert.match(
    processorSource,
    /knowledge: buildBrainKnowledge\(\{ wicodeLive: fuelLiveFor\(from\) \}\)/
  );
  // The helper composes the production flag with the pilot allowlist.
  assert.match(processorSource, /function fuelLiveFor\(waId\) \{\s*return isCategoryEnabledForWaId\('FUEL', waId\);/);
});

test('how-to-SPEND voucher questions reach the AI; list asks stay on deterministic history', () => {
  assert.ok(
    /!\/\\b\(\?:spend\|use\|redeem\)\\b/.test(processorSource),
    'the voucher-history intercept carries the narrowed how-to-spend exclusion'
  );
  // Behavioral: rebuild the shipped regexes and drive them (narrowed after
  // the 2026-08-29 review: list asks must NOT divert to an AI that has no
  // voucher-history action).
  const history = /(?:\b(?:my|show|list)\b[^\n]{0,20}\bvouchers?\b)|voucher history/i;
  const howTo = /\b(?:spend|use|redeem)\b[^\n]{0,30}\bvouchers?\b/i;
  const goesToHistory = (t) => history.test(t) && !/\d{6,}/.test(t) && !howTo.test(t);
  assert.ok(goesToHistory('my vouchers'));
  assert.ok(goesToHistory('show my vouchers'));
  assert.ok(goesToHistory('voucher history'));
  assert.ok(goesToHistory('Where are my vouchers?'), 'a list ask stays deterministic');
  assert.ok(goesToHistory('how do I see my vouchers'), 'a see-my-list ask stays deterministic');
  assert.ok(!goesToHistory('Where can I spend my voucher?'), 'how-to-spend asks reach the AI');
  assert.ok(!goesToHistory('how do I use my voucher'));
});

test('a product question about something we do not sell reaches the AI, not the product dump', () => {
  // The no-match branch of handleSmartProductQuery: concrete residue → AI
  // (claim-gated knowledge answers "can I buy petrol?"); bare browse asks
  // keep the list; the AI→dispatch path never recurses (viaAi).
  assert.match(processorSource, /viaAi = false/);
  assert.match(processorSource, /if \(residue && !viaAi\) \{\s*\n\s*return await handleAIChat\(\{ from, text, account \}\);/);
  assert.match(processorSource, /handleSmartProductQuery\(\{ from, account, text: result\.slots\.productQuery, entities: \{\}, viaAi: true \}\)/);
  // Behavioral: rebuild the shipped residue strip and drive it.
  const m = processorSource.match(/const residue = lowerText\s*\n\s*\.replace\((\/.*\/gi), ' '\)/);
  assert.ok(m, 'residue strip is a one-line regex');
  // eslint-disable-next-line no-new-func
  const frame = new Function(`return ${m[1]};`)();
  const residueOf = (t) =>
    t.toLowerCase().replace(frame, ' ').replace(/[^a-z]/gi, ' ').trim();
  assert.equal(residueOf('what can i buy'), '', 'bare browse ask keeps the product list');
  assert.equal(residueOf('what are your prices?'), '');
  assert.ok(residueOf('can i buy petrol with wapay') !== '', 'petrol survives → AI answers');
  assert.ok(residueOf('do you sell groceries') !== '', 'groceries survives → AI answers');
});

// ---------------------------------------------------------------------------
// 3. Spend catalogue — data, gating, policy
// ---------------------------------------------------------------------------

const BETTING_WORDS = /\b(bet|bets|betting|gambl\w*|bookmaker|hollywoodbets|lottostar|wager\w*)\b/i;
const DATE_PROMISES = /\b(january|february|march|april|may|june|july|august|september|october|november|december|20\d\d|next (week|month|year)|by (the )?end of)\b/i;

test('catalogue copy: no betting words, no em dashes, no date promises, ever', () => {
  const surfaces = [
    buildSpendDestinationsReply({ wicodeLive: false }),
    buildSpendDestinationsReply({ wicodeLive: true }),
    buildBrainKnowledge({ wicodeLive: false }),
    buildBrainKnowledge({ wicodeLive: true }),
    cashoutScript(),
    redemptionGuide('FUEL_WICODE'),
    redemptionGuide('RETAIL_WICODE'),
    redemptionGuide('OTT'),
  ];
  for (const s of surfaces) {
    assert.ok(!BETTING_WORDS.test(s), `betting words banned in: ${s.slice(0, 60)}`);
    assert.ok(!/[–—]/.test(s), `em/en dashes banned in: ${s.slice(0, 60)}`);
    assert.ok(!DATE_PROMISES.test(s), `date promises banned in: ${s.slice(0, 60)}`);
  }
});

test('test mode (flag off): fuel/retail are coming soon, never claimed redeemable', () => {
  const reply = buildSpendDestinationsReply({ wicodeLive: false });
  assert.match(reply, /Coming soon/i);
  assert.ok(!/participating stations:/.test(reply), 'no live fuel line while gated');
  const knowledge = buildBrainKnowledge({ wicodeLive: false });
  assert.match(knowledge, /COMING SOON, NOT LIVE/);
  assert.match(knowledge, /NEVER claim they can be redeemed/);
});

test('live mode: fuel claims carry the participating-stations caveat, never "any station"', () => {
  const reply = buildSpendDestinationsReply({ wicodeLive: true });
  assert.match(reply, /participating stations/i);
  assert.match(reply, /Shell \(about 85% of stations/);
  assert.match(reply, /Engen/);
  assert.ok(!/any station\b/i.test(reply));
  assert.ok(!/TotalEnergies|Total\b/.test(reply), 'a non-onboarded partner is never advertised');
});

test('the catalogue is data: partners come from the structure, not the copy', () => {
  const cat = catalogue();
  assert.ok(Array.isArray(cat.fuel) && cat.fuel.length >= 2);
  assert.ok(Array.isArray(cat.retail));
  const advertised = advertisedFuelPartners().map((p) => p.name);
  assert.deepEqual(advertised, ['Shell', 'Engen']);
  const total = cat.fuel.find((p) => p.name === 'TotalEnergies');
  assert.equal(total?.onboarded, false, 'Total stays unadvertised until onboarded');
});

test('the env JSON override extends the catalogue without code changes', () => {
  const prev = process.env.WAPAY_WICODE_CATALOGUE_JSON;
  try {
    process.env.WAPAY_WICODE_CATALOGUE_JSON = JSON.stringify({
      retail: [{ name: 'Test Store', advertised: true }],
    });
    const cat = catalogue();
    assert.equal(cat.retail[0].name, 'Test Store');
    assert.equal(cat.fuel.length, 3, 'unoverridden keys keep their defaults');
    process.env.WAPAY_WICODE_CATALOGUE_JSON = '{not json';
    assert.ok(Array.isArray(catalogue().fuel), 'malformed JSON falls back to defaults');
  } finally {
    if (prev === undefined) delete process.env.WAPAY_WICODE_CATALOGUE_JSON;
    else process.env.WAPAY_WICODE_CATALOGUE_JSON = prev;
  }
});

test('cash-out script: coming soon, no dates, and redirects to live spending', () => {
  const s = cashoutScript();
  assert.match(s, /not available just yet/i);
  assert.match(s, /coming soon/i);
  assert.match(s, /Airtime and data/i, 'redirects to what works today');
  // The payout partner is never named to customers. "OTT" as the VOUCHER
  // network ("stores that accept OTT vouchers") is existing public copy and
  // allowed; the payout rail must stay a generic "payouts partner".
  assert.ok(!/PayShap/i.test(s));
  assert.ok(!/OTT payout|payouts? (?:with|via|through) OTT/i.test(s));
});

test('fuel redemption guide: wiCode mechanics + partial redemption, no bearer secrets', () => {
  const g = redemptionGuide('FUEL_WICODE');
  assert.match(g, /participating station/i);
  assert.match(g, /BEFORE they start filling up/i);
  assert.match(g, /fresh code for what is left/i, 'partial redemption behaviour explained');
  assert.ok(!/\d{6,}/.test(g), 'no code-shaped digits in the guide');
});
