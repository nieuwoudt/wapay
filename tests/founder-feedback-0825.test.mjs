/**
 * Founder live-test feedback batch (2026-08-25):
 * - deterministic surfaces answer in the USER'S language (localize layer:
 *   money/codes frozen, fail-open to English, cached);
 * - "speak <language>" sets the preference permanently and confirms in
 *   that language — for all 11 official languages;
 * - a clearly-stated NEW intent escapes ANY waiting state (family-aware:
 *   in-flow answers never escape; PIN digits never look like intents);
 * - "please pay me R50 from <number|name>" delivers the request straight
 *   into a WaPay payer's chat as the existing PAYREQ_CONFIRM flow — never
 *   hijacking a payer who is mid-flow, and falling back to the link;
 * - "buy 100 minutes" clarifies rand-vs-minutes instead of equating;
 * - pay links are pleasepayme.co.za/<code> (founder decision) and the pay
 *   page greets with the phrase while the product stays WaPay-branded.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { matchLanguageSwitch, LANGUAGE_CONFIRMATIONS, localizeOutbound } from '../lib/localize.js';
import { paymentRequestUrl } from '../lib/payment-requests.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const processorSource = read('../pages/api/webhooks/message-processor-v2.js');
const localizeSource = read('../lib/localize.js');
const payPageSource = read('../pages/pay/[code].js');

// ---------------------------------------------------------------------------
// Language switching
// ---------------------------------------------------------------------------

test('language switch: founder-observed phrasings all resolve', () => {
  assert.equal(matchLanguageSwitch('Speak me me I Xhosa on how to do this'), 'xh');
  assert.equal(matchLanguageSwitch('please talk zulu'), 'zu');
  assert.equal(matchLanguageSwitch('khuluma isizulu'), 'zu');
  assert.equal(matchLanguageSwitch('praat afrikaans'), 'af');
  assert.equal(matchLanguageSwitch('talk sepedi'), 'nso');
  assert.equal(matchLanguageSwitch('switch to setswana please'), 'tn');
  assert.equal(matchLanguageSwitch('English'), 'en');
});

test('language switch: ordinary talk and object-verb phrasings NEVER match', () => {
  // Abuse review 2026-08-25: these once matched and swallowed the message.
  for (const text of [
    'I want to buy data',
    'send R50 to my sister',
    'please pay me R50',
    'what is my balance',
    'reply to my sister in Xhosa',
    'please change my Zulu voucher',
    'answer me about my Ndebele voucher',
    'I use Sesotho at home',
  ]) {
    assert.equal(matchLanguageSwitch(text), null, `must NOT match: "${text}"`);
    assert.equal(matchLanguageSwitch(text, { inFlow: true }), null, `must NOT match mid-flow: "${text}"`);
  }
});

test('language switch: a bare language name is a switch only when NOT mid-flow', () => {
  assert.equal(matchLanguageSwitch('isixhosa'), 'xh');
  assert.equal(matchLanguageSwitch('isixhosa', { inFlow: true }), null, 'a surname answer mid-flow is not a switch');
  // The founder's exact awkwardly-transcribed message must still work.
  assert.equal(matchLanguageSwitch('Speak me me I Xhosa on how to do this'), 'xh');
});

test('every official language has a native confirmation', () => {
  for (const code of ['en', 'af', 'zu', 'xh', 'st', 'tn', 'nso', 'ts', 've', 'ss', 'nr']) {
    assert.ok(LANGUAGE_CONFIRMATIONS[code], `missing confirmation for ${code}`);
  }
});

test('processor: the language ask is intercepted before the onboarding gate, with the in-flow signal', () => {
  const intercept = processorSource.indexOf('matchLanguageSwitch(text, { inFlow');
  const gate = processorSource.indexOf("if (onboardingState !== 'S5_COMPLETED')");
  assert.ok(intercept > -1 && intercept < gate, 'runs before the onboarding gate');
  assert.match(processorSource, /matchLanguageSwitch\(text, \{ inFlow: Boolean\(activeState\) \}\)/, 'a bare surname mid-flow is not a switch');
  assert.match(processorSource, /setLanguage\(\{ accountId: account\.id, language: langAsk \}\)/);
});

// ---------------------------------------------------------------------------
// Localization safety
// ---------------------------------------------------------------------------

test('localize: English and unknown languages pass through untouched (no API call)', async () => {
  const text = 'Hello *world* R50';
  assert.equal(await localizeOutbound(text, 'en'), text);
  assert.equal(await localizeOutbound(text, null), text);
  assert.equal(await localizeOutbound(text, 'fr'), text);
});

test('localize: money, codes, links and numbers are frozen before translation', () => {
  assert.match(localizeSource, /PR\[A-Z\]\{6\}/, 'request codes frozen');
  assert.match(localizeSource, /https\?/, 'URLs frozen');
  assert.match(localizeSource, /0\\d\{9\}/, 'phone numbers frozen');
  assert.match(localizeSource, /localize_placeholder_lost/, 'a translation that loses a frozen token never ships');
  assert.match(localizeSource, /return text;\s*\n\s*\}\s*\n\s*\}/, 'fail-open to English');
});

test('processor: founder-hit surfaces are localized', () => {
  assert.match(processorSource, /localizeOutbound\(home, await userLang\(account\)\)/, 'home menu');
  assert.match(processorSource, /localizeOutbound\(helpMsg, await userLang\(account\)\)/, 'help menu');
  const airtimeWrapped = [...processorSource.matchAll(/localizeOutbound\(`📱 \*(?:Buy )?R\$\{/g)].length;
  assert.ok(airtimeWrapped >= 3, `airtime prompts localized (got ${airtimeWrapped})`);
});

// ---------------------------------------------------------------------------
// Universal intent-switch escape
// ---------------------------------------------------------------------------

function extractSwitch() {
  const start = processorSource.indexOf('function detectStrongIntentSwitch(');
  const end = processorSource.indexOf('\n}', start);
  const preamble = `
    const DEPOSIT_CARD_PATTERN = /\\b(?:deposit|depsit|deposite|diposit)\\b(?:\\s+(?:money|funds|cash))?\\s*[:,-]?\\s*r?\\s*(\\d+(?:[.,]\\d{1,2})?)(?:\\s*(?:rand|rande|zar))?\\b/i;
    const PAY_REQUEST_CODE_PATTERN = /\\bpay\\s+request\\s+(PR[A-HJKMNP-Z]{6})\\b/i;
    const RECEIPT_CODE_PATTERN = /^\\s*receipt\\s+(PR[A-HJKMNP-Z]{6})\\s*[.!]?\\s*$/i;
    const matchRequestMoneyAsk = (t) => /\\b(please\\s+)?pay\\s?-?\\s?me\\b/i.test(t) || /\\bget\\s+paid\\b/i.test(t);
    const matchOttVoucherSelfRequest = (t) => /\\bott\\s*vouchers?\\b/i.test(t) && !/\\b(redeem\\w*|have|my)\\b/i.test(t);
  `;
  // eslint-disable-next-line no-new-func
  return new Function(`${preamble}; ${processorSource.slice(start, end + 2)}; return detectStrongIntentSwitch;`)();
}

test('escape: a NEW intent breaks out of an unrelated waiting state', () => {
  const sw = extractSwitch();
  assert.ok(sw('I want to buy data', 'AIRTIME_MSISDN'), 'data ask escapes the airtime flow');
  assert.ok(sw('buy R50 airtime', 'VOUCHER_GIFT_AMOUNT'), 'airtime ask escapes send-money');
  assert.ok(sw('deposit R100', 'AIRTIME_AMOUNT'), 'deposit escapes airtime');
  assert.ok(sw('please pay me R50', 'DATA_NETWORK'), 'get-paid escapes data');
  assert.ok(sw('what is my balance', 'ELECTRICITY_METER'), 'balance ask escapes electricity');
});

test('escape: in-flow answers NEVER escape their own flow', () => {
  const sw = extractSwitch();
  assert.equal(sw('0781234567', 'AIRTIME_MSISDN'), null, 'a phone number is the answer, not an intent');
  assert.equal(sw('R150', 'REQUEST_MONEY_AMOUNT'), null, 'an amount is the answer');
  assert.equal(sw('buy R50 airtime', 'AIRTIME_AMOUNT'), null, 'same family stays');
  assert.equal(sw('yes', 'AIRTIME_CONFIRM'), null);
  assert.equal(sw('MTN', 'DATA_NETWORK'), null);
  assert.equal(sw('12345', 'AIRTIME_PIN'), null, 'PIN-shaped input is never an intent');
  assert.equal(sw('buy a data bundle', 'DATA_PERIOD'), null, 'data ask inside the data flow stays');
});

test('escape: wired at the single state-dispatch site, clearing state first', () => {
  assert.match(processorSource, /detectStrongIntentSwitch\(text, state\)/);
  assert.match(processorSource, /state_escape_intent_switch/);
  const idx = processorSource.indexOf('state_escape_intent_switch');
  const after = processorSource.slice(idx, idx + 300);
  assert.match(after, /updateConversationState\(from, null\)/, 'state cleared before fresh routing');
});

// ---------------------------------------------------------------------------
// Directed WaPay-to-WaPay requests — SAFE design (abuse review 2026-08-25)
// ---------------------------------------------------------------------------

test('directed requests: reachable ONLY through the requester\'s saved beneficiaries', () => {
  const fn = processorSource.indexOf('async function resolveDirectedRequestTarget(');
  const body = processorSource.slice(fn, processorSource.indexOf('\n}', fn));
  // The phone-number branch must gate on isSavedBeneficiary — no raw-number
  // targeting (that was a phishing + customer-enumeration vector).
  assert.match(body, /isSavedBeneficiary\(\{ accountId: account\.id, msisdn: digits \}\)/);
  assert.match(body, /S5_COMPLETED'\) return null/, 'only fully-onboarded payers');
  assert.match(body, /label: maskMsisdn\(msisdn\)/, 'label is a masked number, never the payer\'s profile name');
});

test('directed requests: delivery is INFORMATIONAL — never writes the payer\'s state', () => {
  const fn = processorSource.indexOf('async function deliverDirectedRequest(');
  const body = processorSource.slice(fn, processorSource.indexOf('\n}', fn));
  assert.ok(!body.includes('updateConversationState'), 'a directed send must NEVER set another user\'s conversation state');
  assert.match(body, /pay request \$\{request\.id\}/, 'the payer opts in by typing the code — their own explicit action');
  assert.match(body, /safeRequesterLabel\(requesterLabel\)/, 'the requester label is sanitised (spoofable profile name)');
  assert.ok(!body.includes('buildSend'), 'delivery moves NO money');
});

test('directed requests: the requester label is stripped of markdown/control chars', () => {
  const fn = processorSource.indexOf('function safeRequesterLabel(');
  const body = processorSource.slice(fn, processorSource.indexOf('\n}', fn));
  assert.match(body, /replace\(\/\[\*_~`>/, 'strips * _ ~ ` > and newlines so a name cannot impersonate a system message');
  assert.match(body, /slice\(0, 24\)/, 'hard length cap');
});

test('directed requests: the requester response is NEUTRAL (no membership oracle)', () => {
  const idx = processorSource.indexOf('const delivered = await deliverDirectedRequest(');
  const around = processorSource.slice(idx, idx + 700);
  // Both branches still hand back the shareable link; a non-member simply
  // gets the standard created-message — indistinguishable enough that you
  // cannot probe arbitrary numbers for WaPay membership.
  assert.match(around, /Here's the link too/);
  assert.match(around, /Payment request created/);
});

test('directed requests: "from my phone/work" never resolves as a name', () => {
  const fn = processorSource.indexOf('async function resolveDirectedRequestTarget(');
  const body = processorSource.slice(fn, processorSource.indexOf('\n}', fn));
  assert.match(body, /\(me\|my\|phone\|work\|home\|bank\|card\|wallet\|app\|whatsapp\)/);
});

// ---------------------------------------------------------------------------
// Minutes vs rand + link base + page phrase
// ---------------------------------------------------------------------------

test('minutes are clarified, never silently equated to rand', () => {
  assert.match(processorSource, /min\(\?:ute\)\?s\?/, 'minutes pattern present');
  assert.match(processorSource, /Airtime is sold in \*rand\*, not minutes/);
});

test('pay links are pleasepayme.co.za (founder decision 2026-08-25)', () => {
  assert.equal(paymentRequestUrl('PRKWXQZM'), 'https://pleasepayme.co.za/PRKWXQZM');
});

test('pay page greets with the phrase; the product stays WaPay-branded', () => {
  assert.match(payPageSource, /Please pay me/);
  assert.match(payPageSource, /with WaPay/);
  assert.match(payPageSource, /processed\s+securely by PayFast/);
});

// ---------------------------------------------------------------------------
// Localization freeze/thaw order safety (abuse review 2026-08-25)
// ---------------------------------------------------------------------------

test('thaw: a reordered placeholder sequence is rejected (never inverts R5–R3000)', () => {
  // Exercise the exported behaviour via the module's own guard. We can only
  // reach thaw through localizeOutbound; assert the source enforces order.
  assert.match(localizeSource, /if \(seq\.length !== frozen\.length\) return null/);
  assert.match(localizeSource, /if \(seq\[i\] !== i\) return null/, 'exact order enforced');
});
