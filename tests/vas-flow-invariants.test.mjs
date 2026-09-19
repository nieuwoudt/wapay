/**
 * The lessons from the 19 September airtime failure, applied to EVERY VAS
 * product and locked here so they cannot come back one product at a time.
 *
 * Founder, 2026-09-19: "It must always work from now on. The learnings you've
 * taken from this, make sure they apply across the board for all the other VAS
 * products."
 *
 * The four invariants, each one a bug we actually shipped:
 *
 *  1. THE CHOSEN AMOUNT WINS. A reply to "which number?" is a long run of
 *     digits, and the slot parser reads any long run of digits as a rand
 *     amount too. Whatever the customer already chose must beat anything
 *     re-parsed out of their answer.
 *  2. NEVER INVENT AN AMOUNT. Electricity defaulted to R50 when the state had
 *     no amount, which would buy power nobody asked for.
 *  3. SELF MEANS SELF, AND NEVER CANCELS. "mine" carries no digits, and the
 *     branch that reads "no digits" as "get me out" cancelled the purchase.
 *  4. OUR LIMITS ARE OUR FAULT. On QA supplier credentials only four numbers
 *     can be vended to. The customer is told that BEFORE the confirm and the
 *     PIN, and is told it is our side, not their number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSlots } from '../lib/slot-parser.js';
import { BLU_QA_TEST_NUMBERS } from '../lib/msisdn.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const processor = read('../pages/api/webhooks/message-processor-v2.js');
const between = (a, b) => processor.slice(processor.indexOf(a), processor.indexOf(b, processor.indexOf(a) + 1));

test('1. every state that holds an amount prefers it over anything parsed from the reply', () => {
  // The ambiguity is real and is not going away: prove it, then prove each
  // flow is built so it cannot matter.
  assert.equal(parseSlots('0787051175', {}).amountCents, 78705117500);
  assert.equal(parseSlots('0840012300', {}).amountCents, 84001230000);

  const airtime = between("case 'AIRTIME_MSISDN':", "case 'AIRTIME_CONFIRM'");
  assert.match(airtime, /const amountCents = data\?\.amountCents \|\| filledSlots\.amountCents;/);

  const gift = between("case 'VOUCHER_GIFT_RECIPIENT':", "case 'VOUCHER_GIFT_CONFIRM'");
  assert.match(gift, /const amountCents = data\?\.amountCents;/, 'the gift flow reads only what was chosen');
  assert.ok(!/filledSlots\.amountCents \|\| data/.test(gift), 'and never lets a parsed figure win');
});

test('2. no flow ever invents an amount the customer did not choose', () => {
  const meter = between("case 'ELECTRICITY_METER'", "case 'ELECTRICITY_CONFIRM'");
  assert.ok(!/amountCents = existingData\.amountCents \|\| \d+/.test(meter), 'the silent R50 default is gone');
  assert.match(meter, /if \(!Number\.isInteger\(amountCents\) \|\| amountCents <= 0\)/, 'a missing amount is asked for, not guessed');
  // Nothing anywhere may fall back to a hard-coded rand figure for a purchase.
  const defaults = [...processor.matchAll(/amountCents\s*=\s*[A-Za-z?.\[\]'\w]*\.amountCents\s*\|\|\s*(\d{3,})/g)].map((m) => m[1]);
  assert.deepEqual(defaults, [], `no amount default may exist; found ${defaults.join(', ')}`);
});

test('3. "mine" means my own number in every flow that asks for one, and never cancels', () => {
  const selfRe = eval(processor.match(/const SELF_NUMBER = (\/.*\/i);/)[1]);
  for (const yes of ['me', 'mine', 'myself', 'my number', 'my phone', 'my own', 'this one', 'same', 'for me', 'self']) {
    assert.equal(selfRe.test(yes), true, yes);
  }
  for (const no of ['my mother', 'my brother', 'cancel', '0787051175']) {
    assert.equal(selfRe.test(no), false, no);
  }
  const airtime = between("case 'AIRTIME_MSISDN':", "case 'AIRTIME_CONFIRM'");
  assert.ok(
    airtime.indexOf('matchSelfNumber(text)') < airtime.indexOf('digitsOnly.length < 8'),
    'airtime: self is understood before "no digits" is read as an exit',
  );
  const data = between("case 'DATA_MSISDN':", "case 'DATA_NETWORK'");
  assert.match(data, /matchSelfNumber\(normalized\)/, 'data understands it too');
});

test('4. a supplier limit is explained as ours, before the confirm and the PIN', () => {
  // Four numbers is the whole of what QA can vend to, which is why the only
  // successful airtime purchase on record went to one of them.
  assert.equal(BLU_QA_TEST_NUMBERS.size, 4);
  assert.ok(BLU_QA_TEST_NUMBERS.has('0840012300'), 'the number that actually vended, 2 Jan 2026');

  const airtime = between('async function startAirtimePreviewAndConfirm(', 'const previewUrl');
  assert.match(airtime, /if \(!bluCanVendTo\(msisdn\)\)/, 'checked before the preview is even requested');
  const dataFn = between('async function handleDataPurchaseFromSlots(', 'const product = await prisma.vasProduct');
  assert.match(dataFn, /if \(!bluCanVendTo\(msisdn\)\)/);

  // The copy: our fault, their money safe, no date promised, no partner named.
  const line = between('function qaCredentialsLine(product)', 'async function startAirtimePreviewAndConfirm(');
  assert.match(line, /on our side, not yours/);
  assert.match(line, /Your money has not moved/);
  assert.ok(!/\b(Blu|bltelecoms|OTT)\b/.test(line), 'the supplier is never named to the customer');
  assert.ok(!/\b(soon|tomorrow|next week|20\d\d)\b/i.test(line), 'no date is promised');
  assert.ok(!/[—–]/.test(line), 'no em or en dashes in customer copy');
});
