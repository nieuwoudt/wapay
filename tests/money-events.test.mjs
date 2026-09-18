/**
 * C14: a money outcome the customer was not told about still reaches the
 * agent, and a bearer PIN never strands (2026-09-18).
 *
 * The rule: when the ledger moves and nothing reaches the customer, the fact
 * goes into the history the agent reads as a `role: 'event'` turn. Otherwise
 * its next turn sees a movement list that changed for reasons it cannot
 * explain, and it answers "did my deposit land" from a record with a hole in
 * it. `recordMoneyEvent` is written ONLY when nothing was delivered, so a
 * successful notification never appears twice.
 *
 * Three producers existed on paper and one in the code. These are the other
 * two, plus the gift-claim case where the right answer is not an event row at
 * all but putting the gift back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const payouts = read('../lib/payouts.js');
const itn = read('../pages/api/payfast/itn.js');
const processor = read('../pages/api/webhooks/message-processor-v2.js');

test('the pay-out sweep records the fact on every way of not telling the customer', () => {
  const sweep = payouts.slice(payouts.indexOf('for (const r of results) {'));
  assert.match(sweep, /const recordUntold = async \(\) => \{/, 'one helper, used on every untold path');
  // Three ways to end up with a moved ledger and a silent customer.
  assert.match(sweep, /reason: 'NO_WA_ID'[\s\S]{0,120}?await recordUntold\(\)/, 'an account we cannot address');
  assert.match(sweep, /sent\.error \|\| 'SEND_FAILED'[\s\S]{0,120}?await recordUntold\(\)/, 'a send that came back not ok');
  assert.match(sweep, /catch \(error\) \{[\s\S]{0,260}?await recordUntold\(\)\.catch/, 'a throw in the notify block');
  // And all three are counted, so Mission Control shows them.
  assert.equal((sweep.match(/counts\.notifyFailed \+= 1/g) || []).length, 3);
  assert.ok(!/recordUntold\(\)/.test(sweep.slice(sweep.indexOf('notified.push(r.reference)'), sweep.indexOf('} catch (error) {'))),
    'a customer who WAS told gets no event row');
});

test('a deposit that lands without reaching the customer is written into the record', () => {
  assert.match(itn, /import \{ recordMoneyEvent \} from '\.\.\/\.\.\/\.\.\/lib\/notify\.js';/);
  const block = itn.slice(itn.indexOf('// DEPOSIT confirmation'), itn.indexOf('// Request notifications'));
  assert.match(block, /if \(!confirmSent\?\.ok\) \{[\s\S]{0,400}?recordMoneyEvent\(/, 'a send that failed');
  assert.match(block, /catch \(error\) \{[\s\S]{0,400}?recordMoneyEvent\(/, 'and a send that threw');
  assert.match(block, /kind: 'deposit'/);
  // The happy path must not write one: the confirmation is already recorded
  // by lib/say.js, and a duplicate would read as two deposits.
  const happy = block.slice(0, block.indexOf('if (!confirmSent?.ok)'));
  assert.ok(!/recordMoneyEvent/.test(happy));
});

test('a gift claimed but not sent is put back, however the turn failed', () => {
  const block = processor.slice(processor.indexOf('const claimedUnsent = [];'), processor.indexOf('// Check if user is in a conversation state'));
  assert.match(block, /claimedUnsent\.push\(\.\.\.gifts\.map\(\(g\) => g\.id\)\)/, 'every claim is tracked from the moment it is made');
  assert.equal((block.match(/claimedUnsent\.splice\(/g) || []).length, 2, 'cleared on a successful send and on the explicit revert');
  assert.match(block, /catch \(claimError\) \{[\s\S]*?for \(const giftId of claimedUnsent\) \{[\s\S]*?revertGiftDelivery\(\{ giftId \}\)/,
    'a throw reverts whatever was claimed and never sent');
  // NOT an event row: the PIN never reached them, so saying a voucher was
  // delivered would be false. The gift goes back and the next message retries.
  assert.ok(!/recordMoneyEvent/.test(block));
});
