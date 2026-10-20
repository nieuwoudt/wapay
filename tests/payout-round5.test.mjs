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
  const done = await executeWithdraw({ account: lisa, data: pin.data, pinProof: proofFor(lisa, pin.data), deps: d });
  const r = d.last.recipient;
  assert.equal(r.id_number, 'FN123456'); assert.equal(r.id_type, 'PASSPORT'); assert.equal(r.country_of_issue, 'ZW'); assert.equal(r.nationality, 'ZW');
  assert.equal(r.firstname, 'Lisa'); assert.equal(r.surname, 'Moyo');
  assert.equal(done.state, 'PAYOUT_SAVE'); assert.match(done.text, /your name and passport or ID number ending 456/);
  assert.equal(done.data.recipient.id_type, 'PASSPORT'); assert.equal(done.data.recipient.country_of_issue, 'ZW');
  // The answer to OTT's id_type question is a Vercel change, not a deploy.
  process.env.WAPAY_PAYOUT_PASSPORT_ID_TYPE = 'Passport';
  await executeWithdraw({ account: lisa, data: pin.data, pinProof: proofFor(lisa, pin.data), deps: d });
  assert.equal(d.last.recipient.id_type, 'Passport'); assert.equal(passportIdType(), 'Passport');
  delete process.env.WAPAY_PAYOUT_PASSPORT_ID_TYPE;
});

test('1. an SA ID still goes without id_type; a 12-digit number from South Africa is sent back as a mistyped ID; 13 digits at the country step is an SA ID', async () => {
  envOff();
  const d = deps();
  const base = { method: 'CASHSEND', amountCents: 5000, intentId: 'wa-r5-sa', options: ['PAYSHAP', 'CASHSEND', 'NEDCASH'], balanceCents: 35000, fields: { CASHSEND: ['id_number', 'mobile'] }, recipient: { mobile: '27601879361', fullName: 'Lisa Moyo' } };
  const sa = await handleWithdrawReply({ account: lisa, state: 'PAYOUT_ID', data: base, text: '9001015009087' });
  assert.equal(sa.state, 'PAYOUT_CONFIRM'); assert.match(sa.text, /ID number: •••087/);
  await executeWithdraw({ account: lisa, data: sa.data, pinProof: proofFor(lisa, sa.data), deps: d });
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
  await executeWithdraw({ account: lisa, data: pin.data, pinProof: proofFor(lisa, pin.data), deps: d });
  assert.equal(base.last.recipient.id_number, 'FN123456'); assert.equal(base.last.recipient.id_type, 'PASSPORT'); assert.equal(base.last.recipient.country_of_issue, 'ZW'); assert.equal(base.last.recipient.nationality, 'ZW');
  // Typed this time and saved on YES: the vault is told the kind and the country.
  const typed = { method: 'NEDCASH', amountCents: 5000, intentId: 'wa-r5-save', recipient: { mobile: '27601879361', fullName: 'Lisa Moyo', id_number: 'FN123456', id_type: 'PASSPORT', country_of_issue: 'ZW' } };
  const done = await executeWithdraw({ account: lisa, data: typed, pinProof: proofFor(lisa, typed), deps: { ...d, getIdentity: undefined, loadIdentity: async () => null } });
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
  assert.match(src, /Handling conversation state:', \{ state, text: \/\^PAYOUT_\|\^PIN_RESET_\|_PIN\$\/\.test\(state\) \? '\[hidden input\]'/, 'withdraw, PIN and reset answers never reach the logs');
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

// ---------------------------------------------------------------------------
// 3. The R0 withdraw gate reads the customer's situation and never says the
//    same thing twice: her money first and where it is, then the fuller
//    picture and what she can do, then a person (founder 2026-10-12; Lisa got
//    the same minimum line seven times). "How much can I withdraw?" is
//    answered from her balance.
// ---------------------------------------------------------------------------
import { moneySituation, gateRepeatCount, situationSentences } from '../lib/money-situation.js';
import { shortGateReply, stuckAlert, SHORT_GATE } from '../lib/payout-gate.js';
import { matchHowItWorksAsk } from '../lib/how-it-works.js';

const SAT = new Date('2026-10-10T16:44:33Z');   // her gift was delivered on Saturday evening
const LISA_SITUATION = { availableCents: 0, heldCents: 0, giftsReceived: [{ id: 'g1', amountCents: 35000, fromName: 'Nieuwoudt', at: SAT, rail: 'OTT', inBalance: false }], pendingLinks: [{ amountCents: 35000, grossCents: 36700, at: new Date('2026-10-10T20:16:54Z'), ageMinutes: 300 }], pendingPayouts: [], identity: { kind: null, countryOfIssue: null }, savedDestinations: 0 };

test('3. moneySituation reads the balance, the gifts (voucher or already in the balance), unpaid links, held pay-outs and the ID on file, best-effort', async () => {
  const where = [];
  const db = {
    wallet: { findMany: async () => [{ balanceType: 'SPEND', availableCents: 0, pendingCents: 0 }, { balanceType: 'CASH', availableCents: 0, pendingCents: 5800 }] },
    pendingGift: { findMany: async (q) => { where.push(q.where.recipientMsisdn); return [{ id: 'g1', senderAccountId: 'founder', amountCents: 35000, rail: 'OTT', status: 'DELIVERED', createdAt: SAT, deliveredAt: SAT }, { id: 'g2', senderAccountId: 'founder', amountCents: 2000, rail: 'OTT', status: 'DELIVERED', createdAt: SAT, deliveredAt: SAT }]; } },
    account: { findMany: async () => [{ id: 'founder', displayName: 'Nieuwoudt Gresse' }] },
    journalEntry: { findMany: async () => [{ idemKey: 'manual-gift-to-wallet-g2' }] },
    providerRequest: { findMany: async (q) => (q.where.provider === 'PAYFAST' ? [{ requestTs: new Date('2026-10-10T20:16:54Z'), metadata: { amountCents: 35000, grossCents: 36700 } }] : [{ requestTs: SAT, metadata: { reference: 'WPX', amountCents: 5000, feeCents: 800, method: 'PAYSHAP' } }]) },
    payoutIdentity: { findUnique: async () => ({ idType: 'PASSPORT', countryOfIssue: 'ZW' }) },
    payoutDestination: { count: async () => 1 },
  };
  const s = await moneySituation({ prisma: db, account: { id: 'acc-lisa', msisdn: '27601879361' }, now: new Date('2026-10-11T04:23:00Z') });
  assert.deepEqual(where[0], { endsWith: '601879361' }, 'gifts are found by the last nine digits, whatever the stored shape');
  assert.equal(s.availableCents, 0); assert.equal(s.heldCents, 5800);
  assert.deepEqual(s.giftsReceived.map((g) => [g.id, g.fromName, g.inBalance]), [['g1', 'Nieuwoudt', false], ['g2', 'Nieuwoudt', true]], 'the sender by first name; a gift moved into the balance is marked');
  assert.equal(s.pendingLinks[0].grossCents, 36700); assert.ok(s.pendingLinks[0].ageMinutes > 400);
  assert.equal(s.pendingPayouts[0].reference, 'WPX');
  assert.deepEqual(s.identity, { kind: 'PASSPORT', countryOfIssue: 'ZW' }); assert.equal(s.savedDestinations, 1);
  const broken = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => { throw new Error('db down'); } }) });
  const empty = await moneySituation({ prisma: broken, account: { id: 'x', msisdn: '27601879361' } });
  assert.equal(empty.availableCents, 0); assert.deepEqual(empty.giftsReceived, []); assert.equal(empty.identity.kind, null);
  assert.deepEqual(situationSentences(s, { now: new Date('2026-10-11T04:23:00Z') }), [
    'The R350 Nieuwoudt sent you yesterday came as a voucher PIN, not as money in your balance, so it cannot be withdrawn.',
    'Your R350 add-money link (R367 with the card fee) from yesterday was not paid, so nothing came in from it and nothing was taken.',
    'R58 is held for your R50 withdrawal (WPX) until the bank confirms it; if it does not go through, it comes back to your balance.',
  ]);
});

test('3. gateRepeatCount counts the gate replies among the last eight assistant turns in twelve hours, by the stored gate id', async () => {
  const turns = (refsList) => ({ conversationTurn: { findMany: async () => refsList.map((refs) => ({ refs })) } });
  assert.equal(await gateRepeatCount({ prisma: turns([]), accountId: 'a', gate: SHORT_GATE }), 0);
  assert.equal(await gateRepeatCount({ prisma: turns([{ gate: SHORT_GATE }, null, { gate: SHORT_GATE }]), accountId: 'a', gate: SHORT_GATE }), 2, 'another reply in between does not reset the count (Lisa met the gate between other turns)');
  assert.equal(await gateRepeatCount({ prisma: turns([{ gate: 'OTHER' }, null]), accountId: 'a', gate: SHORT_GATE }), 0);
  assert.equal(await gateRepeatCount({ prisma: { conversationTurn: { findMany: async () => { throw new Error('x'); } } }, accountId: 'a', gate: SHORT_GATE }), 0);
});

test('3. the gate in tiers on Lisa\'s situation: her money and where it is, then the picture and what to do, then a person; never the same line twice in a row', () => {
  const lisaAcc = { id: 'acc-lisa', waId: '27601879361', displayName: 'Lisa' };
  const now = new Date('2026-10-10T21:28:00Z');
  const t = [0, 1, 2, 3].map((repeats) => shortGateReply({ account: lisaAcc, balanceCents: 0, needCents: 5800, minCents: 5000, situation: LISA_SITUATION, repeats, personAsked: repeats === 2, now }));
  assert.equal(t[0].text, '💸 You have R0 to withdraw. The R350 Nieuwoudt sent you today came as a voucher PIN, not as money in your balance, so it cannot be withdrawn. Your R350 add-money link (R367 with the card fee) from today was not paid, so nothing came in from it and nothing was taken. A withdrawal needs at least R58 in your balance (the R50 minimum plus the R8 PayShap fee). Say *add money* to top up.');
  assert.ok(!/Withdrawals start at/.test(t[0].text), 'never a product fact first');
  assert.match(t[1].text, /^Let me explain where your money is, Lisa:\n\n• Balance you can withdraw: \*R0\*\n• The R350 from Nieuwoudt \(today\): a voucher PIN, not balance\n• Your R350 add-money link \(R367 with the card fee\): not paid, nothing was taken\n\nWhat you can do:\n1️⃣ Add money/);
  assert.match(t[1].text, /2️⃣ Use the voucher PIN at a shop that takes WaPay vouchers\n3️⃣ Withdraw once your balance is R58 or more: say \*withdraw\*/);
  assert.match(t[1].text, /a passport or foreign ID works too/, 'no ID on file: a passport is named');
  assert.match(t[2].text, /^🙋 I can see this is not working for you, Lisa, so I have asked a person from the WaPay team to look at your account and message you here\. Your money is safe\./);
  assert.match(t[3].text, /^💸 In short: you have R0 to withdraw/, 'tier 3 without an alert on record claims no person');
  assert.match(shortGateReply({ account: lisaAcc, balanceCents: 0, needCents: 5800, minCents: 5000, situation: LISA_SITUATION, repeats: 3, personAsked: true, now }).text, /^🙋 A person from the WaPay team has been asked to help you and will message you here\. Until then: you have R0 to withdraw/);
  assert.deepEqual(t.map((x) => x.refs), [0, 1, 2, 3].map((tier) => ({ gate: SHORT_GATE, tier, ...(tier === 2 ? { personAsked: true } : {}) })));
  for (let i = 1; i < t.length; i += 1) assert.notEqual(t[i].text, t[i - 1].text, `tier ${i} differs from tier ${i - 1}`);
  // Tier 2 without a working alert never promises a person.
  const noAlert = shortGateReply({ account: lisaAcc, balanceCents: 0, needCents: 5800, minCents: 5000, situation: LISA_SITUATION, repeats: 2, personAsked: false, now });
  assert.ok(!/asked a person/.test(noAlert.text)); assert.match(noAlert.text, /^Here it is once more, step by step, Lisa:/);
  process.env.WAPAY_SUPPORT_WHATSAPP = '060 000 0000';
  assert.match(shortGateReply({ account: lisaAcc, balanceCents: 0, needCents: 5800, minCents: 5000, situation: LISA_SITUATION, repeats: 2, now }).text, /To talk to a person from the WaPay team, WhatsApp 060 000 0000\./);
  delete process.env.WAPAY_SUPPORT_WHATSAPP;
  // A small balance: the gap, then what to do.
  assert.equal(shortGateReply({ account: lisaAcc, balanceCents: 1650, needCents: 5800, minCents: 5000, situation: { ...LISA_SITUATION, giftsReceived: [], pendingLinks: [], identity: { kind: 'RSAID' } }, repeats: 0, now }).text,
    '💸 You have R16.50 to withdraw. A withdrawal needs at least R58 in your balance (the R50 minimum plus the R8 PayShap fee), so you need R41.50 more. Say *add money* to top up.');
  for (const x of t) assert.ok(!/—|\bOTT\b|PayFast/.test(x.text), 'no em dash, no partner named');
  const alert = stuckAlert({ account: lisaAcc, balanceCents: 0, needCents: 5800, situation: LISA_SITUATION, now });
  assert.match(alert.subject, /Lisa has asked to withdraw three times/); assert.match(alert.detailsHtml, /•••9361/); assert.ok(!/27601879361|0601879361/.test(alert.detailsHtml), 'the number is masked in the e-mail');
});

test('3. startWithdraw at R0: reads the situation, counts the repeats, alerts a person exactly once (the third time), returns the gate id for the stored turn', async () => {
  envOff();
  const alerts = [];
  const twins = [];
  const mk = (repeats, ok = true, askedBefore = false) => ({ ...deps(0), moneySituation: async () => LISA_SITUATION, gateHistory: async () => ({ count: repeats, personAsked: askedBefore }), opsPersonAlert: async (x) => { twins.push(x); return { sent: 0 }; }, sendOpsAlert: async (a) => { alerts.push(a); return { success: ok }; } });
  const first = await startWithdraw({ account: lisa, ask: matchWithdrawAsk('I want you to put in my bank account'), deps: mk(0) });
  assert.equal(first.state, null); assert.match(first.text, /^💸 You have R0 to withdraw\. The R350 Nieuwoudt sent you/); assert.deepEqual(first.refs, { gate: SHORT_GATE, tier: 0 });
  const second = await startWithdraw({ account: lisa, ask: {}, deps: mk(1) });
  assert.match(second.text, /^Let me explain where your money is, Lisa:/);
  assert.equal(alerts.length, 0, 'no alert before the third time');
  const third = await startWithdraw({ account: lisa, ask: {}, deps: mk(2) });
  assert.match(third.text, /I have asked a person from the WaPay team/); assert.equal(alerts.length, 1); assert.match(alerts[0].subject, /three times/);
  assert.equal(twins.length, 1, 'the WhatsApp twin goes with the e-mail'); assert.match(twins[0].text, /^🙋 Lisa has asked to withdraw three times and cannot\./); assert.match(twins[0].key, /^acc-lisa:\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(third.refs, { gate: SHORT_GATE, tier: 2, personAsked: true }, 'the stored reply remembers that a person was asked');
  const fourth = await startWithdraw({ account: lisa, ask: {}, deps: mk(3, true, true) });
  assert.match(fourth.text, /has been asked to help you/); assert.equal(alerts.length, 1, 'one alert, not one per message');
  const failedAlert = await startWithdraw({ account: lisa, ask: {}, deps: mk(2, false) });
  assert.ok(!/asked a person/.test(failedAlert.text), 'a failed alert is never presented as a person on the way'); assert.equal(failedAlert.refs.personAsked, undefined);
  // Harness 2026-10-12: with no alert channel the fourth reply said "has been asked". Never again: no alert, no claim; the alert is retried.
  const fourthNoAlert = await startWithdraw({ account: lisa, ask: {}, deps: mk(3, false, false) });
  assert.ok(!/has been asked|asked a person/.test(fourthNoAlert.text)); assert.match(fourthNoAlert.text, /^💸 In short: you have R0 to withdraw/); assert.equal(alerts.length, 3, 'a failed alert is retried on the next gate');
  // The processor stores the gate id on the turn (refs), so the count works in every language.
  const src = read('../pages/api/webhooks/message-processor-v2.js');
  assert.match(src, /return await sendWhatsAppText\(\{ to: from, text: msg, \.\.\.\(step\.refs \? \{ refs: step\.refs \} : \{\}\) \}\);/);
});

test('3. "How much can I withdraw?" is answered from the balance (not the how-it-works brief); a short balance gets the gate', async () => {
  envOff();
  for (const q of ['How much can I withdraw', 'How much can I withdraw?', 'What can I withdraw?', 'how much money can i take out']) {
    assert.equal(matchHowItWorksAsk(q), null, q); assert.equal(matchWithdrawAsk(q)?.howMuch, true, q);
  }
  assert.equal(matchHowItWorksAsk('How do I withdraw?'), 'withdraw', 'a how-to question still gets the walkthrough');
  const ans = await startWithdraw({ account: lisa, ask: matchWithdrawAsk('How much can I withdraw?'), deps: deps(35000) });
  assert.equal(ans.state, null);
  assert.equal(ans.text, '💸 You have R350. The most you can withdraw right now: R342 by PayShap to your bank account (R8 fee), or R300 as cash at an Absa or Nedbank ATM (R18 fee, paid in R50 and R100 notes). Say *withdraw* and the amount, like "withdraw 342".');
  const poor = await startWithdraw({ account: lisa, ask: matchWithdrawAsk('How much can I withdraw?'), deps: { ...deps(0), moneySituation: async () => LISA_SITUATION, gateHistory: async () => ({ count: 0, personAsked: false }) } });
  assert.match(poor.text, /^💸 You have R0 to withdraw\./);
});

// ---------------------------------------------------------------------------
// 4. "Send money" to your own number is refused; a received voucher named in
//    the message is answered, never sold (founder 2026-10-12: Lisa typed her
//    own number after "send money" and was offered a R350 voucher for R367).
// 5. "Did my payment go through?" about a link nobody paid: "you have not
//    paid", never "still confirming".
// ---------------------------------------------------------------------------
import { SEND_TO_SELF_TEXT, namesReceivedVoucher, receivedVoucherReply } from '../lib/payout-gate.js';
import { unpaidLinkAnswer } from '../lib/money-situation.js';

test('4. the own-number refusal names withdraw and the self-purchase; only the send paths are refused, the explicit self-purchase is not', () => {
  assert.equal(SEND_TO_SELF_TEXT, '📵 That is your own number, so there is nobody to send it to. To move your WaPay money into your bank account, say *withdraw*. To buy a voucher for yourself, say *buy a voucher*.');
  const src = read('../pages/api/webhooks/message-processor-v2.js');
  const set = src.match(/const SEND_PATH_INTENTS = new Set\(\[([^\]]*)\]\)/)?.[1] || '';
  for (const i of ['STATE_VOUCHER_GIFT_RECIPIENT', 'STATE_VOUCHER_GIFT_RECIPIENT_BENEFICIARY', 'STATE_VOUCHER_GIFT_AMOUNT', 'ORCHESTRATOR', 'AI_CHAT', 'SMART_PRODUCT_QUERY']) assert.ok(set.includes(`'${i}'`), i);
  for (const i of ['OTT_VOUCHER_SELF', 'RESUME_VOUCHER_PURCHASE']) assert.ok(!set.includes(`'${i}'`), `${i} may reach the preview with the own number`);
  const fn = src.slice(src.indexOf('async function startVoucherGiftPreviewAndConfirm'));
  assert.ok(fn.indexOf('SEND_PATH_INTENTS.has(intent)') > -1 && fn.indexOf('SEND_PATH_INTENTS.has(intent)') < fn.indexOf("apiUrl('/api/vas/voucher/preview')"), 'the refusal runs before any preview or shortfall link');
  assert.match(src, /updateConversationState\(from, 'VOUCHER_GIFT_AMOUNT', \{ recipientMsisdn: account\.msisdn, self: true \}\)/, 'the explicit self-purchase is marked');
  assert.match(src, /intent: data\?\.self \? 'OTT_VOUCHER_SELF' : 'STATE_VOUCHER_GIFT_AMOUNT'/);
  const send = src.slice(src.indexOf("slots?.productHint === 'SEND_MONEY' &&"));
  assert.ok(send.indexOf('namesReceivedVoucher(text)') > -1 && send.indexOf('namesReceivedVoucher(text)') < send.indexOf('resolveGift({ slots, senderMsisdn'), 'a received voucher is answered before the gift flow can start');
});

test('4. a received voucher in the message: recognised, answered from the record, null when the record has none', () => {
  for (const t of ['I got a R350 voucher from Nieuwoudt', 'send the voucher Nieuwoudt sent me', 'Can I spend the voucher I received?', 'the voucher you sent me']) assert.ok(namesReceivedVoucher(t), t);
  for (const t of ['buy a voucher', 'send money', 'send R50 voucher to 0821234567', 'I received money', 'my vouchers']) assert.ok(!namesReceivedVoucher(t), t);
  const now = new Date('2026-10-11T07:14:00Z');
  const v = receivedVoucherReply({ situation: LISA_SITUATION, now });
  assert.match(v, /^🎁 The R350 Nieuwoudt sent you yesterday is a voucher PIN \(in that day's message\)\. It is spent at shops that take WaPay vouchers; it is not part of your WaPay balance, so it cannot be sent on or withdrawn\./);
  assert.match(v, /Your WaPay balance: R0\.$/);
  const moved = receivedVoucherReply({ situation: { ...LISA_SITUATION, availableCents: 35000, giftsReceived: [{ ...LISA_SITUATION.giftsReceived[0], inBalance: true }] }, now });
  assert.match(moved, /is in your WaPay balance: spend it here, or say \*withdraw\* to move it to your bank\./);
  assert.equal(receivedVoucherReply({ situation: { ...LISA_SITUATION, giftsReceived: [] } }), null);
  assert.ok(!/OTT|PayFast|—/.test(v + moved), 'no partner named, no em dash');
});

test('5. an unpaid link: older than 15 minutes is "you have not paid", fresh is "no payment yet"; never "still confirming", no partner, no time promised', () => {
  const now = new Date('2026-10-10T21:25:00Z');
  const old = unpaidLinkAnswer({ intent: { requestTs: new Date('2026-10-10T20:16:54Z'), metadata: { amountCents: 35000, grossCents: 36700 } }, now });
  assert.equal(old, 'You have not paid your R350 add-money link (R367 with the card fee) from today: no payment came in for it, so nothing was taken. Ignore it if you did not mean to buy. If money did leave your bank for it, tell me and I will check.');
  const fresh = unpaidLinkAnswer({ intent: { requestTs: new Date('2026-10-10T21:20:00Z'), metadata: { amountCents: 5000, grossCents: 5300 } }, now });
  assert.equal(fresh, 'I have not received a payment for your R50 add-money link (R53 with the card fee) yet. If you have just paid, I will message you here as soon as it lands. If you did not pay, nothing was taken.');
  const bare = unpaidLinkAnswer({ intent: { requestTs: new Date('2026-10-08T10:00:00Z'), metadata: {} }, now });
  assert.match(bare, /^You have not paid your add-money link from on|^You have not paid your add-money link from /);
  for (const t of [old, fresh, bare]) assert.ok(!/still confirming|PayFast|minute|—/i.test(t), t);
});

// ---------------------------------------------------------------------------
// 6. A gift to someone not yet on WaPay waits and becomes their BALANCE when
//    they join; a voucher only if they never join. The money side as pure,
//    balanced builders (the wiring is the gifting flow's:
//    docs/PAYOUTS_ROUND5_FOR_MAIN_SESSION.md §B).
// ---------------------------------------------------------------------------
import { buildGiftHeld, buildGiftClaimToBalance, buildGiftExpiryToVoucher, GIFT_PENDING, FEES, validateBalanced } from '../lib/ledger-core.js';
import { GIFT_IN_BALANCE_PREFIXES } from '../lib/money-situation.js';

const net = (entries) => {
  const out = {};
  for (const e of entries) for (const p of e.postings) out[p.accountCode] = (out[p.accountCode] || 0) + (p.creditCents || 0) - (p.debitCents || 0);
  return out;
};

test('6. held → claimed: the sender pays face + fee once, the recipient\'s balance gets the face value, the pending account nets to zero, no rail is touched', () => {
  const held = buildGiftHeld({ senderAccountId: 'founder', amountCents: 35000, giftId: 'cmv2foj8f001fd6jcamn6pjld', recipientMsisdn: '27601879361' });
  const claimed = buildGiftClaimToBalance({ recipientAccountId: 'lisa', amountCents: 35000, giftId: 'cmv2foj8f001fd6jcamn6pjld' });
  for (const e of [held, claimed]) validateBalanced(e.postings);
  assert.equal(held.idemKey, 'gift-held-cmv2foj8f001fd6jcamn6pjld'); assert.equal(claimed.idemKey, 'gift-claim-balance-cmv2foj8f001fd6jcamn6pjld');
  assert.ok(GIFT_IN_BALANCE_PREFIXES.some((p) => claimed.idemKey.startsWith(p)), 'the situation reader sees a claimed gift as balance');
  const n = net([held, claimed]);
  const fee = FEES.voucherGift.flatFeeCents;
  assert.equal(n['WALLET:founder:SPEND'], -(35000 + fee)); assert.equal(n['WALLET:lisa:SPEND'], 35000); assert.equal(n[GIFT_PENDING], 0);
  assert.ok(!Object.keys(n).some((k) => k.startsWith('CLEARING:')), 'no rail clearing on the balance path: nothing minted, nothing to reverse');
  assert.equal(held.meta.recipientMasked.includes('601879361'), false, 'the recipient number is masked');
  // The same gift id always yields the same keys (replay-safe through postEntry).
  assert.equal(buildGiftClaimToBalance({ recipientAccountId: 'lisa', amountCents: 35000, giftId: 'cmv2foj8f001fd6jcamn6pjld' }).idemKey, claimed.idemKey);
});

test('6. held → expired: the voucher is minted only then; the pending account nets to zero and the rail is owed the face value less commission', () => {
  const held = buildGiftHeld({ senderAccountId: 'founder', amountCents: 5000, giftId: 'g-exp-1', recipientMsisdn: '27820000000', flatFeeCentsOverride: 0 });
  const expired = buildGiftExpiryToVoucher({ amountCents: 5000, giftId: 'g-exp-1' });
  validateBalanced(expired.postings);
  assert.equal(expired.idemKey, 'gift-expiry-voucher-g-exp-1'); assert.equal(expired.source, 'GIFT_EXPIRY_VOUCHER_OTT');
  const n = net([held, expired]);
  assert.equal(n[GIFT_PENDING], 0);
  assert.equal(n['CLEARING:OTT'] + (n['REVENUE:COMMISSION:VOUCHER'] || 0), 5000);
  assert.throws(() => buildGiftClaimToBalance({ recipientAccountId: 'x', amountCents: 5000 }), /giftId/);
  assert.throws(() => buildGiftHeld({ senderAccountId: 's', amountCents: 1.5, giftId: 'g' }));
});

// ---------------------------------------------------------------------------
// 7. No time promises anywhere in the copy the customer reads (founder
//    2026-10-12: "(R8, minutes)" and "arrives in minutes" reached Lisa).
// 8. The gift claim message no longer says "reply BALANCE to open your own
//    WaPay and use it right here" to someone already joining.
// ---------------------------------------------------------------------------
import { TOPICS, howItWorksBrief, howItWorksAnswer } from '../lib/how-it-works.js';
import { buildVoucherClaimMessage } from '../lib/gifting.js';
import { CAPABILITIES } from '../lib/capabilities.js';
import { PAYOUT_METHODS } from '../lib/payouts.js';

const TIME_PROMISE = /\binstantly\b|\bin minutes\b|\bwithin (?:seconds|a minute|about a minute|minutes|the hour|an hour)\b|\b(?:usually|takes about|up to about) (?:a |\d+ )?(?:minute|second|hour)s?\b|, minutes\)|arrives in minutes/i;

test('7. no time is promised: every how-it-works brief and answer, the registry one-liners, the method hints, the identity ask', () => {
  envOff();
  const ctx = { withdrawLive: true, providers: LIVE, text: '' };
  for (const id of Object.keys(TOPICS)) {
    for (const text of ['', 'can I withdraw at an absa atm?', 'payshap?', 'nedbank cash?']) {
      const b = howItWorksBrief(id, { ...ctx, text }); const a = howItWorksAnswer(id, { ...ctx, text });
      for (const t of [b, a].filter(Boolean)) assert.ok(!TIME_PROMISE.test(t), `${id}: ${t.match(TIME_PROMISE)?.[0]}`);
    }
  }
  for (const c of CAPABILITIES) assert.ok(!TIME_PROMISE.test(`${c.oneLiner || ''} ${c.helpLine || ''}`), c.id);
  for (const [m, def] of Object.entries(PAYOUT_METHODS)) assert.ok(!TIME_PROMISE.test(def.hint), m);
  assert.ok(!/two minutes/.test(read('../lib/payout-chat.js').match(/const KYC_ASK = `[^`]*`/)[0]));
});

test('7. the withdraw copy names only the cash ways on the merchant and the identity check only while it is on', () => {
  envOff();
  const live = { withdrawLive: true, providers: LIVE, text: 'can I withdraw?' };
  const brief = howItWorksBrief('withdraw', live);
  assert.match(brief, /PayShap \(R8 fee\) or collect cash at an Absa or Nedbank ATM, or a Pick n Pay \/ Boxer till \(from R18\)/);
  assert.ok(!/FNB eWallet/.test(brief + howItWorksAnswer('withdraw', live)), 'no FNB eWallet on the production merchant');
  assert.ok(!/identity check/.test(howItWorksAnswer('withdraw', live)), 'identity checks are off in the open pilot');
  delete process.env.WAPAY_PAYOUT_KYC;
  assert.match(howItWorksAnswer('withdraw', live), /A once-off identity check applies before your first withdrawal\./);
  const bare = howItWorksBrief('withdraw', { withdrawLive: true, providers: [], text: 'can I withdraw?' });
  assert.match(bare, /Absa or Nedbank ATM/); assert.ok(!/FNB eWallet/.test(bare), 'with no provider list the production two are named, never the eWallet (BUGLOG #119)'); assert.match(bare, /Withdrawals start at R50/);
  envOff();
});

test('8. the gift claim message says the PIN is separate from the balance, never "open your own WaPay" or "use it right here"', () => {
  const msg = buildVoucherClaimMessage({ senderName: 'Nieuwoudt', amountCents: 35000, pin: '1234567890123456' });
  assert.match(msg, /This voucher is separate from your WaPay balance: it is spent at those stores and cannot be withdrawn to a bank\. Say \*balance\* any time to see your WaPay balance\./);
  assert.ok(!/reply BALANCE|open your own WaPay|use it right here|—/.test(msg));
});

// ---------------------------------------------------------------------------
// 9. After a bare YES at the save step, one optional question: "What should I
//    call it?" (not for the customer's own WhatsApp number, which is "Mine").
// 10. "Can you save my number used above as mine?" / "call it mother" is a
//    real action on the saved destination, before any model.
// 11. Cellphone labels show four digits; accounts and IDs keep three.
// ---------------------------------------------------------------------------
import { matchNicknameAsk, nicknameLastDestination } from '../lib/payout-nickname.js';
import { destinationLabel, displayLabelOf, setPayoutDestinationNickname } from '../lib/payout-beneficiaries.js';
import { proofFor } from './helpers/pin-proof.mjs';

test('9. a bare YES for an account asks for a name once; a name sets it, "no" or "ok" keeps it, anything else passes through; their own number is "Mine" without a question', async () => {
  envOff();
  const named = [];
  const d = {
    ...deps(), beneficiariesAvailable: () => true,
    saveDestination: async (a) => ({ ok: true, id: 'dest-1', label: a.nickname ? `${a.nickname === 'mine' ? 'Mine' : a.nickname}: ${a.method === 'PAYSHAP' ? 'Capitec account •••890' : 'Cellphone •••9361'}` : 'Capitec account •••890' }),
    saveIdentity: async () => ({ ok: true, idLast3: '456' }),
    setNickname: async (a) => { named.push(a); const n = /mother/i.test(a.nickname) ? 'Mother' : 'Mine'; return { ok: true, nickname: n, label: `${n}: Capitec account •••890` }; },
  };
  const saveData = { method: 'PAYSHAP', recipient: { account_number: '1234567890', branch_code: '470010', branch_name: 'Capitec', mobile: '27601879361', fullName: 'Lisa Moyo', id_number: 'FN123456', id_type: 'PASSPORT', country_of_issue: 'ZW' }, saveDestination: true, saveIdentity: true };
  const yes = await handleWithdrawReply({ account: lisa, state: 'PAYOUT_SAVE', data: saveData, text: 'yes', deps: d });
  assert.equal(yes.state, 'PAYOUT_SAVE'); assert.equal(yes.data.nicknameFor, 'dest-1');
  assert.match(yes.text, /^✅ Saved, encrypted: Capitec account •••890 and your name and passport or ID number ending 456\. What should I call it\? Reply \*mine\*, or a name like \*mother\*\./);
  const mother = await handleWithdrawReply({ account: lisa, state: yes.state, data: yes.data, text: 'mother', deps: d });
  assert.equal(mother.state, null); assert.equal(mother.text, '✅ Called it *Mother*: Mother: Capitec account •••890. Next time you withdraw, say "mother" to use it.');
  assert.deepEqual(named.map((x) => [x.id, x.nickname]), [['dest-1', 'Mother']]);
  for (const t of ['no', 'ok', 'skip', 'thanks']) {
    const r = await handleWithdrawReply({ account: lisa, state: yes.state, data: yes.data, text: t, deps: d });
    assert.equal(r.state, null, t); assert.match(r.text, /Kept as Capitec account •••890, without a name\./, t);
  }
  assert.deepEqual(await handleWithdrawReply({ account: lisa, state: yes.state, data: yes.data, text: 'buy R20 airtime', deps: d }), { state: null, passthrough: true });
  assert.equal(named.length, 1, 'only a name writes');
  // A name given with the YES: no second question.
  const withName = await handleWithdrawReply({ account: lisa, state: 'PAYOUT_SAVE', data: saveData, text: 'yes as mine', deps: d });
  assert.equal(withName.state, null); assert.match(withName.text, /^✅ Saved as \*Mine\*/);
  // Her own WhatsApp number for cash: "Mine", never asked.
  const own = await handleWithdrawReply({ account: lisa, state: 'PAYOUT_SAVE', data: { method: 'CASHSEND', recipient: { mobile: '27601879361' }, saveDestination: true, saveIdentity: false }, text: 'yes', deps: d });
  assert.equal(own.state, null); assert.match(own.text, /^✅ Saved as \*Mine\*, encrypted: Mine: Cellphone •••9361/);
  // Another cellphone: asked.
  const other = await handleWithdrawReply({ account: lisa, state: 'PAYOUT_SAVE', data: { method: 'CASHSEND', recipient: { mobile: '27820000000' }, saveDestination: true, saveIdentity: false }, text: 'yes', deps: d });
  assert.equal(other.state, 'PAYOUT_SAVE'); assert.match(other.text, /What should I call it\?/);
});

test('10. "save my number used above as mine" and "call it mother" are read exactly; "call me Thandi" is not a destination', () => {
  const cases = {
    'can you save my number used abve as mine?': 'Mine', 'Can you save my number used above as mine?': 'Mine', 'call it mother': 'Mother', 'name that account mine': 'Mine',
    'name that one mine': 'Mine', 'call my capitec account mine': 'Mine', 'save that account as Mother.': 'Mother', 'label it Ma': 'Ma', 'call the number above mother': 'Mother',
  };
  for (const [t, nick] of Object.entries(cases)) assert.equal(matchNicknameAsk(t), nick, t);
  for (const t of ['call me Thandi', 'my name is Lisa', 'save me R50', 'what is my balance', 'withdraw 50', '']) assert.equal(matchNicknameAsk(t), null, t);
});

test('10. the name goes on the destination the last pay-out used; an unsaved one is said, never renamed; nothing saved is said; the reply only claims what was written', async () => {
  const founderAcc = { id: 'acc-f', msisdn: '27787051175' };
  const saved = [{ id: 'cash1', method: 'NEDCASH', family: 'CASH', label: 'Cellphone •••1175' }, { id: 'bank1', method: 'PAYSHAP', family: 'BANK', label: 'FNB account •••394' }];
  const writes = [];
  const base = { available: () => true, listDestinations: async () => saved, setNickname: async (a) => { writes.push(a); return { ok: true, nickname: 'Mine', label: `Mine: ${saved.find((x) => x.id === a.id).label}` }; } };
  const cash = await nicknameLastDestination({ account: founderAcc, nickname: 'mine', deps: { ...base, latestPayout: async () => ({ metadata: { method: 'CASHSEND', recipient: { mobile: '•••175' } } }) } });
  assert.equal(cash.ok, true); assert.equal(writes.at(-1).id, 'cash1'); assert.equal(cash.text, '✅ Done: it is saved as *Mine*: Mine: Cellphone •••1175. Next time you withdraw, say "mine" to use it.');
  await nicknameLastDestination({ account: founderAcc, nickname: 'mine', deps: { ...base, latestPayout: async () => ({ metadata: { method: 'PAYSHAP', recipient: { account: '•••394' } } }) } });
  assert.equal(writes.at(-1).id, 'bank1', 'the last pay-out went to the FNB account');
  const unsaved = await nicknameLastDestination({ account: founderAcc, nickname: 'mine', deps: { ...base, latestPayout: async () => ({ metadata: { method: 'PAYSHAP', recipient: { account: '•••777' } } }) } });
  assert.equal(unsaved.ok, false); assert.match(unsaved.text, /The account your last withdrawal went to is not saved, so I cannot name it/); assert.equal(writes.length, 2, 'a different row is never renamed');
  const none = await nicknameLastDestination({ account: founderAcc, nickname: 'mine', deps: { ...base, listDestinations: async () => [] } });
  assert.match(none.text, /^Nothing is saved for your withdrawals yet/);
  const failed = await nicknameLastDestination({ account: founderAcc, nickname: 'mine', deps: { ...base, latestPayout: async () => null, setNickname: async () => ({ ok: false }) } });
  assert.match(failed.text, /nothing changed/); assert.ok(!/Done|saved as/.test(failed.text), 'no save is claimed when nothing was written');
  // The processor runs it before the agent (the founder's number is on the agent pilot).
  const src = read('../pages/api/webhooks/message-processor-v2.js');
  const hook = src.indexOf('matchNicknameAsk(text)'); const agent = src.indexOf('if (agentV3For(from)) {\n    return await handleAgentTurn({ from, text, account, messageId });');
  assert.ok(hook > -1 && agent > -1 && hook < agent, 'the nickname hook runs before the agent turn');
});

test('10. setPayoutDestinationNickname writes only the owner\'s row and returns the new label', async () => {
  const rows = { d1: { id: 'd1', accountId: 'a1', method: 'PAYSHAP', bankName: 'FNB', accountLast3: '394', nickname: null } };
  const db = { payoutDestination: {
    updateMany: async ({ where, data }) => { const r = rows[where.id]; if (!r || r.accountId !== where.accountId) return { count: 0 }; Object.assign(r, data); return { count: 1 }; },
    findUnique: async ({ where }) => rows[where.id] || null,
  } };
  assert.deepEqual(await setPayoutDestinationNickname({ prisma: db, accountId: 'a1', id: 'd1', nickname: 'my mom' }), { ok: true, nickname: 'My Mom', label: 'My Mom: FNB account •••394' });
  assert.equal((await setPayoutDestinationNickname({ prisma: db, accountId: 'intruder', id: 'd1', nickname: 'x' })).ok, false);
  assert.equal((await setPayoutDestinationNickname({ prisma: db, accountId: 'a1', id: 'd1', nickname: '123' })).error, 'BAD_INPUT');
});

test('11. cellphones show four digits everywhere the customer sees them; accounts and IDs keep three; old rows read their four from the vault', () => {
  assert.equal(destinationLabel('NEDCASH', { mobile: '0787051175' }), 'Cellphone •••1175');
  assert.equal(destinationLabel('PAYSHAP', { account_number: '62012345394', branch_name: 'FNB' }), 'FNB account •••394');
  assert.equal(displayLabelOf({ method: 'NEDCASH', mobileLast3: '175', mobileLast4: '1175', nickname: 'Mine' }), 'Mine: Cellphone •••1175');
  assert.equal(displayLabelOf({ method: 'NEDCASH', mobileLast3: '175' }), 'Cellphone •••175', 'an old row with nothing to decrypt keeps its three digits');
  const src = read('../lib/payout-beneficiaries.js');
  assert.match(src, /mobileLast4: lastDigits\(number, 4\)/, 'new saves store the four digits');
  assert.match(read('../lib/payout-collection.js'), /d\.slice\(-4\)/);
  assert.match(read('../lib/payouts.js'), /mobile: recipient\.mobile \? `•••\$\{String\(recipient\.mobile\)\.slice\(-4\)\}` : null/);
});
