/**
 * The PIN chain (founder 2026-10-14, after Lisa froze on 2026-10-12): one
 * wrong PIN on a R342 withdrawal, then "Me for my password what to reset",
 * "Reset pin", "Reset pin 2006", "Reset pin", "Reset pin", each answered by
 * the model's invented "Type reset PIN and I'll help you reset it". Locks:
 * every way of asking starts a real reset (here, mid-flow, at the PIN
 * prompt); the reset is code → (the whole ID number when one is on file) →
 * new PIN twice → done; a withdrawal waiting for the PIN resumes, unless the
 * reset had no ID check and the destination is new (the cool-off); a wrong or
 * locked PIN never ends a flow, never goes silent and always names the way
 * out; a reply that repeats an instruction the customer just followed is
 * never sent. Adversarial review of 2026-10-14 folded in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { matchPinResetAsk, wrongPinText, lockedPinText, startPinReset, handlePinResetReply, isWalletPinState, PIN_RESET_STATES, pinResetCoolOff } from '../lib/pin-reset.js';
import { echoLoop, instructedPhrases, loopBreakText } from '../lib/loop-guard.js';
import { capabilityById } from '../lib/capabilities.js';
import { startWithdraw, handleWithdrawReply, executeWithdraw } from '../lib/payout-chat.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const processor = read('../pages/api/webhooks/message-processor-v2.js');
process.env.WAPAY_INTERNAL_API_KEY ||= 'test-internal-key-for-the-reset-hmac';
const lisa = { id: 'acc-lisa', waId: '27601879361', msisdn: '27601879361', displayName: 'Lisa', profile: {} };
const WITHDRAW_DATA = { method: 'PAYSHAP', amountCents: 34200, intentId: 'wa-r342', recipient: { account_number: '1234567818', branch_code: '470010', branch_name: 'Capitec' } };

function stubs({ codeOk = true, sendError = null, identity = null, identityThrows = false, failures = 0 } = {}) {
  const calls = { sent: 0, verified: [], reset: [], resets: [], idFailures: 0, alerts: [] };
  let fails = failures;
  const auth = {
    sendOTP: async (a) => { calls.sent += 1; calls.lastSend = a; return sendError ? { ok: false, error: sendError } : { ok: true, otpId: 'otp1' }; },
    verifyOTP: async ({ code }) => { calls.verified.push(code); return { ok: codeOk && code === '123456' }; },
    validatePINFormat: (pin) => (!/^\d{4,6}$/.test(pin) ? { valid: false, error: 'PIN must be 4-6 digits' } : ['0000', '1111', '1234', '4321'].some((w) => pin.includes(w)) ? { valid: false, error: 'PIN is too weak. Avoid simple patterns.' } : { valid: true }),
    resetPIN: async (a) => { calls.reset.push(a); return { ok: true }; },
  };
  const deps = {
    auth,
    loadIdentity: async () => { if (identityThrows) throw new Error('db down'); return identity; },
    idFailures: async () => fails,
    recordIdFailure: async () => { calls.idFailures += 1; fails += 1; },
    recordReset: async (a) => { calls.resets.push(a); },
    sendOpsAlert: async (a) => { calls.alerts.push(a); return { success: true }; },
  };
  return { calls, deps };
}
async function run(deps, steps, start) {
  let st = start;
  const out = [];
  for (const text of steps) { st = await handlePinResetReply({ account: lisa, state: st.state, data: st.data, text, deps }); out.push(st); if (!st.state) break; }
  return out;
}

test('every way Lisa asked (and the usual others) starts the reset; voucher PINs, tokens and bare digits do not; at a PIN prompt "I forgot it" does', () => {
  for (const t of ['Me for my password what to reset', 'Reset pin', 'Reset pin 2006', 'reset PIN', 'I forgot my PIN', 'forgot pin', 'forgot PIN', 'change my pin', 'my pin is not working', 'my PIN is locked', 'I want a new password', 'ek het my pin vergeet', 'help me with my pin']) assert.ok(matchPinResetAsk(t), t);
  for (const t of ['2006', 'I lost my voucher pin', 'voucher pin 1234', 'my electricity token', 'what is my balance', 'forget my bank details', 'forget me', 'withdraw 50', 'Enter your PIN', 'my PIN is 2006', 'I forgot it', '']) assert.ok(!matchPinResetAsk(t), t);
  for (const t of ['I forgot it', 'forgot', "I don't remember", 'I forgot my pin for the voucher', 'Reset pin']) assert.ok(matchPinResetAsk(t, { atPinPrompt: true }), `at a PIN prompt: ${t}`);
  assert.ok(!matchPinResetAsk('2006', { atPinPrompt: true }));
  assert.ok(matchPinResetAsk(capabilityById('PIN_RESET').startCommand), 'the command the model is told to name is the one the router acts on');
});

test('a wrong PIN and a lock always name the way out, never "try again later"', () => {
  assert.equal(wrongPinText(), '❌ That PIN is not right. Try again, or reply "cancel". Forgot it? Say *forgot PIN* and I will help you set a new one.');
  const now = new Date('2026-10-12T16:50:00Z');
  assert.match(lockedPinText({ lockedUntil: new Date(now.getTime() + 15 * 60000), now }), /locked for 15 minutes after 5 wrong tries\. Say \*forgot PIN\* to set a new one now/);
  assert.match(lockedPinText({ lockedUntil: new Date(now.getTime() + 365 * 86400000), now }), /locked after too many wrong tries\. Say \*forgot PIN\* to set a new one now/, 'the 10-try lock (a year) has a way out');
  for (const t of [wrongPinText(), lockedPinText()]) assert.ok(!/later|—/.test(t), t);
});

test('Lisa (no ID on file): code from a sentence, new PIN twice from sentences; the R342 to an unsaved account waits out the cool-off; with the cool-off off it resumes', async () => {
  const { calls, deps } = stubs();
  const s0 = await startPinReset({ account: lisa, fromState: 'PAYOUT_PIN', fromData: WITHDRAW_DATA, deps });
  assert.equal(s0.state, 'PIN_RESET_CODE'); assert.equal(calls.sent, 1); assert.equal(calls.lastSend.msisdn, '27601879361');
  assert.match(s0.text, /I have just sent you a 6-digit code in a separate message\. Type the code here/);
  assert.deepEqual(s0.data.resume, { state: 'PAYOUT_PIN', data: WITHDRAW_DATA });
  const bad = await handlePinResetReply({ account: lisa, state: s0.state, data: s0.data, text: '654321', deps });
  assert.equal(bad.state, 'PIN_RESET_CODE'); assert.match(bad.text, /not right or has expired/);
  const again = await handlePinResetReply({ account: lisa, state: s0.state, data: s0.data, text: 'I did not get the code', deps });
  assert.equal(again.state, 'PIN_RESET_CODE'); assert.equal(calls.sent, 2, 'resend sends a new code'); assert.deepEqual(again.data.resume, s0.data.resume);
  const [s1, weak, s2, miss] = await run(deps, ['the code is 123 456'], s0).then(async ([a]) => [a, ...(await Promise.all([
    handlePinResetReply({ account: lisa, state: a.state, data: a.data, text: '1234', deps }),
    handlePinResetReply({ account: lisa, state: a.state, data: a.data, text: 'my new pin is 2580', deps }),
  ])), null]);
  assert.equal(s1.state, 'PIN_RESET_NEW', 'no ID on file: straight to the new PIN'); assert.equal(s1.data.idChecked, false);
  assert.match(weak.text, /too easy to guess/);
  assert.equal(s2.state, 'PIN_RESET_CONFIRM', 'the PIN is read out of the sentence'); assert.ok(!JSON.stringify(s2.data).includes('2580'), 'the new PIN is never stored in clear');
  const mismatch = await handlePinResetReply({ account: lisa, state: s2.state, data: s2.data, text: '2581', deps });
  assert.equal(mismatch.state, 'PIN_RESET_NEW'); assert.match(mismatch.text, /did not match, so your PIN is unchanged/); assert.equal(calls.reset.length, 0);
  const done = await handlePinResetReply({ account: lisa, state: s2.state, data: s2.data, text: '2580', deps });
  assert.deepEqual(calls.reset, [{ accountId: 'acc-lisa', newPin: '2580', otpVerified: true }]); assert.deepEqual(calls.resets, [{ accountId: 'acc-lisa', idChecked: false }]);
  assert.equal(done.state, null, 'a withdrawal to an account not saved before the reset does not resume while the cool-off runs');
  assert.match(done.text, /✅ Your new PIN is set and your PIN is unlocked\./); assert.match(done.text, /for the next 24 hours a withdrawal can only go to an account or number you saved before today/); assert.match(done.text, /Your withdrawal is cancelled for now and nothing left your balance\./);
  process.env.WAPAY_PIN_RESET_COOLOFF_HOURS = '0';
  const doneOff = await handlePinResetReply({ account: lisa, state: s2.state, data: s2.data, text: '2580', deps });
  assert.equal(doneOff.state, 'PAYOUT_PIN'); assert.deepEqual(doneOff.data, WITHDRAW_DATA); assert.match(doneOff.text, /Your withdrawal of R342 is still waiting\. Enter your new PIN to finish it/);
  delete process.env.WAPAY_PIN_RESET_COOLOFF_HOURS;
  assert.ok(!/—/.test(done.text + doneOff.text));
});

test('with an ID on file: the whole number (never its tail), failures counted across resets, a person only when the alert went; the waiting withdrawal resumes with no cool-off', async () => {
  const { calls, deps } = stubs({ identity: { idNumber: '9001015009085', idType: 'RSAID' } });
  const s0 = await startPinReset({ account: lisa, fromState: 'PAYOUT_PIN', fromData: WITHDRAW_DATA, deps });
  const s1 = await handlePinResetReply({ account: lisa, state: s0.state, data: s0.data, text: '123456', deps });
  assert.equal(s1.state, 'PIN_RESET_ID'); assert.match(s1.text, /type the ID or passport number you gave for withdrawals \(the whole number\)/);
  const tail = await handlePinResetReply({ account: lisa, state: s1.state, data: s1.data, text: '085', deps });
  assert.equal(tail.state, 'PIN_RESET_ID', 'the last 3 digits (shown in chat elsewhere) are not enough'); assert.equal(calls.idFailures, 1);
  const ok = await handlePinResetReply({ account: lisa, state: s1.state, data: s1.data, text: '900101 5009 085', deps });
  assert.equal(ok.state, 'PIN_RESET_NEW'); assert.equal(ok.data.idChecked, true);
  const s2 = await handlePinResetReply({ account: lisa, state: ok.state, data: ok.data, text: '2580', deps });
  const done = await handlePinResetReply({ account: lisa, state: s2.state, data: s2.data, text: '2580', deps });
  assert.equal(done.state, 'PAYOUT_PIN', 'an ID-checked reset resumes the withdrawal'); assert.ok(!/24 hours/.test(done.text)); assert.deepEqual(calls.resets.at(-1), { accountId: 'acc-lisa', idChecked: true });
  // Three wrong numbers (counted per account, across resets): paused, a person only when the alert went.
  const three = stubs({ identity: { idNumber: '9001015009085' }, failures: 2 });
  const third = await handlePinResetReply({ account: lisa, state: 'PIN_RESET_ID', data: { codeOk: true }, text: '1111111111111', deps: three.deps });
  assert.equal(third.state, null); assert.match(third.text, /paused for 24 hours\. I have asked a person from the WaPay team/); assert.ok(!/27601879361/.test(three.calls.alerts[0].detailsHtml));
  const noMail = stubs({ identity: { idNumber: '9001015009085' }, failures: 2 });
  noMail.deps.sendOpsAlert = async () => ({ success: false });
  const thirdNoMail = await handlePinResetReply({ account: lisa, state: 'PIN_RESET_ID', data: { codeOk: true }, text: '1111111111111', deps: noMail.deps });
  assert.ok(!/asked a person/.test(thirdNoMail.text) && /Please contact the WaPay team/.test(thirdNoMail.text));
  const paused = stubs({ identity: { idNumber: '9001015009085' }, failures: 3 });
  const p0 = await startPinReset({ account: lisa, deps: paused.deps });
  const p1 = await handlePinResetReply({ account: lisa, state: p0.state, data: p0.data, text: '123456', deps: paused.deps });
  assert.equal(p1.state, null); assert.match(p1.text, /PIN reset is paused for 24 hours/);
  // A read error never skips the check.
  const broken = stubs({ identityThrows: true });
  const b0 = await startPinReset({ account: lisa, deps: broken.deps });
  const b1 = await handlePinResetReply({ account: lisa, state: b0.state, data: b0.data, text: '123456', deps: broken.deps });
  assert.equal(b1.state, null); assert.match(b1.text, /could not finish the safety check just now, so your PIN is unchanged/);
});

test('a purchase that was waiting is asked again (its quote expires in minutes); cancel and other requests leave the PIN; no code, no new PIN; no secret, no reset', async () => {
  const { calls, deps } = stubs();
  const s0 = await startPinReset({ account: lisa, fromState: 'AIRTIME_PIN', fromData: { previewId: 'p1', amountCents: 5000 }, deps });
  assert.deepEqual(s0.data.resume, { state: 'AIRTIME_PIN', data: {} }, 'a purchase quote is not carried through the reset');
  const [a, b, c] = await run(deps, ['123456', '2580', '2580'], s0);
  assert.equal(c.state, null); assert.match(c.text, /Ask for your airtime again and use your new PIN at the end/);
  for (const [state, data] of [['PIN_RESET_CODE', {}], ['PIN_RESET_ID', { codeOk: true }], ['PIN_RESET_NEW', { codeOk: true }], ['PIN_RESET_CONFIRM', { codeOk: true, pinHmac: 'x' }]]) {
    const r = await handlePinResetReply({ account: lisa, state, data, text: 'cancel', deps });
    assert.equal(r.state, null); assert.match(r.text, /PIN reset cancelled\. Your PIN is unchanged/);
  }
  assert.deepEqual(await handlePinResetReply({ account: lisa, state: 'PIN_RESET_NEW', data: { codeOk: true }, text: 'buy airtime', deps }), { state: null, passthrough: true });
  assert.equal((await handlePinResetReply({ account: lisa, state: 'PIN_RESET_NEW', data: {}, text: '2580', deps })).state, null, 'no new PIN without a confirmed code');
  assert.equal(calls.reset.length, 1);
  const keys = { a: process.env.WAPAY_INTERNAL_API_KEY, b: process.env.WAPAY_PII_KEY, c: process.env.PIN_PEPPER };
  delete process.env.WAPAY_INTERNAL_API_KEY; delete process.env.WAPAY_PII_KEY; delete process.env.PIN_PEPPER;
  const noKey = await startPinReset({ account: lisa, deps });
  assert.equal(noKey.state, null); assert.match(noKey.text, /not available right now/, 'no deployment secret, no reset (never a key from the source)');
  Object.assign(process.env, Object.fromEntries(Object.entries({ WAPAY_INTERNAL_API_KEY: keys.a, WAPAY_PII_KEY: keys.b, PIN_PEPPER: keys.c }).filter(([, v]) => v !== undefined)));
  const busy = await startPinReset({ account: lisa, deps: stubs({ sendError: 'TOO_MANY_REQUESTS' }).deps });
  assert.equal(busy.state, 'PIN_RESET_CODE'); assert.match(busy.text, /A code was already sent a few minutes ago/);
  const failed = await startPinReset({ account: lisa, deps: stubs({ sendError: 'SEND_FAILED' }).deps });
  assert.equal(failed.state, null); assert.match(failed.text, /could not send the code just now, so your PIN is unchanged/);
  assert.ok(isWalletPinState('PAYOUT_PIN') && isWalletPinState('AIRTIME_PIN') && !isWalletPinState('VOUCHER_PIN') && !isWalletPinState('AWAITING_VOUCHER_PIN') && !isWalletPinState('PIN_RESET_CODE'));
});

test('the cool-off in the withdraw flow: only destinations saved before the reset, said with the time; an ID-checked reset has none', async () => {
  process.env.WAPAY_PAYOUT_ENABLED = 'true'; process.env.WAPAY_PAYOUT_KYC = 'off';
  const now = new Date();
  const reset = (idChecked) => ({ ...lisa, profile: { pinReset: { at: new Date(now.getTime() - 3600e3).toISOString(), idChecked } } });
  assert.equal(pinResetCoolOff({ account: reset(true) }), null);
  assert.ok(pinResetCoolOff({ account: reset(false) })?.until > now);
  assert.equal(pinResetCoolOff({ account: { ...lisa, profile: { pinReset: { at: new Date(now.getTime() - 25 * 3600e3).toISOString(), idChecked: false } } } }), null, 'over after 24 hours');
  const LIVE = [{ method: 'PAYSHAP', providerCode: '66', providerName: 'PayShap Account', minCents: 5000, maxCents: 15000000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile', 'account_number', 'branch_code'] }];
  const base = { payoutBalances: async () => ({ totalCents: 35000, spendCents: 35000, cashCents: 0 }), resolveProviders: async () => LIVE, moneySituation: async () => null, gateHistory: async () => ({ count: 0, personAsked: false }) };
  const none = await startWithdraw({ account: reset(false), ask: { method: 'PAYSHAP', amountCents: 5000 }, deps: base });
  assert.equal(none.state, null); assert.match(none.text, /Your PIN was reset recently, so for your safety withdrawals open again on \d+ \w+ at \d\d:\d\d/); assert.match(none.text, /Airtime, data, electricity and everything else work now/);
  const withSaved = { ...base, beneficiariesAvailable: () => true, listDestinations: async () => [{ id: 'd1', method: 'PAYSHAP', family: 'BANK', label: 'Capitec account •••818' }] };
  const s0 = await startWithdraw({ account: reset(false), ask: { method: 'PAYSHAP', amountCents: 5000 }, deps: withSaved });
  assert.equal(s0.state, 'PAYOUT_ACCOUNT');
  const typed = await handleWithdrawReply({ account: reset(false), state: s0.state, data: s0.data, text: '62099988877' });
  assert.equal(typed.state, 'PAYOUT_ACCOUNT'); assert.match(typed.text, /can only go to an account or number saved before the reset/);
  const unsaved = await executeWithdraw({ account: reset(false), data: { ...WITHDRAW_DATA }, deps: { requestPayout: async () => { throw new Error('must not be called'); } } });
  assert.equal(unsaved.done, false); assert.match(unsaved.text, /Nothing was sent and nothing has left your balance/);
  const fine = await startWithdraw({ account: reset(true), ask: { method: 'PAYSHAP', amountCents: 5000 }, deps: base });
  assert.equal(fine.state, 'PAYOUT_ACCOUNT', 'an ID-checked reset has no cool-off');
});

test('static: the processor starts the reset from any state and outside one, before the agent; the four states are wired; digits hidden in memory and logs', () => {
  const inState = processor.indexOf('if (matchPinResetAsk(text, { atPinPrompt: isWalletPinState(state) })) return await handlePinResetStart({ from, account, fromState: state, fromData: data });');
  const escape = processor.indexOf('const switched = detectStrongIntentSwitch(text, state);');
  assert.ok(inState > -1 && inState < escape, 'mid-flow (the PIN prompt included) the reset wins over every escape');
  assert.match(processor, /if \(state && !\/\^\(\?:PIN_RESET_\|BIZ_SIGNUP_\)\|\^\(\?:VOUCHER_PIN\|AWAITING_VOUCHER_PIN\)\$\/\.test\(String\(state\)\)\)/, 'never inside the reset, a voucher-code step or a business name');
  const top = processor.indexOf('if (matchPinResetAsk(text)) return await handlePinResetStart({ from, account });');
  const agent = processor.indexOf('if (agentV3For(from)) {\n    return await handleAgentTurn({ from, text, account, messageId });');
  assert.ok(top > -1 && top < agent, 'outside a flow the reset runs before the agent and the intent hooks');
  for (const st of PIN_RESET_STATES) assert.ok(processor.includes(`    case '${st}':`), st);
  assert.match(processor, /inPinState: \/_PIN\$\|PIN_RESEND_AUTH\|AWAITING_VOUCHER_PIN\|\^PIN_RESET_\//);
  assert.match(read('../pages/api/webhooks/whatsapp.js'), /\.replace\(\/\("body"\\s\*:\\s\*"\)\\s\*\[\\d\\s-\]\{4,24\}\\s\*\("\)\/g, '\$1\[digits\]\$2'\)/, 'a bare PIN or code never reaches the webhook log');
  assert.ok(!/Code: \$\{code\}\)/.test(read('../packages/auth/src/otp.ts')), 'the OTP is never logged whole');
  assert.match(read('../packages/auth/src/pin.ts'), /\(argon2 as any\)\.argon2id \?\? \(argon2 as any\)\.default\?\.argon2id \?\? 2/);
});

test('static: a wrong or locked PIN keeps every flow waiting with the way out; the 5th wrong PIN reads as a lock; nothing says "try again later" or goes silent', () => {
  for (const st of ['DATA_PIN', 'AIRTIME_PIN', 'ELECTRICITY_PIN', 'FUEL_PIN', 'VOUCHER_GIFT_PIN']) assert.ok(processor.includes(`return await replyPinFailure({ from, account, state: '${st}', data, executeData });`), st);
  const fn = processor.slice(processor.indexOf('async function replyPinFailure'), processor.indexOf('async function handleWithdrawState'));
  assert.match(fn, /await updateConversationState\(from, state, data \|\| \{\}\);/); assert.ok(!/sendWhatsAppErrorOnce/.test(fn));
  assert.equal((processor.match(/pinResult\.error === 'SOFT_LOCKOUT' \|\| pinResult\.lockedUntil\)/g) || []).length, 2, 'withdraw and pay link: INVALID_PIN with a lock time is a lock');
  for (const f of ['airtime', 'data', 'electricity', 'fuel', 'voucher']) assert.match(read(`../pages/api/vas/${f}/execute.js`), /message: 'Invalid PIN',?\s*lockedUntil: pinResult\.lockedUntil\?\.toISOString\(\)/, f);
  assert.ok(!/Too many incorrect PIN attempts\. Please try again later|Incorrect PIN\. Try again, or reply "cancel"\./.test(processor), 'the old dead-end lines are gone');
});

test('the loop guard: an instruction repeated after the customer followed it is never sent; a first instruction or a sentence is fine; both brains use it', () => {
  const asked = 'No stress. Type "reset PIN" and I’ll help you reset it 🔐✨';
  assert.ok(echoLoop('Please type *reset PIN* to reset your PIN 🔐✨', 'Reset pin', asked));
  assert.ok(echoLoop('Please type *reset PIN* to reset your PIN 🔐✨', 'Reset pin 2006', asked));
  assert.ok(!echoLoop(asked, 'Me for my password what to reset', ''), 'the first instruction is not a loop');
  assert.ok(!echoLoop('Your balance is R50. Type *balance* any time.', 'balance', '👋 Hi Lisa!'), 'not a loop when the previous reply never asked');
  assert.ok(!echoLoop('Say *withdraw* and the amount, like "withdraw R50".', 'I want to withdraw', 'Say *withdraw* and the amount'));
  assert.deepEqual(instructedPhrases('Reply *YES* to start, or say "cancel".'), ['YES', 'cancel']);
  assert.match(loopBreakText({ personAsked: true }), /I have asked a person from the WaPay team/); assert.ok(!/person/.test(loopBreakText({ personAsked: false })));
  assert.match(processor, /finalText = \(await breakEchoLoop\(\{ from, account, reply: finalText, inbound: text, source: result\.action \}\)\) \|\| finalText;\n  return await sendWhatsAppText\(\{ to: from, text: finalText \}\);/, 'two-tier path: checked right before the model text is sent');
  assert.match(processor, /const broken = await breakEchoLoop\(\{ from, account, reply: out, inbound: text, source: 'agent' \}\);/, 'agent path too');
});

test('static: the failure counter queries the audit table by its real time column (the harness caught createdAt, which made every ID check fail closed)', () => {
  const schema = read('../packages/domain/prisma/schema.prisma');
  const audit = schema.slice(schema.indexOf('model AuditLog {'), schema.indexOf('}', schema.indexOf('model AuditLog {')));
  assert.match(audit, /\btimestamp\s+DateTime/); assert.ok(!/\bcreatedAt\b/.test(audit));
  const src = read('../lib/pin-reset.js');
  assert.match(src, /event: 'PIN_RESET_ID_FAILED', timestamp: \{ gte:/);
  assert.ok(!/auditLog\.(?:count|findMany|findFirst)\(\{[^)]*createdAt/.test(src), 'no audit query by createdAt');
});
