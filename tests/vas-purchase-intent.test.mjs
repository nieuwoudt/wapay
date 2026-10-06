/**
 * Founder's live run, 2026-10-06 (Blu UAT thread): three VAS flow faults.
 *   1. "buy 50MB Vodacom data for 0720012345" (and the other three networks)
 *      landed in the bundle LIST because the active-category block treated a
 *      complete purchase sentence as a browsing follow-up.
 *   2. "buy R20 electricity. for the meter, 000001020001" asked for the meter
 *      again: the entry hook extracted both slots and discarded the meter.
 *   3. "Insufficient balance. Available: R40.00. Please try again later." was
 *      a dead end; it must name the gap, send the top-up link for exactly that
 *      gap and park the purchase so the next message finishes it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { shortfallCents, MIN_DEPOSIT_CENTS } from '../lib/deposits.js';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

test('a complete purchase sentence is never a browsing follow-up', async () => {
  const src = await read('pages/api/webhooks/message-processor-v2.js');
  const guard = src.indexOf('const completePurchase =');
  const branch = src.indexOf('if (isFollowUp && !categoryMismatch && !completePurchase)');
  assert.ok(guard > -1 && branch > -1 && guard < branch, 'the guard sits before the active-category branch');
  const g = src.slice(guard, branch);
  assert.match(g, /productHint === 'DATA' && !!slots\.dataMb/);
  assert.match(g, /productHint === 'AIRTIME' && !!slots\.amountCents && !!slots\.msisdn/);
});

test('amount and meter in one message go straight to the electricity preview, from every entry', async () => {
  const src = await read('pages/api/webhooks/message-processor-v2.js');
  assert.ok(src.includes('async function startElectricityPreviewAndConfirm('), 'one helper for the preview + confirm');
  const calls = src.match(/await startElectricityPreviewAndConfirm\(/g) || [];
  assert.ok(calls.length >= 4, `meter state, entry hook, active-category case and resume must all use it (found ${calls.length})`);
  // the entry hook no longer asks for the meter it already has
  assert.ok(!src.includes('Please enter your meter number to continue.'), 'the "to continue" re-ask is gone');
  const hook = src.slice(src.indexOf('if (amount && meterNumber) {'), src.indexOf('if (amount && meterNumber) {') + 400);
  assert.match(hook, /startElectricityPreviewAndConfirm\(\{ from, account, amountCents: amount \* 100, meterNumber/);
  // the helper validates the meter shape itself before calling the supplier
  const helper = src.slice(src.indexOf('async function startElectricityPreviewAndConfirm('), src.indexOf('async function startElectricityPreviewAndConfirm(') + 600);
  assert.match(helper, /\^\\d\{8,14\}\$/);
});

test('the three previews answer a shortfall with a code and the two figures', async () => {
  for (const [name, required] of [['airtime', 'amountCents'], ['data', 'totalCents'], ['electricity', 'totalCents']]) {
    const route = await read(`pages/api/vas/${name}/preview.js`);
    const i = route.indexOf("code: 'INSUFFICIENT_BALANCE'");
    assert.ok(i > -1, `${name}: must carry the code`);
    const block = route.slice(i, i + 160);
    assert.match(block, /availableCents: availableBalance/, `${name}: availableCents`);
    assert.ok(block.includes(`requiredCents: ${required}`), `${name}: requiredCents is ${required}`);
  }
});

test('a shortfall names the gap, sends the top-up link in the same turn and parks the purchase; resume re-runs it', async () => {
  const src = await read('pages/api/webhooks/message-processor-v2.js');
  const offer = src.slice(src.indexOf('async function offerTopUpAndPark('), src.indexOf('async function offerTopUpAndPark(') + 1600);
  assert.match(offer, /shortfallCents\(\{ availableCents: available, requiredCents: required \}\)/);
  assert.match(offer, /available\. \$\{what\} needs/);
  assert.match(offer, /handleCardDepositLink\(\{ from, account, amountCents: topUp/);
  assert.ok(offer.indexOf('handleCardDepositLink(') < offer.indexOf('updateConversationState(from, resumeState'), 'the link is created before the park (the link helper clears state)');
  assert.ok(!offer.includes('—'), 'no em dash');
  assert.ok(!/Blu|PayFast/.test(offer.slice(offer.indexOf('text:'), offer.indexOf('kind:'))), 'no supplier named in the copy');
  for (const [state, call] of [
    ['RESUME_AIRTIME_PURCHASE', 'startAirtimePreviewAndConfirm('],
    ['RESUME_ELECTRICITY_PURCHASE', 'startElectricityPreviewAndConfirm('],
    ['RESUME_DATA_PURCHASE', "updateConversationState(from, 'DATA_CONFIRM'"],
  ]) {
    assert.ok(src.includes(`resumeState: '${state}'`), `${state} is parked from its flow`);
    assert.ok(src.includes(`case '${state}':`), `${state} has a state handler`);
  }
  const resume = src.slice(src.indexOf("case 'RESUME_AIRTIME_PURCHASE':"), src.indexOf("case 'RESUME_VOUCHER_PURCHASE':"));
  assert.match(resume, /balanceCents >= requiredCents/, 'the balance is re-checked against the required total');
  // A greeting goes home everywhere (founder rule 2026-09-15) except a funded park, which resumes.
  const home = src.slice(src.indexOf('} else if (isHomeTrigger(text)) {'), src.indexOf('} else if (isHomeTrigger(text)) {') + 900);
  assert.match(home, /\/\^RESUME_\/\.test\(state\) && \(await parkedPurchaseIsFunded\(\{ from, data \}\)\)/, 'a funded park survives a greeting');
  assert.match(home, /renderHome\(\{ from, account \}\)/, 'an unfunded park still goes home');
  assert.match(resume, /isConversationalEscape\(text\)/, 'a real question is answered');
  assert.match(resume, /if \(!after\) await updateConversationState\(from, state, data\);/, 'and the park is put back unless the answer opened a flow');
  assert.match(resume, /\^\(cancel\|stop\|no\|not now\|later\|quit\|exit\)\$/, 'cancel words release the park');
  for (const call of ['startAirtimePreviewAndConfirm(', 'startElectricityPreviewAndConfirm(', "updateConversationState(from, 'DATA_CONFIRM'"]) {
    assert.ok(resume.includes(call), `resume re-runs via ${call}`);
  }
});

test('shortfallCents is the gap, never below the card/EFT minimum', () => {
  assert.equal(shortfallCents({ availableCents: 4000, requiredCents: 10000 }), 6000);
  assert.equal(shortfallCents({ availableCents: 4000, requiredCents: 4500 }), MIN_DEPOSIT_CENTS);
  assert.equal(shortfallCents({ availableCents: 9000, requiredCents: 4000 }), MIN_DEPOSIT_CENTS);
  assert.equal(shortfallCents({}), MIN_DEPOSIT_CENTS);
});
