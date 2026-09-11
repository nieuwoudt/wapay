/**
 * Withdrawals in chat (lib/payout-chat.js): the matcher, the identity gate,
 * every step, the confirm → PIN hand-off, and the one money call after the
 * PIN, driven with stubs. The processor wiring is source-locked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { matchWithdrawAsk, parseMethodChoice, parseRandAmount, bankToBranch, startWithdraw, handleWithdrawReply, executeWithdraw, PAYOUT_STATES } from '../lib/payout-chat.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
function env(on = true) { process.env.WAPAY_PAYOUT_ENABLED = on ? 'true' : ''; delete process.env.WAPAY_PAYOUT_KYC; }
const verified = { id: 'acc-1', msisdn: '27731234567', waId: '27731234567', displayName: 'Lerato M', profile: { kyc: { status: 'VERIFIED', fullName: 'Lerato Mokoena' } } };
const unverified = { id: 'acc-2', msisdn: '27731234568', waId: '27731234568', displayName: 'Thabo', profile: {} };
const deps = (totalCents = 100000, result) => { const obj = { payoutBalances: async () => ({ spendCents: totalCents, cashCents: 0, totalCents }), requestPayout: async (args) => { obj.last = args; return result || { ok: true, status: 'SETTLED', reference: 'WPTEST', amountCents: args.amountCents, feeCents: 600 }; } }; return obj; };

test('matcher: withdrawal asks with amount and method hints; payment-request asks are not withdrawals', () => {
  assert.deepEqual(matchWithdrawAsk('withdraw R200'), { amountCents: 20000, method: null });
  assert.deepEqual(matchWithdrawAsk('I want to cash out 150 to my bank'), { amountCents: 15000, method: 'RTC' });
  assert.deepEqual(matchWithdrawAsk('payshap 50.50'), { amountCents: 5050, method: 'PAYSHAP' });
  assert.deepEqual(matchWithdrawAsk('cash at atm'), { amountCents: null, method: 'CASHSEND' });
  assert.deepEqual(matchWithdrawAsk('How do I withdraw my money to my bank account?'), { amountCents: null, method: 'RTC' });
  for (const t of ['please pay me R150', 'buy airtime', 'my balance', 'send R50 to 0731234567', '']) assert.equal(matchWithdrawAsk(t), null, t);
  assert.equal(parseMethodChoice('2'), 'RTC'); assert.equal(parseMethodChoice('PayShap please'), 'PAYSHAP'); assert.equal(parseMethodChoice('cash at the ATM'), 'CASHSEND'); assert.equal(parseMethodChoice('blue'), null);
  assert.equal(parseRandAmount('R150,50'), 15050); assert.equal(parseRandAmount('200'), 20000); assert.equal(parseRandAmount('two hundred'), null);
  assert.deepEqual(bankToBranch('Capitec'), { branch_code: '470010', branch_name: 'Capitec' }); assert.equal(bankToBranch('250655').branch_code, '250655'); assert.equal(bankToBranch('Bank of Narnia'), null);
});

test('switch off → null (the coming-soon script stays); unverified → identity gate; VERIFY starts KYC; tiny balance is refused kindly', async () => {
  env(false);
  assert.equal(await startWithdraw({ account: verified, ask: {}, deps: deps() }), null);
  env();
  const gate = await startWithdraw({ account: unverified, ask: { amountCents: 20000 }, deps: deps() });
  assert.equal(gate.state, 'PAYOUT_KYC'); assert.match(gate.text, /VERIFY/);
  assert.deepEqual(await handleWithdrawReply({ account: unverified, state: 'PAYOUT_KYC', text: 'verify' }), { state: null, action: 'START_KYC' });
  assert.equal((await handleWithdrawReply({ account: unverified, state: 'PAYOUT_KYC', text: 'no' })).cancelled, true);
  const pending = await startWithdraw({ account: { ...unverified, profile: { kyc: { status: 'PENDING' } } }, ask: {}, deps: deps() });
  assert.match(pending.text, /still being reviewed/);
  const poor = await startWithdraw({ account: verified, ask: {}, deps: deps(1500) });
  assert.equal(poor.state, null); assert.match(poor.text, /start at R20/);
});

test('happy path PayShap: menu → 1 → amount → mine → confirm → YES → PIN state; executes once with the KYC name and the intent id', async () => {
  env();
  const d = deps();
  const menu = await startWithdraw({ account: verified, ask: {}, deps: d });
  assert.equal(menu.state, 'PAYOUT_METHOD'); assert.match(menu.text, /R1000 available/); assert.match(menu.text, /1️⃣ \*PayShap\*.*R6 fee/);
  const amt = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: '1' });
  assert.equal(amt.state, 'PAYOUT_AMOUNT'); assert.equal(amt.data.method, 'PAYSHAP');
  const tooMuch = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: amt.data, text: '999' });
  assert.equal(tooMuch.state, 'PAYOUT_AMOUNT'); assert.match(tooMuch.text, /more than you have/);
  const tooSmall = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: amt.data, text: '5' });
  assert.match(tooSmall.text, /between R20 and R3000/);
  const mob = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: amt.data, text: 'R200' });
  assert.equal(mob.state, 'PAYOUT_MOBILE'); assert.equal(mob.data.amountCents, 20000);
  const conf = await handleWithdrawReply({ account: verified, state: 'PAYOUT_MOBILE', data: mob.data, text: 'mine' });
  assert.equal(conf.state, 'PAYOUT_CONFIRM'); assert.equal(conf.data.recipient.mobile, '0731234567'); assert.equal(conf.data.feeCents, 600); assert.equal(conf.data.totalCents, 20600);
  assert.match(conf.text, /Withdraw \*R200\*/); assert.match(conf.text, /Leaves your balance: \*R206\*/);
  const pin = await handleWithdrawReply({ account: verified, state: 'PAYOUT_CONFIRM', data: conf.data, text: 'yes' });
  assert.equal(pin.state, 'PAYOUT_PIN'); assert.match(pin.text, /PIN/);
  const done = await executeWithdraw({ account: verified, data: pin.data, deps: d });
  assert.equal(done.done, true); assert.match(done.text, /Done\./); assert.match(done.text, /WPTEST/);
  assert.equal(d.last.intentId, menu.data.intentId, 'the intent minted at the start is the idempotency key');
  assert.equal(d.last.recipient.firstname, 'Lerato'); assert.equal(d.last.recipient.surname, 'Mokoena', 'the KYC name goes to the bank, never a typed one');
  assert.equal(d.last.recipient.mobile, '0731234567'); assert.equal(d.last.method, 'PAYSHAP'); assert.equal(d.last.amountCents, 20000);
});

test('bank transfer: account → bank name → confirm; ATM cash: number typed; cancel anywhere; PENDING and failures worded honestly', async () => {
  env();
  const d = deps();
  let s = await startWithdraw({ account: verified, ask: { amountCents: 50000, method: 'RTC' }, deps: d });
  assert.equal(s.state, 'PAYOUT_ACCOUNT', 'amount + method in the ask skip straight to the recipient');
  s = await handleWithdrawReply({ account: verified, state: 'PAYOUT_ACCOUNT', data: s.data, text: '62 0123 4567 8' });
  assert.equal(s.state, 'PAYOUT_BRANCH'); assert.equal(s.data.recipient.account_number, '62012345678');
  const unknown = await handleWithdrawReply({ account: verified, state: 'PAYOUT_BRANCH', data: s.data, text: 'Bank of Narnia' });
  assert.equal(unknown.state, 'PAYOUT_BRANCH');
  s = await handleWithdrawReply({ account: verified, state: 'PAYOUT_BRANCH', data: s.data, text: 'Standard Bank' });
  assert.equal(s.state, 'PAYOUT_CONFIRM'); assert.equal(s.data.recipient.branch_code, '051001'); assert.match(s.text, /account 62012345678 at Standard Bank/); assert.equal(s.data.feeCents, 800);
  const c = await startWithdraw({ account: verified, ask: { amountCents: 30000, method: 'CASHSEND' }, deps: d });
  assert.equal(c.state, 'PAYOUT_MOBILE');
  const bad = await handleWithdrawReply({ account: verified, state: 'PAYOUT_MOBILE', data: c.data, text: '12' });
  assert.equal(bad.state, 'PAYOUT_MOBILE');
  const ok = await handleWithdrawReply({ account: verified, state: 'PAYOUT_MOBILE', data: c.data, text: '082 111 2222' });
  assert.equal(ok.state, 'PAYOUT_CONFIRM'); assert.equal(ok.data.recipient.mobile, '0821112222'); assert.equal(ok.data.feeCents, 1600);
  assert.equal((await handleWithdrawReply({ account: verified, state: 'PAYOUT_CONFIRM', data: ok.data, text: 'cancel' })).cancelled, true);
  assert.equal((await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: c.data, text: 'stop' })).state, null);
  const pending = await executeWithdraw({ account: verified, data: ok.data, deps: deps(100000, { ok: true, status: 'PENDING', reference: 'WPPEND', amountCents: 30000, feeCents: 1600 }) });
  assert.match(pending.text, /Sent\./); assert.match(pending.text, /WPPEND/);
  const failed = await executeWithdraw({ account: verified, data: ok.data, deps: deps(100000, { ok: false, status: 'FAILED', error: 'INVALID_MOBILE', reference: 'WPX' }) });
  assert.match(failed.text, /did not go through/); assert.match(failed.text, /Nothing has left your balance/);
  const broke = await executeWithdraw({ account: verified, data: ok.data, deps: deps(100000, { ok: false, error: 'INSUFFICIENT_FUNDS', totalCents: 31600 }) });
  assert.match(broke.text, /no longer have R316/);
});

test('processor + menu + AI truth follow the switch; the PIN case is the only path to executeWithdraw', () => {
  const p = read('../pages/api/webhooks/message-processor-v2.js');
  assert.match(p, /if \(payoutEnabled\(\)\) \{\s*\n\s*const \{ matchWithdrawAsk \} = await import\('\.\.\/\.\.\/\.\.\/lib\/payout-chat\.js'\);/, 'withdraw asks are deterministic only when live');
  assert.ok(p.indexOf('if (ask) return await handleWithdrawStart({ from, account, ask });') < p.indexOf('const slots = parseSlots(text'), 'before slot parsing');
  for (const st of PAYOUT_STATES.filter((x) => x !== 'PAYOUT_PIN')) assert.match(p, new RegExp(`case '${st}':`), st);
  const pinCase = p.slice(p.indexOf("case 'PAYOUT_PIN': {"), p.indexOf("case 'REQUEST_MONEY_AMOUNT': {"));
  assert.match(pinCase, /verifyPIN\(\{ accountId: account\.id, pin: text\.trim\(\) \}\)/);
  assert.ok(pinCase.indexOf('await updateConversationState(from, null);\n      const { executeWithdraw }') > -1, 'state cleared BEFORE the money call');
  assert.equal((p.match(/executeWithdraw\(/g) || []).length, 1, 'exactly one call site');
  assert.match(p, /state\.startsWith\('PAYOUT'\) \? 'WITHDRAW'/); assert.match(p, /\['WITHDRAW', process\.env\.WAPAY_PAYOUT_ENABLED === 'true' &&/, 'self-contained: the isolated-function tests evaluate it without imports');
  assert.match(p, /payoutEnabled\(\) \? `🏧 \*Withdraw\*: "withdraw R200"/, 'home menu flips with the switch');
  const script = read('../lib/spend-catalogue.js');
  assert.match(script, /if \(process\.env\.WAPAY_PAYOUT_ENABLED === 'true'\) \{\s*\n\s*return \(\s*\n\s*`💸 Withdrawals are live!/);
  const ai = read('../packages/ai/src/orchestrator.ts');
  assert.match(ai, /process\.env\.WAPAY_PAYOUT_ENABLED === 'true' \? '- Getting money OUT \(withdrawals\): LIVE\./);
  const hook = read('../pages/api/webhooks/ott-payout.js');
  assert.ok(hook.indexOf('finalisePayout(') < hook.indexOf('sendWhatsAppText({ to: account.waId'), 'customer told after finalisation');
});
