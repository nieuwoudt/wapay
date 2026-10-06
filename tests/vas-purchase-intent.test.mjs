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
import { parseSlots } from '../lib/slot-parser.js';

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
  const offer = src.slice(src.indexOf('async function offerTopUpAndPark('), src.indexOf('async function offerTopUpAndPark(') + 2600);
  assert.match(offer, /shortfallCents\(\{ availableCents: available, requiredCents: required \}\)/);
  assert.match(offer, /available\. \$\{what\} needs \$\{randsShort\(gap\)\} more\./);
  assert.match(offer, /handleCardDepositLink\(\{ from, account, amountCents: topUp/);
  // The link branch creates the link BEFORE it parks (the link helper clears state); the
  // over-the-cap branch parks without a link, by design, and sits above it.
  assert.ok(offer.indexOf('handleCardDepositLink(') < offer.lastIndexOf('updateConversationState(from, resumeState'), 'the link is created before the park (the link helper clears state)');
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
  const home = src.slice(src.indexOf('} else if (isHomeTrigger(text)) {'), src.indexOf('} else if (isHomeTrigger(text)) {') + 1600);
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

// ---------------------------------------------------------------------------
// Review round of 2026-10-06 (read-only reviewer on the first fix): the
// founder's number is on the agent pilot list, so his messages reach the agent
// dispatcher, not the regex hooks; the fee was charged but never shown; a
// silent R50 fallback had survived BUGLOG #79; a meter parsed as an amount.
// ---------------------------------------------------------------------------
test('the agent dispatcher hands a complete data or electricity purchase to the flow helpers, never to the list or a second meter ask', async () => {
  const src = await read('pages/api/webhooks/message-processor-v2.js');
  const data = src.slice(src.indexOf("    case 'BUY_DATA': {"), src.indexOf("    case 'BUY_ELECTRICITY': {"));
  assert.match(data, /resolveDataPurchaseSlots\(\{ text, entities: \{\} \}\)/, 'the customer sentence is parsed as typed');
  assert.match(data, /handleDataPurchaseFromSlots\(\{ from, account, slots: dataSlots, rawText: text \}\)/, 'a sized ask goes to the purchase');
  assert.ok(data.indexOf('dataSlots.dataMb') < data.indexOf('handleListDataBundles('), 'the list is the fallback, not the first answer');
  assert.match(data, /isValidSaMsisdn\(dataSlots\.msisdn\)/, 'the number is re-validated as if typed');
  const elec = src.slice(src.indexOf("    case 'BUY_ELECTRICITY': {"), src.indexOf("    case 'BUY_FUEL': {"));
  assert.match(elec, /startElectricityPreviewAndConfirm\(\{ from, account, amountCents, meterNumber: meterFromText, rawText: text \}\)/, 'amount + meter go to the preview helper');
  assert.ok(!/ELECTRICITY_CONFIRM|ELECTRICITY_PIN/.test(elec), 'the dispatcher never mints a confirm or PIN state');
  const proposals = await read('lib/agent/tools/proposals.js');
  assert.ok(!proposals.includes('The dispatcher discards the meter'), 'the proposals comment tells the new truth');
});

test('the electricity fee is shown at the confirm, at the PIN and in a shortfall; no silent R50 remains', async () => {
  const src = await read('pages/api/webhooks/message-processor-v2.js');
  assert.match(src, /fee = R\$\{\(totalCents \/ 100\)\.toFixed\(2\)\}/, 'confirm shows amount + fee = total');
  assert.match(src, /💡 Electricity: R\$\{\(amountCents \/ 100\)\.toFixed\(2\)\}\$\{serviceFee > 0/, 'the PIN prompt shows the fee');
  assert.ok(!src.includes('amountCents: amountCents || 5000'), 'the silent R50 fallback is gone (BUGLOG #79, second instance)');
  assert.match(src, /with the fee\)` : ''\}`,\n\s*resumeState: 'RESUME_ELECTRICITY_PURCHASE'/, 'the electricity shortfall names the total with the fee');
});

test('the amount state does not ask for a meter it already has; a shortfall at the PIN step is parked too', async () => {
  const src = await read('pages/api/webhooks/message-processor-v2.js');
  const amt = src.slice(src.indexOf("    case 'ELECTRICITY_AMOUNT':"), src.indexOf("    case 'ELECTRICITY_METER': {"));
  assert.ok(amt.indexOf('if (existingData.meterNumber) {') > -1 && amt.indexOf('if (existingData.meterNumber) {') < amt.indexOf("updateConversationState(from, 'ELECTRICITY_METER'"), 'a known meter skips the meter ask');
  for (const state of ['AIRTIME_PIN', 'DATA_PIN', 'ELECTRICITY_PIN']) {
    const block = src.slice(src.indexOf(`    case '${state}':`), src.indexOf("\n    case '", src.indexOf(`    case '${state}':`) + 10));
    assert.ok(block.includes("executeData.code === 'INSUFFICIENT_BALANCE'"), `${state} parks a shortfall found at execute`);
  }
  for (const route of ['airtime', 'data', 'electricity']) {
    const exec = await read(`pages/api/vas/${route}/execute.js`);
    assert.ok(exec.includes("code: 'INSUFFICIENT_BALANCE'"), `${route} execute carries the code`);
  }
});

test('a run of eight or more digits is never an amount; the data matcher prefers a general bundle and names it', async () => {
  assert.equal(parseSlots('buy electricity for meter 000001020001').amountCents, null);
  assert.equal(parseSlots('buy R20 electricity for meter 000001020001').amountCents, 2000);
  assert.equal(parseSlots('0787051175').amountCents, null);
  assert.equal(parseSlots('0787051175').msisdn, '0787051175');
  const src = await read('pages/api/webhooks/message-processor-v2.js');
  const fn = src.slice(src.indexOf('async function handleDataPurchaseFromSlots('), src.indexOf('async function handleListElectricityProducts('));
  assert.match(fn, /wantsApp \? isAppBundle\(p\) : !isAppBundle\(p\)/, 'general bundle first unless an app was named');
  assert.match(fn, /Bundle: \$\{product\.label/, 'the product is named in the confirm');
  assert.match(fn, /dataMb: \{ gt: dataMb \}/, 'no exact size: the nearest is offered');
  assert.match(src, /const amountMatch = text\.match\(\/\(\?<!\\d\)r\?\\s\?\(\\d\{1,6\}\)\(\?!\\d\)\/i\);/, 'the browse follow-up amount never reads the tail of a long number');
});

test('inside a park a bare amount restarts the same purchase at that amount; a greeting keeps the park while a top-up is in flight', async () => {
  const src = await read('pages/api/webhooks/message-processor-v2.js');
  const resume = src.slice(src.indexOf("case 'RESUME_AIRTIME_PURCHASE':"), src.indexOf("case 'RESUME_VOUCHER_PURCHASE':"));
  assert.match(resume, /newAmountCents && newAmountCents > 0 && state !== 'RESUME_DATA_PURCHASE'/);
  assert.ok(resume.indexOf('newAmountCents') < resume.indexOf('balanceCents >= requiredCents'), 'the new amount is read before the balance check');
  const home = src.slice(src.indexOf('} else if (isHomeTrigger(text)) {'), src.indexOf('} else if (isHomeTrigger(text)) {') + 1400);
  assert.match(home, /parkedPurchaseAwaitsDeposit\(\{ accountId: account\.id \}\)/, 'a pending top-up keeps the park on a greeting');
  const offer = src.slice(src.indexOf('async function offerTopUpAndPark('), src.indexOf('async function offerTopUpAndPark(') + 2600);
  assert.match(offer, /needs \$\{randsShort\(gap\)\} more\./, 'the gap is stated once, plainly');
  assert.match(offer, /topUp > MAX_DEPOSIT_CENTS/, 'a gap above one deposit is said plainly, with no link');
  assert.ok(!offer.includes('finish the ${what}'), 'no "finish the the"');
});

