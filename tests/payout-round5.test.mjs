/**
 * Withdrawals, round 5 (2026-10-12, the Lisa case: a foreign national with a
 * Capitec account received R350 and could not get it out). One file for the
 * round's locks, in the order the founder approved them:
 *   1. a passport or foreign ID at the ID step, with the issuing country, on
 *      the wire as id_type / country_of_issue / nationality (an SA ID goes
 *      exactly as before), saved encrypted, never stored in memory whole.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseIdDocument, parseCountry, countryName, startWithdraw, handleWithdrawReply, executeWithdraw } from '../lib/payout-chat.js';
import { cleanRecipient, passportIdType } from '../lib/payouts.js';
import { OttPayoutClient, payoutHash } from '../lib/ott-payout.js';
import { redactForMemory } from '../lib/turns.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const LIVE = [
  { method: 'PAYSHAP', providerCode: '66', providerName: 'PayShap Account', minCents: 5000, maxCents: 15000000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile', 'account_number', 'branch_code'] },
  { method: 'CASHSEND', providerCode: '67', providerName: 'ABSA CashSend', minCents: 5000, maxCents: 10000000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
  { method: 'NEDCASH', providerCode: '4', providerName: 'Nedbank Cardless Withdrawal', minCents: 1000, maxCents: 500000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
];
// Lisa: KYC off, no SA ID, R350 to spend, nothing saved.
const lisa = { id: 'acc-lisa', msisdn: '27601879361', waId: '27601879361', displayName: 'Lisa', profile: {} };
function envOff() { process.env.WAPAY_PAYOUT_ENABLED = 'true'; process.env.WAPAY_PAYOUT_KYC = 'off'; delete process.env.WAPAY_PAYOUT_PASSPORT_ID_TYPE; }
const deps = (totalCents = 35000) => {
  const obj = {
    payoutBalances: async () => ({ spendCents: totalCents, cashCents: 0, totalCents }),
    resolveProviders: async () => LIVE,
    beneficiariesAvailable: () => true,
    requestPayout: async (args) => { obj.last = args; return { ok: true, status: 'PENDING', reference: 'WPLISA', amountCents: args.amountCents, feeCents: 800, outcome: 'PENDING_FINALISATION' }; },
  };
  return obj;
};

test('1. parseIdDocument: 13 digits is an SA ID; 6 to 12 letters and digits with a digit is a passport or foreign ID; words are neither', () => {
  assert.deepEqual(parseIdDocument('9001015009087'), { idType: 'RSAID', idNumber: '9001015009087' });
  assert.deepEqual(parseIdDocument('900101 5009 087'), { idType: 'RSAID', idNumber: '9001015009087' });
  assert.deepEqual(parseIdDocument('FN123456'), { idType: 'PASSPORT', idNumber: 'FN123456' });
  assert.deepEqual(parseIdDocument('my passport is fn 123456'), { idType: 'PASSPORT', idNumber: 'FN123456' });
  assert.deepEqual(parseIdDocument('AB12C345'), { idType: 'PASSPORT', idNumber: 'AB12C345' });
  for (const t of ['passport', 'Zimbabwe', 'I do not have one', 'FN1', 'ABCDEFGH', '', 'A1234567890123']) assert.equal(parseIdDocument(t), null, t);
});

test('1. parseCountry: names, demonyms, three-letter names in a sentence and the two-letter code; nothing else', () => {
  const cases = { Zimbabwe: 'ZW', zim: 'ZW', 'I am Malawian': 'MW', 'from the DRC': 'CD', Congo: 'CD', 'congo brazzaville': 'CG', ZW: 'ZW', uk: 'GB', 'Moçambique': 'MZ', 'its in RSA': 'ZA', 'South Africa': 'ZA', Lesotho: 'LS', Nigerian: 'NG' };
  for (const [t, cc] of Object.entries(cases)) assert.equal(parseCountry(t), cc, t);
  for (const t of ['Narnia', 'no', 'sa please', '', 'okay']) assert.equal(parseCountry(t), null, t);
  assert.equal(countryName('ZW'), 'Zimbabwe'); assert.equal(countryName('cd'), 'DR Congo');
});

test('1. the ID step takes a passport, asks the issuing country, confirms it masked, and the rail gets id_type, country_of_issue and nationality', async () => {
  envOff();
  const d = deps();
  const s0 = await startWithdraw({ account: lisa, ask: { amountCents: 5000, method: 'PAYSHAP' }, deps: d });
  assert.equal(s0.state, 'PAYOUT_ACCOUNT');
  const s1 = await handleWithdrawReply({ account: lisa, state: s0.state, data: s0.data, text: '1234567890' });
  const s2 = await handleWithdrawReply({ account: lisa, state: s1.state, data: s1.data, text: 'Capitec' });
  assert.equal(s2.state, 'PAYOUT_NAME');
  const s3 = await handleWithdrawReply({ account: lisa, state: s2.state, data: s2.data, text: 'Lisa Moyo' });
  assert.equal(s3.state, 'PAYOUT_ID');
  assert.match(s3.text, /13-digit South African ID number, or your passport or foreign ID number/);
  const s4 = await handleWithdrawReply({ account: lisa, state: s3.state, data: s3.data, text: 'FN123456' });
  assert.equal(s4.state, 'PAYOUT_ID'); assert.match(s4.text, /Which country issued that passport or ID\?/);
  assert.ok(!/FN123456/.test(s4.text), 'the number is never echoed');
  const huh = await handleWithdrawReply({ account: lisa, state: s4.state, data: s4.data, text: 'Narnia' });
  assert.equal(huh.state, 'PAYOUT_ID'); assert.match(huh.text, /did not recognise that country/);
  const s5 = await handleWithdrawReply({ account: lisa, state: s4.state, data: s4.data, text: 'Zimbabwe' });
  assert.equal(s5.state, 'PAYOUT_CONFIRM');
  assert.match(s5.text, /Name on the account: Lisa Moyo/); assert.match(s5.text, /Passport \/ foreign ID: •••456 \(Zimbabwe\)/);
  assert.ok(!/FN123456/.test(s5.text)); assert.equal(s5.data.idPending ?? null, null);
  const pin = await handleWithdrawReply({ account: lisa, state: s5.state, data: s5.data, text: 'yes' });
  assert.equal(pin.state, 'PAYOUT_PIN');
  const done = await executeWithdraw({ account: lisa, data: pin.data, deps: d });
  const r = d.last.recipient;
  assert.equal(r.id_number, 'FN123456'); assert.equal(r.id_type, 'PASSPORT'); assert.equal(r.country_of_issue, 'ZW'); assert.equal(r.nationality, 'ZW');
  assert.equal(r.firstname, 'Lisa'); assert.equal(r.surname, 'Moyo');
  assert.equal(done.state, 'PAYOUT_SAVE'); assert.match(done.text, /your name and passport or ID number ending 456/);
  assert.equal(done.data.recipient.id_type, 'PASSPORT'); assert.equal(done.data.recipient.country_of_issue, 'ZW');
  // The answer to OTT's id_type question is a Vercel change, not a deploy.
  process.env.WAPAY_PAYOUT_PASSPORT_ID_TYPE = 'Passport';
  await executeWithdraw({ account: lisa, data: pin.data, deps: d });
  assert.equal(d.last.recipient.id_type, 'Passport'); assert.equal(passportIdType(), 'Passport');
  delete process.env.WAPAY_PAYOUT_PASSPORT_ID_TYPE;
});

test('1. an SA ID still goes without id_type; a 12-digit number from South Africa is sent back as a mistyped ID; 13 digits at the country step is an SA ID', async () => {
  envOff();
  const d = deps();
  const base = { method: 'CASHSEND', amountCents: 5000, intentId: 'wa-r5-sa', options: ['PAYSHAP', 'CASHSEND', 'NEDCASH'], balanceCents: 35000, fields: { CASHSEND: ['id_number', 'mobile'] }, recipient: { mobile: '27601879361', fullName: 'Lisa Moyo' } };
  const sa = await handleWithdrawReply({ account: lisa, state: 'PAYOUT_ID', data: base, text: '9001015009087' });
  assert.equal(sa.state, 'PAYOUT_CONFIRM'); assert.match(sa.text, /ID number: •••087/);
  await executeWithdraw({ account: lisa, data: sa.data, deps: d });
  assert.equal(d.last.recipient.id_number, '9001015009087');
  assert.ok(!('id_type' in d.last.recipient) && !('country_of_issue' in d.last.recipient) && !('nationality' in d.last.recipient), 'the SA ID wire shape proven since 2026-09-23 is unchanged');
  const twelve = await handleWithdrawReply({ account: lisa, state: 'PAYOUT_ID', data: base, text: '900101500908' });
  assert.equal(twelve.state, 'PAYOUT_ID'); assert.match(twelve.text, /country/);
  const back = await handleWithdrawReply({ account: lisa, state: twelve.state, data: twelve.data, text: 'South Africa' });
  assert.equal(back.state, 'PAYOUT_ID'); assert.match(back.text, /A South African ID number has 13 digits/); assert.equal(back.data.idPending, null);
  const fixed = await handleWithdrawReply({ account: lisa, state: twelve.state, data: twelve.data, text: '9001015009087' });
  assert.equal(fixed.state, 'PAYOUT_CONFIRM', 'the full SA ID typed at the country step is taken as the ID');
});

test('1. a saved passport skips the ID step and goes on the wire with its country; saving keeps the kind and the country', async () => {
  envOff();
  const saved = [];
  const base = deps();
  const d = {
    ...base,
    getIdentity: async () => ({ fullName: 'Lisa Moyo', idLast3: '456', idType: 'PASSPORT', countryOfIssue: 'ZW' }),
    loadIdentity: async () => ({ fullName: 'Lisa Moyo', idNumber: 'FN123456', idType: 'PASSPORT', countryOfIssue: 'ZW' }),
    listDestinations: async () => [],
    saveIdentity: async (a) => { saved.push(a); return { ok: true, idLast3: '456' }; },
    saveDestination: async () => ({ ok: true, label: 'Cellphone •••9361' }),
  };
  const s0 = await startWithdraw({ account: lisa, ask: { amountCents: 5000, method: 'NEDCASH' }, deps: d });
  const s1 = await handleWithdrawReply({ account: lisa, state: s0.state, data: s0.data, text: 'mine' });
  assert.equal(s1.state, 'PAYOUT_CONFIRM', 'name and passport are saved: no name or ID step');
  assert.match(s1.text, /Passport \/ foreign ID: •••456 \(Zimbabwe, saved\)/);
  const pin = await handleWithdrawReply({ account: lisa, state: s1.state, data: s1.data, text: 'yes' });
  await executeWithdraw({ account: lisa, data: pin.data, deps: d });
  assert.equal(base.last.recipient.id_number, 'FN123456'); assert.equal(base.last.recipient.id_type, 'PASSPORT'); assert.equal(base.last.recipient.country_of_issue, 'ZW'); assert.equal(base.last.recipient.nationality, 'ZW');
  // Typed this time and saved on YES: the vault is told the kind and the country.
  const typed = { method: 'NEDCASH', amountCents: 5000, intentId: 'wa-r5-save', recipient: { mobile: '27601879361', fullName: 'Lisa Moyo', id_number: 'FN123456', id_type: 'PASSPORT', country_of_issue: 'ZW' } };
  const done = await executeWithdraw({ account: lisa, data: typed, deps: { ...d, getIdentity: undefined, loadIdentity: async () => null } });
  const yes = await handleWithdrawReply({ account: lisa, state: 'PAYOUT_SAVE', data: done.data, text: 'yes', deps: d });
  assert.match(yes.text, /your name and passport or ID number ending 456/);
  assert.deepEqual({ idNumber: saved[0].idNumber, idType: saved[0].idType, countryOfIssue: saved[0].countryOfIssue }, { idNumber: 'FN123456', idType: 'PASSPORT', countryOfIssue: 'ZW' });
});

test('1. cleanRecipient keeps a passport\'s letters and needs its country; the SA ID rule is unchanged; the hash carries the three strings as sent', async () => {
  const p = cleanRecipient('PAYSHAP', { firstname: 'Lisa', surname: 'Moyo', id_number: 'fn-123456', id_type: 'PASSPORT', country_of_issue: 'zw', nationality: 'zw', mobile: '0601879361', account_number: '1234567890', branch_code: '470010' });
  assert.equal(p.id_number, 'FN123456'); assert.equal(p.country_of_issue, 'ZW'); assert.equal(p.nationality, 'ZW');
  assert.throws(() => cleanRecipient('PAYSHAP', { firstname: 'Lisa', surname: 'Moyo', id_number: 'FN123456', id_type: 'PASSPORT', mobile: '0601879361', account_number: '1234567890', branch_code: '470010' }), (e) => e.code === 'BAD_RECIPIENT' && e.field === 'country_of_issue');
  assert.throws(() => cleanRecipient('NEDCASH', { firstname: 'A', surname: 'B', id_number: '900101500908', mobile: '0601879361' }), (e) => e.field === 'id_number', 'an SA ID is still 13 digits');
  assert.throws(() => cleanRecipient('NEDCASH', { firstname: 'A', surname: 'B', id_number: 'FN123456', mobile: '0601879361' }), (e) => e.field === 'id_number', 'without an id_type a passport is refused before the rail, never sent as digits');
  // The wire and the hash: OTT hashes the strings we send (absent optionals as "", bank_id as "0").
  const API_KEY = 'k-test';
  const c = new OttPayoutClient({ baseUrl: 'https://test-payoutapi.ott-mobile.com', username: 'u', password: 'p', apiKey: API_KEY, timeoutMs: 2000 });
  const seen = {};
  const prev = global.fetch;
  global.fetch = async (url, init) => { seen.body = JSON.parse(init.body); return { status: 200, text: async () => JSON.stringify({ status: 99, message: 'pending', paymentReference: 1 }) }; };
  try { await c.performPayout({ amountCents: 5000, providerCode: 66, providerName: 'PayShap Account', recipient: p, yourUniqueReference: 'WPR5' }); } finally { global.fetch = prev; }
  assert.equal(seen.body.recipient.id_type, 'PASSPORT'); assert.equal(seen.body.recipient.country_of_issue, 'ZW'); assert.equal(seen.body.recipient.nationality, 'ZW'); assert.equal(seen.body.recipient.id_number, 'FN123456');
  const expected = payoutHash(['', '1234567890', '50.00', '0', '', '470010', 'ZW', '', '', 'Lisa', 'FN123456', 'PASSPORT', '', '27601879361', 'ZW', 66, 'PayShap Account', 'Moyo', '', '', 'WPR5'], API_KEY);
  assert.equal(seen.body.hashcheck, expected);
});

test('1. a passport typed at the ID step is never stored whole: the withdraw secret-input rule hides it; the processor no longer logs withdraw data', () => {
  assert.equal(redactForMemory('AB12C345', { secretInput: true }), '[hidden]');
  assert.equal(redactForMemory('my passport is FN 123456', { secretInput: true }).includes('123456'), false);
  assert.equal(redactForMemory('Zimbabwe', { secretInput: true }), 'Zimbabwe', 'the country answer stays readable');
  const src = read('../pages/api/webhooks/message-processor-v2.js');
  assert.match(src, /Handling conversation state:', \{ state, text: \/\^PAYOUT_\/\.test\(state\)/, 'withdraw answers (account and ID numbers) never reach the logs');
});

// ---------------------------------------------------------------------------
// 2. "To my bank account" opens PayShap with the price and the numbers, never
//    the generic menu (founder 2026-10-12: "lets do a withdrawal to my bank
//    account" with R86.50 got the whole menu). Bank words are the bank family;
//    a bank method that is not on the merchant (RTC) maps to the one that is.
// ---------------------------------------------------------------------------
import { matchWithdrawAsk, offeredMethodFor } from '../lib/payout-chat.js';

const OPTS = ['PAYSHAP', 'CASHSEND', 'NEDCASH'];
const founder = { id: 'acc-f', msisdn: '27787051175', waId: '27787051175', displayName: 'Nieuwoudt', profile: {} };

test('2. the matcher reads bank words as the bank family, "cash out" as a withdraw word, "all my money" as all', () => {
  const cases = {
    'lets do a withdrawal to my bank account': { amountCents: null, method: 'PAYSHAP' },
    'I want you to put in my bank account': { amountCents: null, method: 'PAYSHAP' },
    'Put in my bank account': { amountCents: null, method: 'PAYSHAP' },
    'Help me to move in my bank account': { amountCents: null, method: 'PAYSHAP' },
    '"Withdraw "350" from waypay to my account': { amountCents: 35000, method: 'PAYSHAP' },
    'withdraw to my nedbank account': { amountCents: null, method: 'PAYSHAP' },
    'I want to put all my money to my bank account': { amountCents: null, method: 'PAYSHAP', all: true },
    'withdraw 50 nedbank': { amountCents: 5000, method: 'NEDCASH' },
    'Withdraw 50 from ABSA': { amountCents: 5000, method: 'CASHSEND' },
    'cash at atm': { amountCents: null, method: 'CASHSEND' },
    'get my cash out': { amountCents: null, method: null },
    'bank transfer 100': { amountCents: 10000, method: 'RTC' },
  };
  for (const [t, want] of Object.entries(cases)) assert.deepEqual(matchWithdrawAsk(t), want, t);
  assert.equal(offeredMethodFor('RTC', OPTS), 'PAYSHAP', 'a bank method not on the merchant maps to the bank method that is');
  assert.equal(offeredMethodFor('BANK', OPTS), 'PAYSHAP');
  assert.equal(offeredMethodFor('EWALLET', OPTS), null, 'a named bank\'s cash product that is not offered is left to the menu');
  assert.equal(offeredMethodFor('NEDCASH', OPTS), 'NEDCASH'); assert.equal(offeredMethodFor(null, OPTS), null);
});

test('2. bank words open PayShap with the fee, the balance, the ceiling and the cash alternative in one message; the amount step carries on', async () => {
  envOff();
  const d = deps(8650);
  const open = await startWithdraw({ account: founder, ask: matchWithdrawAsk('lets do a withdrawal to my bank account'), deps: d });
  assert.equal(open.state, 'PAYOUT_AMOUNT'); assert.equal(open.data.method, 'PAYSHAP');
  assert.equal(open.text, '🏦 PayShap to your bank account: R8 fee, the cheapest way into your bank. You have R86.50, so up to R78. No bank account? Cash at an Absa or Nedbank ATM costs from R18. How much?');
  assert.ok(!/Withdraw from WaPay|Reply 1, 2/.test(open.text), 'never the generic menu');
  // The agent's proposal names RTC for bank words: the same opener, never a dropped method.
  const agent = await startWithdraw({ account: founder, ask: { amountCents: null, method: 'RTC' }, deps: d });
  assert.equal(agent.text, open.text);
  const amt = await handleWithdrawReply({ account: founder, state: open.state, data: open.data, text: '50' });
  assert.equal(amt.state, 'PAYOUT_ACCOUNT'); assert.equal(amt.data.amountCents, 5000);
  const all = await handleWithdrawReply({ account: founder, state: open.state, data: open.data, text: 'all of it' });
  assert.equal(all.state, 'PAYOUT_ACCOUNT'); assert.equal(all.data.amountCents, 7800, 'all = the most PayShap can take with its fee');
  const noBank = await handleWithdrawReply({ account: founder, state: open.state, data: open.data, text: "I don't have a bank account" });
  assert.equal(noBank.state, 'PAYOUT_METHOD'); assert.match(noBank.text, /cash needs no bank account/); assert.match(noBank.text, /Reply \*2\* for cash at an Absa ATM, or \*3\* for cash at a Nedbank ATM\./);
  const pick = await handleWithdrawReply({ account: founder, state: noBank.state, data: noBank.data, text: '3' });
  assert.match(pick.text, /withdraw by Cash at a Nedbank ATM/);
  // "All my money to my bank account": the ceiling is taken straight away.
  const allAsk = await startWithdraw({ account: founder, ask: matchWithdrawAsk('I want to put all my money to my bank account'), deps: d });
  assert.equal(allAsk.state, 'PAYOUT_ACCOUNT'); assert.equal(allAsk.data.amountCents, 7800);
  // A large balance names the per-withdrawal maximum instead.
  const rich = await startWithdraw({ account: founder, ask: { method: 'PAYSHAP' }, deps: deps(500000) });
  assert.match(rich.text, /You have R5000, one withdrawal can be up to R3000\./);
  // With an amount the flow goes straight on; a menu pick still gets the plain amount ask.
  const withAmt = await startWithdraw({ account: founder, ask: matchWithdrawAsk('withdraw 50 to my bank account'), deps: d });
  assert.equal(withAmt.state, 'PAYOUT_ACCOUNT');
  const menu = await startWithdraw({ account: founder, ask: {}, deps: d });
  const one = await handleWithdrawReply({ account: founder, state: menu.state, data: menu.data, text: '1' });
  assert.match(one.text, /How much would you like to withdraw by PayShap\? Between R50 and R78/);
  assert.ok(!/—/.test(open.text + noBank.text), 'no em dashes in customer copy');
});
