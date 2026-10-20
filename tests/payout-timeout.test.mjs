/**
 * Lisa, 2026-10-15 (BUGLOG #111, #113): her withdrawal timed out at the ID
 * step; four hours later her ID went to the AI, which wrote "Now enter your
 * WaPay PIN to confirm the payout"; her PIN went to the AI too, which wrote
 * "Your payout is being confirmed now". Nothing was sent. Every link of
 * that chain is locked here, with synthetic numbers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { lateWithdrawAnswer, resumeLateWithdraw } from '../lib/payout-chat.js';
import { bareSecretKind, bareSecretReply, looksLikeSaId, nothingPendingLine, privacyBlockedLine, expiredStepText } from '../lib/money-truth.js';
import { outputGate } from '../lib/agent/guards.js';
import { handlePinResetReply } from '../lib/pin-reset.js';
import { sealFlowData, unsealFlowData, hasPlainSecrets } from '../lib/flow-seal.js';
import { redactForMemory } from '../lib/turns.js';
import { privacyNamesFor } from '../lib/privacy-names.js';

const ID = '8001015009087';
const HOUR = 3600 * 1000;
const lisa = { id: 'acc-lisa', displayName: 'Lisa', profile: {} };
const atId = { method: 'PAYSHAP', amountCents: 34200, intentId: 'wa-lisa', balanceCents: 35000, recipient: { account_number: '1234567890', branch_code: '470010', branch_name: 'Capitec', fullName: 'Ruth Mahlangu' }, options: ['PAYSHAP'], limits: { PAYSHAP: { minCents: 5000, maxCents: 300000 } } };

test('a late answer to the step that expired carries the withdrawal on; a late yes or PIN is confirmed again; too late is said plainly', () => {
  const now = Date.now();
  const fourHoursAgo = new Date(now - 4 * HOUR).toISOString();
  assert.equal(lateWithdrawAnswer({ state: 'PAYOUT_ID', data: atId, text: ID, setAt: fourHoursAgo, now }), 'RESUME', 'her ID, four hours later');
  assert.equal(lateWithdrawAnswer({ state: 'PAYOUT_ID', data: atId, text: 'FN123456', setAt: fourHoursAgo, now }), 'RESUME');
  assert.equal(lateWithdrawAnswer({ state: 'PAYOUT_NAME', data: atId, text: 'Ruth Mahlangu', setAt: fourHoursAgo, now }), 'RESUME');
  assert.equal(lateWithdrawAnswer({ state: 'PAYOUT_NAME', data: atId, text: 'Thank you', setAt: fourHoursAgo, now }), null, 'a courtesy is not a name');
  assert.equal(lateWithdrawAnswer({ state: 'PAYOUT_NAME', data: atId, text: 'Good morning', setAt: fourHoursAgo, now }), null);
  assert.equal(lateWithdrawAnswer({ state: 'PAYOUT_CONFIRM', data: atId, text: 'yes', setAt: fourHoursAgo, now }), 'RECONFIRM');
  assert.equal(lateWithdrawAnswer({ state: 'PAYOUT_PIN', data: atId, text: '2580', setAt: fourHoursAgo, now }), 'RECONFIRM', 'a late PIN never approves');
  assert.equal(lateWithdrawAnswer({ state: 'PAYOUT_ID', data: atId, text: 'buy airtime R10', setAt: fourHoursAgo, now }), null, 'another flow is new');
  assert.equal(lateWithdrawAnswer({ state: 'PAYOUT_ID', data: atId, text: 'cancel', setAt: fourHoursAgo, now }), null);
  assert.equal(lateWithdrawAnswer({ state: 'PAYOUT_ID', data: atId, text: ID, setAt: new Date(now - 30 * HOUR).toISOString(), now }), 'STOPPED');
  assert.equal(lateWithdrawAnswer({ state: 'PAYOUT_AMOUNT', data: atId, text: '342', setAt: fourHoursAgo, now }), null, 'an early step starts fresh');
});

test('resumed, the money is read again; a late PIN is said not to be used; too late, nothing moved', async () => {
  const now = Date.now();
  const deps = { payoutBalances: async () => ({ totalCents: 20000 }), pinResetCoolOff: () => null };
  const r = await resumeLateWithdraw({ account: lisa, state: 'PAYOUT_ID', data: atId, text: ID, setAt: new Date(now - 4 * HOUR).toISOString(), deps, now });
  assert.equal(r.resume, true); assert.equal(r.data.balanceCents, 20000, 'the balance is today\'s, never the one from four hours ago');
  const p = await resumeLateWithdraw({ account: lisa, state: 'PAYOUT_PIN', data: atId, text: '2580', setAt: new Date(now - 4 * HOUR).toISOString(), deps, now });
  assert.equal(p.state, 'PAYOUT_CONFIRM');
  assert.match(p.text, /I did not use the PIN you just sent\. Nothing has been sent yet\./);
  assert.match(p.text, /Reply \*YES\* to continue to your PIN/);
  const s = await resumeLateWithdraw({ account: lisa, state: 'PAYOUT_ID', data: atId, text: ID, setAt: new Date(now - 30 * HOUR).toISOString(), deps, now });
  assert.equal(s.state, null); assert.match(s.text, /Nothing was sent and your money has not moved\. Say \*withdraw\* to start again\./);
  const broken = await resumeLateWithdraw({ account: lisa, state: 'PAYOUT_ID', data: atId, text: ID, setAt: new Date(now - 4 * HOUR).toISOString(), deps: { ...deps, payoutBalances: async () => { throw new Error('db'); } }, now });
  assert.equal(broken.state, null, 'no fresh balance, no resume');
});

test('a bare PIN, ID or passport with nothing waiting is answered without a model', () => {
  assert.equal(looksLikeSaId(ID), true); assert.equal(looksLikeSaId('1234567890123'), false);
  assert.equal(bareSecretKind('2580'), 'PIN'); assert.equal(bareSecretKind(ID), 'ID'); assert.equal(bareSecretKind('FN123456'), 'PASSPORT');
  for (const not of ['0821234567', 'R1000', '1000MB', 'hello', '1234 5678 9012 3456', '342 PayShap']) assert.equal(bareSecretKind(not), null, not);
  assert.match(bareSecretReply('PIN'), /did not use that number/);
  assert.match(bareSecretReply('ID'), /did not use it or keep it/);
  assert.match(expiredStepText(), /did not use what you just sent, and nothing was paid/);
  assert.match(privacyBlockedLine(), /I do not read ID, passport, bank account or PIN numbers in a chat message/);
  assert.match(nothingPendingLine(35000), /no withdrawal is in progress right now\. 💰 Balance to spend: R350\./);
});

test("the output gate blocks Lisa's two exact sentences on both brains' rule set, and allows a real pending pay-out", () => {
  assert.equal(outputGate('Thanks. Now enter your WaPay PIN to confirm the payout 💰').rule, 'PIN_ASK');
  assert.equal(outputGate('Thanks 💰 Your payout is being confirmed now.').rule, 'MONEY_CLAIM');
  assert.equal(outputGate('Thanks 💰 Your payout is being confirmed now.', { payoutPending: true }).ok, true, 'true when the record has one');
  for (const fine of ['Send me the 16-digit PIN of your OTT voucher and I load its value.', 'Never share your PIN with anyone.', 'Say *forgot PIN* and I will help you set a new one.', 'Once you confirm, your withdrawal will arrive in your bank.']) assert.equal(outputGate(fine, { withdrawLive: true }).ok, true, fine);
});

test('"Let\'s set a new pin" inside a running reset stays in it: no second code', async () => {
  let sent = 0;
  const deps = { auth: { sendOTP: async () => { sent += 1; return { ok: true }; }, verifyOTP: async () => ({ ok: false }) } };
  const r = await handlePinResetReply({ account: lisa, state: 'PIN_RESET_CODE', data: {}, text: "Let's set a new pin", deps });
  assert.equal(r.state, 'PIN_RESET_CODE');
  assert.match(r.text, /We are already resetting your PIN\. Type the 6-digit code/);
  assert.equal(sent, 0);
});

test('a bank account or ID typed mid-flow is stored sealed; plain without the key; unreadable means start fresh, never half', () => {
  const saved = process.env.WAPAY_PII_KEY;
  try {
    delete process.env.WAPAY_PII_KEY;
    assert.deepEqual(sealFlowData(atId), atId, 'no key: unchanged, as before');
    process.env.WAPAY_PII_KEY = crypto.randomBytes(32).toString('hex');
    const sealed = sealFlowData({ ...atId, recipient: { ...atId.recipient, id_number: ID }, idPending: 'FN123456' });
    const raw = JSON.stringify(sealed);
    for (const leak of ['1234567890', ID, 'FN123456']) assert.ok(!raw.includes(leak), `no ${leak} at rest`);
    assert.equal(hasPlainSecrets(sealed), false);
    const opened = unsealFlowData(sealed);
    assert.equal(opened.data.recipient.account_number, '1234567890'); assert.equal(opened.data.recipient.id_number, ID); assert.equal(opened.data.idPending, 'FN123456');
    assert.deepEqual(unsealFlowData(atId).data, atId, 'a plain row written before the key still reads');
    assert.deepEqual(sealFlowData(sealed), sealed, 'sealing twice changes nothing');
    process.env.WAPAY_PII_KEY = crypto.randomBytes(32).toString('hex');
    assert.deepEqual(unsealFlowData(sealed), { data: null, unreadable: true }, 'another key: the flow starts fresh');
  } finally {
    if (saved) process.env.WAPAY_PII_KEY = saved; else delete process.env.WAPAY_PII_KEY;
  }
});

test('memory keeps no account-holder name: the name step and our own confirmation line', () => {
  assert.equal(redactForMemory('Ruth Mahlangu', { nameInput: true }), '[name]');
  assert.match(redactForMemory('Please confirm:\nName on the account: Ruth Mahlangu\nFee: R8'), /Name on the account: \[name\]\nFee: R8/);
  assert.equal(redactForMemory('Ruth Mahlangu'), 'Ruth Mahlangu', 'off by default: the rest of memory keeps real text');
});

test('the names a request knows, for the boundary', () => {
  const names = privacyNamesFor({ account: { displayName: 'Lisa', profile: { kyc: { fullName: 'Ruth Mahlangu' } } }, data: atId, pack: { beneficiaries: [{ name: 'Thandi Nkosi' }], pendingPayout: { counterparty: 'Sipho' } } });
  for (const n of ['Lisa', 'Ruth Mahlangu', 'Thandi Nkosi', 'Sipho']) assert.ok(names.includes(n), n);
});
