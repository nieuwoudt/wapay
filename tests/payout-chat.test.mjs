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

test('happy path PayShap: menu → 1 → amount → account → bank → confirm → YES → PIN state; executes once with the KYC name and the intent id', async () => {
  env();
  const d = deps();
  const menu = await startWithdraw({ account: verified, ask: {}, deps: d });
  assert.equal(menu.state, 'PAYOUT_METHOD'); assert.match(menu.text, /R1000 available/); assert.match(menu.text, /1️⃣ \*PayShap\*.*R8 fee/);
  const amt = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: '1' });
  assert.equal(amt.state, 'PAYOUT_AMOUNT'); assert.equal(amt.data.method, 'PAYSHAP');
  const tooMuch = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: amt.data, text: '999' });
  assert.equal(tooMuch.state, 'PAYOUT_AMOUNT'); assert.match(tooMuch.text, /more than you have/);
  const tooSmall = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: amt.data, text: '5' });
  assert.match(tooSmall.text, /R5 is below the R20 minimum for PayShap/);
  const acc = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: amt.data, text: 'R200' });
  assert.equal(acc.state, 'PAYOUT_ACCOUNT', 'PayShap is addressed by account number + branch code on OTT (2026-09-14), never a cellphone number'); assert.equal(acc.data.amountCents, 20000);
  const br = await handleWithdrawReply({ account: verified, state: 'PAYOUT_ACCOUNT', data: acc.data, text: '62012345678' });
  assert.equal(br.state, 'PAYOUT_BRANCH');
  const conf = await handleWithdrawReply({ account: verified, state: 'PAYOUT_BRANCH', data: br.data, text: 'FNB' });
  assert.equal(conf.state, 'PAYOUT_CONFIRM'); assert.equal(conf.data.recipient.account_number, '62012345678'); assert.equal(conf.data.recipient.branch_code, '250655'); assert.equal(conf.data.recipient.mobile, '0731234567', 'own number rides along for the SMS'); assert.equal(conf.data.feeCents, 800); assert.equal(conf.data.totalCents, 20800);
  assert.match(conf.text, /Withdraw \*R200\* to account 62012345678 at FNB by PayShap/); assert.match(conf.text, /Total leaving your balance: \*R208\* \(R200 \+ R8 fee\)/); assert.match(conf.text, /Balance after: \*R792\*/);
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
  assert.equal(s.state, 'PAYOUT_CONFIRM'); assert.equal(s.data.recipient.branch_code, '051001'); assert.match(s.text, /account 62012345678 at Standard Bank/); assert.equal(s.data.feeCents, 1000);
  const c = await startWithdraw({ account: verified, ask: { amountCents: 30000, method: 'CASHSEND' }, deps: d });
  assert.equal(c.state, 'PAYOUT_MOBILE');
  const bad = await handleWithdrawReply({ account: verified, state: 'PAYOUT_MOBILE', data: c.data, text: '12' });
  assert.equal(bad.state, 'PAYOUT_MOBILE');
  const ok = await handleWithdrawReply({ account: verified, state: 'PAYOUT_MOBILE', data: c.data, text: '082 111 2222' });
  assert.equal(ok.state, 'PAYOUT_CONFIRM'); assert.equal(ok.data.recipient.mobile, '0821112222'); assert.equal(ok.data.feeCents, 1800);
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
  assert.match(p, /if \(payoutAllowedFor\(from\)\) \{\s*\n\s*const \{ matchWithdrawAsk \} = await import\('\.\.\/\.\.\/\.\.\/lib\/payout-chat\.js'\);/, 'withdraw asks are deterministic only when live AND this user is allowed');
  assert.ok(p.indexOf('if (ask) return await handleWithdrawStart({ from, account, ask, text });') < p.indexOf('const slots = parseSlots(text'), 'before slot parsing');
  assert.match(p, /handleAIChat\(\{ from, text: text \|\| 'withdraw', account \}\)/, 'the AI fallback keeps the customer\'s real words');
  assert.ok(p.indexOf('const feeTopic = matchFeeAsk(text);') < p.indexOf('if (payoutAllowedFor(from)) {\n    const { matchWithdrawAsk }'), 'fee questions are answered before the withdraw flow starts');
  assert.deepEqual(matchWithdrawAsk('can I take my money out?'), { amountCents: null, method: null });
  assert.deepEqual(matchWithdrawAsk('how do I cash-out R150'), { amountCents: 15000, method: null });
  for (const st of PAYOUT_STATES.filter((x) => x !== 'PAYOUT_PIN')) assert.match(p, new RegExp(`case '${st}':`), st);
  const pinCase = p.slice(p.indexOf("case 'PAYOUT_PIN': {"), p.indexOf("case 'REQUEST_MONEY_AMOUNT': {"));
  assert.match(pinCase, /verifyPIN\(\{ accountId: account\.id, pin: text\.trim\(\) \}\)/);
  assert.ok(pinCase.indexOf('await updateConversationState(from, null);\n      const { executeWithdraw }') > -1, 'state cleared BEFORE the money call');
  assert.equal((p.match(/executeWithdraw\(/g) || []).length, 1, 'exactly one call site');
  assert.match(p, /state\.startsWith\('PAYOUT'\) \? 'WITHDRAW'/); assert.match(p, /\['WITHDRAW', process\.env\.WAPAY_PAYOUT_ENABLED === 'true' &&/, 'self-contained: the isolated-function tests evaluate it without imports');
  assert.match(p, /homeLines\(\{ waId: from, account \}\)/, 'home menu renders from the registry (whose withdraw gate is the per-user one)');
  assert.match(read('../lib/capabilities.js'), /payoutAllowedFor\(/);
  const script = read('../lib/spend-catalogue.js');
  assert.match(script, /if \(process\.env\.WAPAY_PAYOUT_ENABLED === 'true'\) \{\s*\n\s*return \(\s*\n\s*`💸 Withdrawals are live!/);
  const ai = read('../packages/ai/src/orchestrator.ts');
  // 2026-09-16: the prompt renders from the per-customer withdrawLive argument, not the env.
  assert.match(ai, /withdrawLive \? '- Getting money OUT \(withdrawals\): LIVE\./);
  const hook = read('../pages/api/webhooks/ott-payout.js');
  assert.ok(hook.indexOf('finalisePayout(') < hook.indexOf('sendWhatsAppText({ to: account.waId'), 'customer told after finalisation');
});

test('live providers drive the menu, the limits and the ID step (OTT test merchant 2026-09-15)', async () => {
  env();
  const live = [
    { method: 'PAYSHAP', providerCode: '127', providerName: 'PayShap Account', minCents: 5000, maxCents: 15000000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile', 'account_number', 'branch_code'] },
    { method: 'CASHSEND', providerCode: '112', providerName: 'ABSA CashSend', minCents: 5000, maxCents: 10000000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
  ];
  const d = { ...deps(), resolveProviders: async () => live };
  const menu = await startWithdraw({ account: verified, ask: {}, deps: d });
  assert.equal(menu.state, 'PAYOUT_METHOD'); assert.deepEqual(menu.data.options, ['PAYSHAP', 'CASHSEND']);
  assert.match(menu.text, /1️⃣ \*PayShap\*/); assert.match(menu.text, /2️⃣ \*Cash at an Absa ATM\*/); assert.ok(!/Bank transfer/.test(menu.text), 'no RTC provider, so no bank transfer option'); assert.match(menu.text, /Reply 1 or 2\./);
  const cash = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: '2' });
  assert.equal(cash.data.method, 'CASHSEND', 'menu numbers follow the offered options');
  const ps = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: '1' });
  assert.equal(ps.state, 'PAYOUT_AMOUNT'); assert.match(ps.text, /Between R50 and R3000/, 'the provider minimum narrows the product limits');
  const low = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: ps.data, text: '30' });
  assert.equal(low.state, 'PAYOUT_AMOUNT'); assert.match(low.text, /R30 is below the R50 minimum for PayShap/);
  const acc = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: ps.data, text: '50' });
  assert.equal(acc.state, 'PAYOUT_ACCOUNT');
  const br = await handleWithdrawReply({ account: verified, state: 'PAYOUT_ACCOUNT', data: acc.data, text: '62012345678' });
  const idAsk = await handleWithdrawReply({ account: verified, state: 'PAYOUT_BRANCH', data: br.data, text: 'FNB' });
  assert.equal(idAsk.state, 'PAYOUT_ID', 'the provider requires id_number, so it is asked before confirming'); assert.match(idAsk.text, /13-digit/);
  const bad = await handleWithdrawReply({ account: verified, state: 'PAYOUT_ID', data: idAsk.data, text: '123' });
  assert.equal(bad.state, 'PAYOUT_ID');
  const conf = await handleWithdrawReply({ account: verified, state: 'PAYOUT_ID', data: idAsk.data, text: '9001015009087' });
  assert.equal(conf.state, 'PAYOUT_CONFIRM'); assert.equal(conf.data.recipient.id_number, '9001015009087'); assert.equal(conf.data.feeCents, 800);
  assert.match(conf.text, /Withdraw \*R50\* to account 62012345678 at FNB by PayShap/);
  const none = await startWithdraw({ account: verified, ask: {}, deps: { ...deps(), resolveProviders: async () => [] } });
  assert.equal(none.state, null); assert.match(none.text, /not available for a little while/, 'no live provider: an honest pause, never a dead flow');
});

test('a question in the middle of the withdraw flow is answered, then the step repeats (founder review 2026-09-15)', async () => {
  env();
  const d = deps(6600); // the founder's R66
  const menu = await startWithdraw({ account: verified, ask: {}, deps: d });
  const q1 = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: 'If I send someone money, can they withdraw it?' });
  assert.equal(q1.state, 'PAYOUT_METHOD', 'the flow is parked, not advanced'); assert.match(q1.text, /instantly and it is free/); assert.match(q1.text, /Back to your withdrawal/); assert.match(q1.text, /1️⃣ \*PayShap\*/);
  const q2 = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: 'Does it work when I send cash to an ATM? How do I withdraw the money?' });
  assert.equal(q2.state, 'PAYOUT_METHOD', '"ATM" inside a question is not a menu choice'); assert.match(q2.text, /Here is how it works/);
  const pick = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: '3' });
  assert.equal(pick.data.method, 'CASHSEND', 'plain input still works');
  const q3 = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: pick.data, text: 'what is the fee?' });
  assert.equal(q3.state, 'PAYOUT_AMOUNT'); assert.match(q3.text, /R18 up to R700/); assert.match(q3.text, /How much would you like to withdraw/);
  const amt = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: pick.data, text: '66' });
  assert.equal(amt.state, 'PAYOUT_AMOUNT'); assert.match(amt.text, /more than you have/, 'numbers are still amounts');
});

test('FNB eWallet and Nedbank cardless are methods (founder ask 2026-09-15): menu, name matching, mobile + ID steps', async () => {
  env();
  const live = [
    { method: 'PAYSHAP', providerCode: '127', providerName: 'PayShap Account', minCents: 5000, maxCents: 15000000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile', 'account_number', 'branch_code'] },
    { method: 'CASHSEND', providerCode: '112', providerName: 'ABSA CashSend', minCents: 5000, maxCents: 10000000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
    { method: 'NEDCASH', providerCode: '4', providerName: 'Nedbank Cardless Withdrawal', minCents: 1000, maxCents: 500000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
    { method: 'EWALLET', providerCode: '1', providerName: 'FNB e-wallet', minCents: null, maxCents: 2500000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
  ];
  const d = { ...deps(), resolveProviders: async () => live };
  const menu = await startWithdraw({ account: verified, ask: {}, deps: d });
  assert.deepEqual(menu.data.options, ['PAYSHAP', 'CASHSEND', 'NEDCASH', 'EWALLET']);
  assert.match(menu.text, /3️⃣ \*Cash at a Nedbank ATM\*/); assert.match(menu.text, /4️⃣ \*FNB eWallet\*/); assert.match(menu.text, /Reply 1, 2, 3 or 4\./);
  assert.equal(parseMethodChoice('fnb ewallet', menu.data.options), 'EWALLET'); assert.equal(parseMethodChoice('nedbank', menu.data.options), 'NEDCASH'); assert.equal(parseMethodChoice('4', menu.data.options), 'EWALLET');
  assert.equal(parseMethodChoice('cash at the atm', ['PAYSHAP', 'EWALLET']), 'EWALLET', '"cash" picks the first cash method on offer');
  const ew = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: '4' });
  assert.equal(ew.state, 'PAYOUT_AMOUNT'); assert.match(ew.text, /Between R20 and R3000/, 'eWallet has no provider minimum');
  const amt = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: ew.data, text: '20' });
  assert.equal(amt.state, 'PAYOUT_MOBILE'); assert.match(amt.text, /FNB eWallet/);
  const mob = await handleWithdrawReply({ account: verified, state: 'PAYOUT_MOBILE', data: amt.data, text: 'mine' });
  assert.equal(mob.state, 'PAYOUT_ID', 'the provider requires the ID number');
  const conf = await handleWithdrawReply({ account: verified, state: 'PAYOUT_ID', data: mob.data, text: '9001015009087' });
  assert.equal(conf.state, 'PAYOUT_CONFIRM'); assert.match(conf.text, /Withdraw \*R20\* to an FNB eWallet on 0731234567/); assert.equal(conf.data.feeCents, 1800);
  const ned = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: '3' });
  assert.equal(ned.data.method, 'NEDCASH'); assert.match(ned.text, /Between R20 and R3000/);
});

test('below the minimum: the message names the methods that DO allow the amount, and "menu" changes method (founder 2026-09-15)', async () => {
  env();
  const live = [
    { method: 'PAYSHAP', providerCode: '127', providerName: 'PayShap Account', minCents: 5000, maxCents: 15000000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile', 'account_number', 'branch_code'] },
    { method: 'CASHSEND', providerCode: '112', providerName: 'ABSA CashSend', minCents: 5000, maxCents: 10000000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
    { method: 'NEDCASH', providerCode: '4', providerName: 'Nedbank Cardless Withdrawal', minCents: 1000, maxCents: 500000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
    { method: 'EWALLET', providerCode: '1', providerName: 'FNB e-wallet', minCents: null, maxCents: 2500000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
  ];
  const d = { ...deps(6600), resolveProviders: async () => live };
  const menu = await startWithdraw({ account: verified, ask: { amountCents: 3000 }, deps: d });   // "Withdraw 30"
  assert.equal(menu.state, 'PAYOUT_METHOD');
  const absa = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: '2' });
  assert.equal(absa.state, 'PAYOUT_AMOUNT');
  assert.match(absa.text, /R30 is below the R50 minimum for cash at an Absa ATM/); assert.match(absa.text, /\*3\* \(cash at a Nedbank ATM, from R20\)/); assert.match(absa.text, /\*4\* \(an FNB eWallet, from R20\)/); assert.match(absa.text, /Reply \*back\*/);
  const back = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: absa.data, text: 'back' });
  assert.equal(back.state, 'PAYOUT_METHOD'); assert.match(back.text, /Withdraw from WaPay/);
  const ned = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: back.data, text: '3' });
  assert.equal(ned.state, 'PAYOUT_MOBILE', 'the R30 given up front is kept and is valid for Nedbank');
});
