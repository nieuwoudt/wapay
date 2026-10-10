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
  assert.equal(tooMuch.state, 'PAYOUT_AMOUNT'); assert.match(tooMuch.text, /is the most you can take by PayShap right now .* Reply \*YES\*, or type a smaller amount\./);
  const tooSmall = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: amt.data, text: '15' });   // a bare 1 to 5 is a menu choice now (BUGLOG 68); R15 still tests the minimum
  assert.match(tooSmall.text, /R15 is below the R20 minimum for PayShap/);
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
  const pending = await executeWithdraw({ account: verified, data: ok.data, deps: deps(100000, { ok: true, status: 'PENDING', reference: 'WPPEND', amountCents: 30000, feeCents: 1600, outcome: 'PENDING_FINALISATION' }) });
  assert.match(pending.text, /In progress\./); assert.match(pending.text, /handed to the bank rail/); assert.match(pending.text, /WPPEND/); assert.ok(!/within minutes/.test(pending.text), 'no time promise (BUGLOG #82)');
  // A transport timeout is not a hand-over: nothing is claimed, the held money is named, no "Sent" (BUGLOG #82).
  for (const outcome of ['TRANSPORT_INDETERMINATE', 'UNKNOWN', 'HTTP_502', undefined]) {
    const unsure = await executeWithdraw({ account: verified, data: ok.data, deps: deps(100000, { ok: true, status: 'PENDING', reference: 'WPUNK', amountCents: 30000, feeCents: 1600, outcome }) });
    assert.match(unsure.text, /could not get confirmation from the bank rail just now/); assert.match(unsure.text, /R300 plus the R16 fee is held, not spent/); assert.match(unsure.text, /WPUNK/);
    assert.ok(!/Sent|handed to the bank rail|within minutes/.test(unsure.text), `nothing claimed for ${outcome}`);
  }
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
  assert.equal(ps.state, 'PAYOUT_AMOUNT'); assert.match(ps.text, /Between R50 and R9\d\d\. You have R1000 available/, 'the provider minimum narrows the product limits; the ceiling is what R1000 covers after the fee');
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
  const d = deps(10000); // R100 (cash needs R68 since the R50 floor of 2026-10-10)
  const menu = await startWithdraw({ account: verified, ask: {}, deps: d });
  const q1 = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: 'If I send someone money, can they withdraw it?' });
  assert.equal(q1.state, 'PAYOUT_METHOD', 'the flow is parked, not advanced'); assert.match(q1.text, /instantly and it is free/); assert.match(q1.text, /Back to your withdrawal/); assert.match(q1.text, /1️⃣ \*PayShap\*/);
  const q2 = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: 'Does it work when I send cash to an ATM? How do I withdraw the money?' });
  assert.equal(q2.state, 'PAYOUT_METHOD', '"ATM" inside a question is not a menu choice'); assert.match(q2.text, /Here is how it works/);
  const pick = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: '3' });
  assert.equal(pick.data.method, 'CASHSEND', 'plain input still works');
  const q3 = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: pick.data, text: 'what is the fee?' });
  assert.equal(q3.state, 'PAYOUT_AMOUNT'); assert.match(q3.text, /R18 up to R700/); assert.match(q3.text, /How much would you like to withdraw/);
  const amt = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: pick.data, text: '100' });
  assert.equal(amt.state, 'PAYOUT_AMOUNT'); assert.match(amt.text, /R50 is the most you can take by cash at an Absa ATM right now/, 'numbers are still amounts, and the ceiling is offered as a multiple of R50');
  const odd = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: pick.data, text: '70' });
  assert.match(odd.text, /R70 cannot be paid out as cash: ATMs give R50 and R100 notes, so cash at an Absa ATM takes multiples of R50 \(R50, R100, R150 and so on\)\. Reply \*YES\* for R50/, 'ATM notes rule (BUGLOG #98)'); assert.equal(odd.data.offerAmountCents, 5000);
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
  assert.equal(ew.state, 'PAYOUT_AMOUNT'); assert.match(ew.text, /Between R50 and R950, in multiples of R50 \(ATMs pay out R50 and R100 notes\)\. You have R1000 available/, 'cash: R50 floor and R50 steps (BUGLOG #98); the ceiling is what R1000 covers after the fee');
  const amt = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: ew.data, text: '50' });
  assert.equal(amt.state, 'PAYOUT_MOBILE'); assert.match(amt.text, /FNB eWallet/);
  const mob = await handleWithdrawReply({ account: verified, state: 'PAYOUT_MOBILE', data: amt.data, text: 'mine' });
  assert.equal(mob.state, 'PAYOUT_ID', 'the provider requires the ID number');
  const conf = await handleWithdrawReply({ account: verified, state: 'PAYOUT_ID', data: mob.data, text: '9001015009087' });
  assert.equal(conf.state, 'PAYOUT_CONFIRM'); assert.match(conf.text, /Withdraw \*R50\* to an FNB eWallet on 0731234567/); assert.equal(conf.data.feeCents, 1800);
  const ned = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: '3' });
  assert.equal(ned.data.method, 'NEDCASH'); assert.match(ned.text, /Between R50 and R950, in multiples of R50/);
});

test('below the minimum: the message names the methods that DO allow the amount, and "menu" changes method (founder 2026-09-15)', async () => {
  env();
  const live = [
    { method: 'PAYSHAP', providerCode: '127', providerName: 'PayShap Account', minCents: 5000, maxCents: 15000000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile', 'account_number', 'branch_code'] },
    { method: 'CASHSEND', providerCode: '112', providerName: 'ABSA CashSend', minCents: 5000, maxCents: 10000000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
    { method: 'NEDCASH', providerCode: '4', providerName: 'Nedbank Cardless Withdrawal', minCents: 1000, maxCents: 500000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
    { method: 'EWALLET', providerCode: '1', providerName: 'FNB e-wallet', minCents: null, maxCents: 2500000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
  ];
  const d = { ...deps(10000), resolveProviders: async () => live };   // R100: CashSend is affordable, so the R30 ask reaches the below-minimum branch
  const menu = await startWithdraw({ account: verified, ask: { amountCents: 3000 }, deps: d });   // "Withdraw 30"
  assert.equal(menu.state, 'PAYOUT_METHOD');
  const absa = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: '2' });
  assert.equal(absa.state, 'PAYOUT_AMOUNT');
  // 2026-09-18: the flow no longer lists menu numbers here. It names the one
  // method that carries R30 and offers it as a yes/no (founder: "it already
  // knows which option to choose"). 'back' still returns to the full menu.
  // Since the R50 cash floor (BUGLOG #98) no method takes R30: the minimum is named and the amount asked again.
  assert.match(absa.text, /^R30 is below the R50 minimum for cash at an Absa ATM\. Please type an amount of R50 or more, or "cancel"\.$/);
  const back = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: absa.data, text: 'back' });
  assert.equal(back.state, 'PAYOUT_METHOD'); assert.match(back.text, /Withdraw from WaPay/);
  const ned = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: back.data, text: '3' });
  assert.equal(ned.state, 'PAYOUT_AMOUNT', 'the R30 given up front is kept but is below every cash minimum'); assert.match(ned.text, /R30 is below the R50 minimum for cash at a Nedbank ATM/);
  const fifty = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: ned.data, text: '50' });
  assert.equal(fifty.state, 'PAYOUT_MOBILE');
});

// ---------------------------------------------------------------------------
// Founder review 2026-10-04 (three live sandbox withdrawals): compound answers,
// the menu wording, the full name once, collection instructions, the bank's own
// notice, and remembered destinations with an explicit YES.
// ---------------------------------------------------------------------------
import { parseCompoundWithdraw, methodFromWords, METHOD_SYNONYMS, cleanFullName, pickSavedDestination, parseSaveAnswer, wantsAnotherFlow } from '../lib/payout-chat.js';
import { payoutOutcomeMessage } from '../lib/payouts.js';

const LIVE4 = [
  { method: 'PAYSHAP', providerCode: '127', providerName: 'PayShap Account', minCents: 5000, maxCents: 15000000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile', 'account_number', 'branch_code'] },
  { method: 'CASHSEND', providerCode: '112', providerName: 'ABSA CashSend', minCents: 5000, maxCents: 10000000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
  { method: 'NEDCASH', providerCode: '4', providerName: 'Nedbank Cardless Withdrawal', minCents: 1000, maxCents: 500000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
  { method: 'EWALLET', providerCode: '1', providerName: 'FNB e-wallet', minCents: null, maxCents: 2500000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
];
const OPTS4 = ['PAYSHAP', 'CASHSEND', 'NEDCASH', 'EWALLET'];
// The founder: KYC off, a one-word display name, no saved details.
const founder = { id: 'acc-f', msisdn: '27787051175', waId: '27787051175', displayName: 'Nieuwoudt', profile: {} };
function envOff() { process.env.WAPAY_PAYOUT_ENABLED = 'true'; process.env.WAPAY_PAYOUT_KYC = 'off'; }

test('parseCompoundWithdraw is pure and reads "50 and 2", "50 at ABSA", "the Nedbank one", "150" and "2" the way the customer meant them', () => {
  const p = (t, options = OPTS4) => parseCompoundWithdraw(t, { options });
  assert.deepEqual(p('50 and 2'), { amountCents: 5000, method: 'CASHSEND', menuNumber: 2 });
  assert.deepEqual(p('2 and 50'), { amountCents: 5000, method: 'CASHSEND', menuNumber: 2 });
  assert.deepEqual(p('50, 2'), { amountCents: 5000, method: 'CASHSEND', menuNumber: 2 });
  assert.deepEqual(p('50 at ABSA'), { amountCents: 5000, method: 'CASHSEND', menuNumber: null });
  assert.deepEqual(p('No can you help me withdraw 50 at ABSA?'), { amountCents: 5000, method: 'CASHSEND', menuNumber: null });
  assert.deepEqual(p('the Nedbank one'), { amountCents: null, method: 'NEDCASH', menuNumber: null });
  assert.deepEqual(p('R50 payshap'), { amountCents: 5000, method: 'PAYSHAP', menuNumber: null });
  assert.deepEqual(p('20 nedbank'), { amountCents: 2000, method: 'NEDCASH', menuNumber: null });
  assert.deepEqual(p('R150.50 to my FNB account'), { amountCents: 15050, method: 'PAYSHAP', menuNumber: null }, 'a bank named with "account" is the bank-account family, not the eWallet');
  assert.deepEqual(p('150'), { amountCents: 15000, method: null, menuNumber: null }, 'an amount, never option 1');
  assert.deepEqual(p('2'), { amountCents: null, method: 'CASHSEND', menuNumber: 2 });
  assert.deepEqual(p('fnb', ['PAYSHAP', 'CASHSEND']), { amountCents: null, method: 'CASHSEND', menuNumber: null }, 'family fallback when the named cash method is not offered');
  assert.equal(p('0831234567'), null, 'a cellphone number is not an amount');
  assert.equal(p('hello there'), null);
  assert.equal(methodFromWords('bank transfer', ['PAYSHAP', 'CASHSEND']), 'PAYSHAP', 'no RTC offered: the bank family falls back to PayShap');
  assert.equal(parseMethodChoice('150', OPTS4), null, '"150" is not option 1 any more');
  assert.equal(parseMethodChoice('1 please', OPTS4), 'PAYSHAP');
  for (const m of ['PAYSHAP', 'RTC', 'CASHSEND', 'NEDCASH', 'EWALLET', 'CASH']) assert.ok(Array.isArray(METHOD_SYNONYMS[m]) && METHOD_SYNONYMS[m].length, `synonyms for ${m}`);
  assert.equal(cleanFullName('nieuwoudt'), null); assert.equal(cleanFullName('Nieuwoudt  Gresse '), 'Nieuwoudt Gresse'); assert.equal(cleanFullName('Thandi 123'), null); assert.equal(cleanFullName("Anne-Marie O'Neil"), "Anne-Marie O'Neil");
});

test('"Can I withdraw 20" then "50 and 2": one confirming line, YES carries on; "50 at ABSA" and "the Nedbank one" mid-flow; "150" is kept as the amount', async () => {
  envOff();
  const d = { ...deps(100000), resolveProviders: async () => LIVE4 };
  const menu = await startWithdraw({ account: founder, ask: { amountCents: 2000, method: null }, deps: d });
  assert.equal(menu.state, 'PAYOUT_METHOD'); assert.equal(menu.data.amountCents, 2000);
  assert.match(menu.text, /Minimum withdrawals from R50/); assert.ok(!/\(from R/.test(menu.text), 'the old "(from R50)" is gone'); assert.ok(!/arrives in minutes|within the hour/.test(menu.text), 'no time promised in the menu');
  const c = await handleWithdrawReply({ account: founder, state: 'PAYOUT_METHOD', data: menu.data, text: '50 and 2' });
  assert.equal(c.state, 'PAYOUT_METHOD'); assert.equal(c.data.offerMethod, 'CASHSEND'); assert.equal(c.data.amountCents, 5000);
  assert.match(c.text, /^Got it: R50 by cash at an Absa ATM\. Is that right\? Reply \*YES\* to carry on, or tell me what to change\.$/);
  const y = await handleWithdrawReply({ account: founder, state: c.state, data: c.data, text: 'yes' });
  assert.equal(y.state, 'PAYOUT_MOBILE'); assert.equal(y.data.method, 'CASHSEND'); assert.equal(y.data.amountCents, 5000); assert.match(y.text, /Absa ATM or till/);
  // The founder's exact sentence inside the method step: a confirmation, not the four-step explainer.
  const q = await handleWithdrawReply({ account: founder, state: 'PAYOUT_METHOD', data: menu.data, text: 'No can you help me withdraw 50 at ABSA?' });
  assert.match(q.text, /^Got it: R50 by cash at an Absa ATM/); assert.ok(!/Here is how it works/.test(q.text));
  // "150" at the method step is an amount, kept while the method is asked briefly.
  const amt = await handleWithdrawReply({ account: founder, state: 'PAYOUT_METHOD', data: menu.data, text: '150' });
  assert.equal(amt.state, 'PAYOUT_METHOD'); assert.equal(amt.data.amountCents, 15000); assert.match(amt.text, /^Got it, R150\. How would you like it\? Reply \*1\* for PayShap/);
  const one = await handleWithdrawReply({ account: founder, state: amt.state, data: amt.data, text: '1' });
  assert.equal(one.state, 'PAYOUT_ACCOUNT', 'the R150 given earlier is kept and PayShap goes straight to the account step');
  // Mid-amount: "50 at ABSA" switches method and amount with one confirming line; "the Nedbank one" switches method and asks the amount.
  const ps = await handleWithdrawReply({ account: founder, state: 'PAYOUT_METHOD', data: { ...menu.data, amountCents: null }, text: '1' });
  assert.equal(ps.state, 'PAYOUT_AMOUNT');
  const sw = await handleWithdrawReply({ account: founder, state: 'PAYOUT_AMOUNT', data: ps.data, text: '50 at ABSA' });
  assert.equal(sw.state, 'PAYOUT_AMOUNT'); assert.equal(sw.data.offerMethod, 'CASHSEND'); assert.equal(sw.data.offerAmountCents, 5000); assert.match(sw.text, /^Got it: R50 by cash at an Absa ATM\. Is that right\?/);
  const go = await handleWithdrawReply({ account: founder, state: sw.state, data: sw.data, text: 'ja' });
  assert.equal(go.state, 'PAYOUT_MOBILE'); assert.equal(go.data.method, 'CASHSEND');
  const ned = await handleWithdrawReply({ account: founder, state: 'PAYOUT_AMOUNT', data: ps.data, text: 'the Nedbank one' });
  assert.equal(ned.state, 'PAYOUT_AMOUNT'); assert.equal(ned.data.method, 'NEDCASH'); assert.match(ned.text, /by Cash at a Nedbank ATM\? Between R50 and R950, in multiples of R50/);
  const plain = await handleWithdrawReply({ account: founder, state: 'PAYOUT_AMOUNT', data: ps.data, text: '50 please' });
  assert.equal(plain.state, 'PAYOUT_ACCOUNT', 'an amount with a polite word is still the amount');
  // Below the minimum inside a compound answer: the existing offer wording, not a confirmation of something impossible.
  const low = await handleWithdrawReply({ account: founder, state: 'PAYOUT_METHOD', data: menu.data, text: '20 and 2' });
  assert.match(low.text, /R20 is below the R50 minimum for cash at an Absa ATM\. Please type an amount of R50 or more/);
});

test('the full name is asked once as on the account when KYC has none; the confirmation shows it; the rail gets first name + surname, never the display name twice', async () => {
  envOff();
  const base = deps(15200);
  const d = { ...base, resolveProviders: async () => LIVE4 };
  const s0 = await startWithdraw({ account: founder, ask: { amountCents: 5000, method: 'NEDCASH' }, deps: d });
  assert.equal(s0.state, 'PAYOUT_MOBILE');
  const s1 = await handleWithdrawReply({ account: founder, state: s0.state, data: s0.data, text: 'mine' });
  assert.equal(s1.state, 'PAYOUT_NAME'); assert.match(s1.text, /full name, exactly as it appears on your ID/);
  const bad = await handleWithdrawReply({ account: founder, state: s1.state, data: s1.data, text: 'Nieuwoudt' });
  assert.equal(bad.state, 'PAYOUT_NAME'); assert.match(bad.text, /first name and surname/);
  const s2 = await handleWithdrawReply({ account: founder, state: s1.state, data: s1.data, text: 'Nieuwoudt Gresse' });
  assert.equal(s2.state, 'PAYOUT_ID');
  const s3 = await handleWithdrawReply({ account: founder, state: s2.state, data: s2.data, text: '9001015009087' });
  assert.equal(s3.state, 'PAYOUT_CONFIRM'); assert.match(s3.text, /Name on the account: Nieuwoudt Gresse/); assert.match(s3.text, /ID number: •••087/); assert.ok(!/9001015009087/.test(s3.text), 'the ID number is masked in the confirmation');
  const pin = await handleWithdrawReply({ account: founder, state: s3.state, data: s3.data, text: 'yes' });
  assert.equal(pin.state, 'PAYOUT_PIN');
  const done = await executeWithdraw({ account: founder, data: pin.data, deps: { ...d, beneficiariesAvailable: () => false } });
  assert.equal(base.last.recipient.firstname, 'Nieuwoudt'); assert.equal(base.last.recipient.surname, 'Gresse'); assert.equal(base.last.recipient.id_number, '9001015009087');
  assert.match(done.text, /Done\./); assert.match(done.text, /withdrawal code is sent by SMS to •••175/); assert.match(done.text, /Cardless services/); assert.match(done.text, /If the SMS does not arrive/);
  assert.equal(done.state, null, 'no save offer while the vault is not configured');
  assert.ok(!/—/.test(done.text), 'no em dashes in customer copy');
  // A bank method says the bank's own app or SMS will show the credit.
  const bank = await executeWithdraw({ account: verified, data: { method: 'PAYSHAP', amountCents: 5000, intentId: 'wa-x-y', recipient: { account_number: '62012345678', branch_code: '250655', branch_name: 'FNB', mobile: '0731234567', id_number: '9001015009087' } }, deps: { ...deps(), beneficiariesAvailable: () => false } });
  assert.match(bank.text, /straight into your bank account\. Your bank's own app or SMS will show the credit/);
  const pend = await executeWithdraw({ account: verified, data: { method: 'PAYSHAP', amountCents: 5000, intentId: 'wa-x-z', recipient: { account_number: '62012345678', branch_code: '250655', branch_name: 'FNB', mobile: '0731234567', id_number: '9001015009087' } }, deps: { ...deps(100000, { ok: true, status: 'PENDING', reference: 'WPPEND', amountCents: 5000, feeCents: 800, outcome: 'PENDING_FINALISATION' }), beneficiariesAvailable: () => false } });
  assert.match(pend.text, /In progress\./); assert.match(pend.text, /bank's own app or SMS as well/); assert.ok(!/within minutes/.test(pend.text));
  // The finalisers say the same thing later (webhook / sweep): paid carries the collection steps, failed does not.
  const later = payoutOutcomeMessage({ status: 'SETTLED', method: 'NEDCASH', amountCents: 2000, reference: 'WPX', recipient: { mobile: '•••175' } });
  assert.match(later, /has been paid \(reference WPX\)/); assert.match(later, /withdrawal code is sent by SMS to •••175/); assert.match(later, /Cardless services/);
  assert.ok(!/Collecting|SMS/.test(payoutOutcomeMessage({ status: 'FAILED', method: 'NEDCASH', amountCents: 2000, reference: 'WPX' })));
});

test('save for next time: offered only after an accepted pay-out with typed details and a configured vault; YES saves both, NO keeps nothing, anything else passes through', async () => {
  envOff();
  const calls = [];
  const d = {
    ...deps(15200), resolveProviders: async () => LIVE4, beneficiariesAvailable: () => true,
    saveDestination: async (a) => { calls.push(['dest', a.method, a.recipient.mobile]); return { ok: true, label: 'Nedbank cash to •••175' }; },
    saveIdentity: async (a) => { calls.push(['id', a.fullName, a.idNumber]); return { ok: true, idLast3: '087' }; },
  };
  const data = { method: 'NEDCASH', amountCents: 2000, intentId: 'wa-a-b', options: OPTS4, balanceCents: 15200, recipient: { mobile: '0787051175', fullName: 'Nieuwoudt Gresse', id_number: '9001015009087' } };
  const done = await executeWithdraw({ account: founder, data, deps: d });
  assert.equal(done.state, 'PAYOUT_SAVE'); assert.match(done.text, /Done\./); assert.match(done.text, /💾 Save these details for next time \(Cellphone •••175 and your name and ID number ending 087\)\? Reply \*YES\*, or give them a name like "mine" or "mother"/); assert.match(done.text, /stored encrypted/); assert.match(done.text, /"forget my bank details"/);
  assert.ok(!/9001015009087|0787051175/.test(done.text), 'nothing full in the offer');
  assert.equal(done.data.saveDestination, true); assert.equal(done.data.saveIdentity, true);
  const yes = await handleWithdrawReply({ account: founder, state: 'PAYOUT_SAVE', data: done.data, text: 'YES', deps: d });
  assert.equal(yes.state, null); assert.match(yes.text, /Saved, encrypted: Nedbank cash to •••175 and your name and ID number ending 087/);
  assert.deepEqual(calls, [['dest', 'NEDCASH', '0787051175'], ['id', 'Nieuwoudt Gresse', '9001015009087']]);
  const no = await handleWithdrawReply({ account: founder, state: 'PAYOUT_SAVE', data: done.data, text: 'no', deps: d });
  assert.equal(no.state, null); assert.match(no.text, /Not saved/); assert.equal(calls.length, 2, 'NO writes nothing');
  const other = await handleWithdrawReply({ account: founder, state: 'PAYOUT_SAVE', data: done.data, text: 'buy R20 airtime', deps: d });
  assert.deepEqual(other, { state: null, passthrough: true }, 'anything else is answered as a new message, nothing kept');
  // Not offered: after a failure, when the vault is off, or when the destination was a saved one.
  const failed = await executeWithdraw({ account: founder, data, deps: { ...d, requestPayout: async () => ({ ok: false, status: 'FAILED', error: 'PROVIDER_FAILURE', reference: 'WPF' }) } });
  assert.equal(failed.state, null); assert.ok(!/Save these details/.test(failed.text));
  const pending = await executeWithdraw({ account: founder, data, deps: { ...d, requestPayout: async (a) => ({ ok: true, status: 'PENDING', reference: 'WPP', amountCents: a.amountCents, feeCents: 1800, outcome: 'PENDING_FINALISATION' }) } });
  assert.equal(pending.state, 'PAYOUT_SAVE', 'a real OTT pending is an accepted pay-out');
  const kycd = await executeWithdraw({ account: verified, data: { ...data, recipient: { mobile: '0787051175', id_number: '9001015009087' } }, deps: d });
  assert.equal(kycd.data.saveIdentity, false, 'the KYC name is not saved again'); assert.equal(kycd.data.saveDestination, true);
});

test('saved destinations are offered by number or name, skip the name and ID steps, and are decrypted only at the moment of use', async () => {
  envOff();
  const touched = [];
  const base = deps(15200);
  const d = {
    ...base, resolveProviders: async () => LIVE4, beneficiariesAvailable: () => true,
    listDestinations: async () => [{ id: 'd1', method: 'PAYSHAP', family: 'BANK', label: 'FNB account •••394' }, { id: 'd2', method: 'NEDCASH', family: 'CASH', label: 'Nedbank cash to •••175' }],
    getIdentity: async () => ({ fullName: 'Nieuwoudt Gresse', idLast3: '087' }),
    loadDestination: async ({ id }) => (id === 'd1' ? { id, method: 'PAYSHAP', account_number: '62012345394', branch_code: '250655', branch_name: 'FNB' } : null),
    loadIdentity: async () => ({ fullName: 'Nieuwoudt Gresse', idNumber: '9001015009087' }),
    touchDestination: async ({ id }) => { touched.push(id); },
  };
  const s0 = await startWithdraw({ account: founder, ask: { amountCents: 5000, method: 'PAYSHAP' }, deps: d });
  assert.equal(s0.state, 'PAYOUT_ACCOUNT'); assert.match(s0.text, /These are saved:\n\n1️⃣ FNB account •••394\n\nReply the number, or type a new account number/); assert.ok(!/Nedbank cash/.test(s0.text), 'cash destinations are not offered for a bank method');
  assert.ok(!JSON.stringify(s0.data).includes('62012345394') && !/Enc/.test(JSON.stringify(s0.data)), 'the flow data carries labels and masks only, never the account number');
  const pick = await handleWithdrawReply({ account: founder, state: s0.state, data: s0.data, text: 'the fnb one' });
  assert.equal(pick.state, 'PAYOUT_CONFIRM', 'name and ID are saved: straight to the confirmation');
  assert.match(pick.text, /Withdraw \*R50\* to FNB account •••394 by PayShap/); assert.match(pick.text, /Name on the account: Nieuwoudt Gresse/); assert.match(pick.text, /ID number: •••087 \(saved\)/);
  assert.equal(pickSavedDestination('1', s0.data.savedChoices).id, 'd1'); assert.equal(pickSavedDestination('394', s0.data.savedChoices).id, 'd1'); assert.equal(pickSavedDestination('capitec', s0.data.savedChoices), null);
  const typed = await handleWithdrawReply({ account: founder, state: s0.state, data: s0.data, text: '62099988877' });
  assert.equal(typed.state, 'PAYOUT_BRANCH', 'a new account number still works');
  const pin = await handleWithdrawReply({ account: founder, state: pick.state, data: pick.data, text: 'yes' });
  const done = await executeWithdraw({ account: founder, data: pin.data, deps: d });
  assert.equal(base.last.recipient.account_number, '62012345394'); assert.equal(base.last.recipient.branch_code, '250655'); assert.equal(base.last.recipient.id_number, '9001015009087'); assert.equal(base.last.recipient.firstname, 'Nieuwoudt'); assert.equal(base.last.recipient.surname, 'Gresse');
  assert.deepEqual(touched, ['d1']); assert.equal(done.state, null, 'nothing new to save'); assert.match(done.text, /Done\./);
  const cash = await startWithdraw({ account: founder, ask: { amountCents: 5000, method: 'NEDCASH' }, deps: d });
  assert.equal(cash.state, 'PAYOUT_MOBILE'); assert.match(cash.text, /1️⃣ Nedbank cash to •••175/);
  const yesOne = await handleWithdrawReply({ account: founder, state: cash.state, data: cash.data, text: 'Yes' });
  assert.equal(yesOne.state, 'PAYOUT_CONFIRM', '"Yes" to a list of one saved number picks it (BUGLOG #97)'); assert.equal(yesOne.data.recipient.savedId, 'd2'); assert.match(cash.text, /\*mine\* for this WhatsApp number/);
  const mine = await handleWithdrawReply({ account: founder, state: cash.state, data: cash.data, text: 'mine' });
  assert.equal(mine.state, 'PAYOUT_CONFIRM', '"mine" still works beside the saved list');
  const gone = await executeWithdraw({ account: founder, data: { ...pin.data, recipient: { savedId: 'd9', savedLabel: 'Gone account •••000', mobile: '0787051175' } }, deps: d });
  assert.equal(gone.done, false); assert.match(gone.text, /could not read the saved details/); assert.match(gone.text, /nothing has left your balance/);
});

test('static: the processor wires the two new states, passes a non-answer to the save question through, and erases saved pay-out details with "forget my bank details" and with "forget me"', () => {
  const p = read('../pages/api/webhooks/message-processor-v2.js');
  assert.match(p, /case 'PAYOUT_NAME':/); assert.match(p, /case 'PAYOUT_SAVE':/);
  assert.match(p, /if \(step\?\.passthrough\) \{\s*\n\s*await updateConversationState\(from, null\);\s*\n\s*return await handlePostOnboarding\(\{ account, from, text \}\);/);
  const forget = p.indexOf('if (matchForgetMe(text)) {'); const bank = p.indexOf('if (matchForgetBankDetails(text)) {'); const memory = p.indexOf('const ask = memoryHistoryAsk(text);'); const allow = p.indexOf('if (payoutAllowedFor(from)) {\n    const { matchWithdrawAsk }');
  assert.ok(forget > -1 && bank > forget && memory > bank && allow > bank, 'erasure sits beside forget-me, above the disclosure hook, outside the allowlist block');
  const fm = p.slice(p.indexOf('async function handleForgetMe'), p.indexOf('/** The home card'));
  assert.match(fm, /forgetPayoutDetails\(\{ prisma, accountId: account\.id \}\)/, '"forget me" erases the saved pay-out details too');
  const re = new RegExp(p.match(/const FORGET_BANK = \/(.*)\/i;\n/)[1], 'i');
  for (const t of ['forget my bank details', 'Forget my bank account', 'delete my saved bank details', 'erase my ID number', 'remove my beneficiaries', 'forget my payout details']) assert.ok(re.test(t), t);
  for (const t of ['forget me', 'withdraw R50 to my bank account', 'what are my bank details', 'delete my payment link PR7K2FQ4', 'my bank details are wrong']) assert.ok(!re.test(t), `never: ${t}`);
  const route = read('../pages/api/internal/payout-reconcile.js');
  assert.match(route, /notifyCustomer\(\{ to: account\.waId, accountId: r\.accountId, text: payoutOutcomeMessage\(r\), kind: 'receipt', templateEnv: 'WAPAY_TEMPLATE_PAYOUT_OUTCOME'/, 'the operator route tells the customer through the rail that crosses the 24 h window');
  assert.match(route, /notifyFailed/);
  const schema = read('../packages/domain/prisma/schema.prisma');
  assert.match(schema, /model PayoutIdentity \{[\s\S]*onDelete: Cascade[\s\S]*@@map\("payout_identities"\)/); assert.match(schema, /model PayoutDestination \{[\s\S]*onDelete: Cascade[\s\S]*@@unique\(\[accountId, fingerprint\]\)[\s\S]*@@map\("payout_destinations"\)/);
  assert.ok(!/displayName/.test(read('../lib/payout-chat.js').match(/function recipientName[\s\S]*?\n\}/)[0].replace(/account\?\.displayName \|\| ''\)\.trim\(\)\.split\(\/\\s\+\/\)\[0\]/, '')), 'the display name is never used as a surname');
});

// ---------------------------------------------------------------------------
// Round 3, from the first production run (2026-10-08): sentences at the save
// step, nicknames, escapes to other flows, "you have it stored", the shortfall
// hint, no second save offer, the Absa steps.
// ---------------------------------------------------------------------------
test('round 3: the save question reads sentences and nicknames; other-flow asks escape; names and numbers never do', () => {
  assert.deepEqual(parseSaveAnswer('Yes please save my bank details as mine'), { kind: 'yes', nickname: 'Mine' });
  assert.deepEqual(parseSaveAnswer('mother'), { kind: 'yes', nickname: 'Mother' });
  assert.deepEqual(parseSaveAnswer('save it as my mom'), { kind: 'yes', nickname: 'My Mom' });
  assert.deepEqual(parseSaveAnswer('Okay'), { kind: 'yes', nickname: null }); assert.deepEqual(parseSaveAnswer('YES'), { kind: 'yes', nickname: null });
  assert.deepEqual(parseSaveAnswer('no thanks'), { kind: 'no', nickname: null }); assert.deepEqual(parseSaveAnswer("don't save it"), { kind: 'no', nickname: null });
  assert.deepEqual(parseSaveAnswer('buy R20 airtime'), { kind: 'other', nickname: null }); assert.deepEqual(parseSaveAnswer('what is my balance'), { kind: 'other', nickname: null });
  for (const t of ['Add money', 'I want to load money to WaPay', 'deposit', 'buy airtime', 'send R50 to 0831234567', 'please pay me R100', 'my balance', 'top up']) assert.ok(wantsAnotherFlow(t), t);
  for (const t of ['FNB', '250655', '50', 'yes', 'the nedbank one', '50 at absa', 'Nieuwoudt Gresse', 'mine', '62012345678', '9001015009087']) assert.ok(!wantsAnotherFlow(t), `never: ${t}`);
});

test('round 3: "add money" inside any withdraw step passes through; "you have it stored" answers from the saved list; the menu names the shortfall', async () => {
  envOff();
  const d = { ...deps(6000), resolveProviders: async () => LIVE4 };
  const menu = await startWithdraw({ account: founder, ask: { amountCents: 5000, method: null }, deps: d });
  assert.match(menu.text, /💡 With R60 you cannot use cash at an Absa ATM, cash at a Nedbank ATM or an FNB eWallet \(R68 with the fee\) yet\. Say \*add money\* to top up, or reply \*1\* for PayShap\./);
  for (const t of ['Add money', 'I want to load money to WaPay', 'buy airtime', 'my balance']) {
    assert.deepEqual(await handleWithdrawReply({ account: founder, state: 'PAYOUT_METHOD', data: menu.data, text: t }), { state: null, passthrough: true }, t);
  }
  const amt = await handleWithdrawReply({ account: founder, state: 'PAYOUT_METHOD', data: { ...menu.data, amountCents: null }, text: '1' });
  assert.equal(amt.state, 'PAYOUT_AMOUNT');
  assert.deepEqual(await handleWithdrawReply({ account: founder, state: 'PAYOUT_AMOUNT', data: amt.data, text: 'deposit' }), { state: null, passthrough: true });
  // Nothing saved yet for a bank account: say so, mention what is saved, repeat the step.
  const d2 = { ...deps(100000), resolveProviders: async () => LIVE4, listDestinations: async () => [{ id: 'c1', method: 'NEDCASH', family: 'CASH', label: 'Mine: Cellphone •••175', nickname: 'Mine', fingerprint: 'f'.repeat(64) }], getIdentity: async () => null };
  const ps = await startWithdraw({ account: founder, ask: { amountCents: 5000, method: 'PAYSHAP' }, deps: d2 });
  assert.equal(ps.state, 'PAYOUT_ACCOUNT');
  for (const t of ['My bank account', 'You have it stored', 'Don’t you have any account info stored for payouts?']) {
    const r = await handleWithdrawReply({ account: founder, state: ps.state, data: ps.data, text: t });
    assert.equal(r.state, 'PAYOUT_ACCOUNT', t); assert.match(r.text, /Nothing is saved for a bank account yet\. I do have Mine: Cellphone •••175 saved for cash withdrawals\. Type the bank account number now/);
  }
  const typed = await handleWithdrawReply({ account: founder, state: ps.state, data: ps.data, text: 'my account number is 62012345678' });
  assert.equal(typed.state, 'PAYOUT_BRANCH', 'a sentence carrying the number is the number');
  // With a bank account saved, the same question lists it and "1" then works.
  const d3 = { ...d2, listDestinations: async () => [{ id: 'b1', method: 'PAYSHAP', family: 'BANK', label: 'Mine: FNB account •••394', nickname: 'Mine', fingerprint: 'a'.repeat(64) }] };
  const ps3 = await startWithdraw({ account: founder, ask: { amountCents: 5000, method: 'PAYSHAP' }, deps: d3 });
  const ask3 = await handleWithdrawReply({ account: founder, state: ps3.state, data: ps3.data, text: 'you have it stored' });
  assert.match(ask3.text, /Saved for this:\n\n1️⃣ Mine: FNB account •••394/);
  const pick = await handleWithdrawReply({ account: founder, state: ps3.state, data: ask3.data, text: 'the mine one' });
  assert.equal(pick.data.recipient.savedId, 'b1', 'picked by nickname');
});

test('round 3: a cellphone typed again that is already saved is a use, not a second save offer; YES with a nickname saves under it; the Absa steps name both SMSes', async () => {
  envOff();
  const { fingerprintOf } = await import('../lib/payout-beneficiaries.js');
  const touched = []; const saved = [];
  const fp = fingerprintOf('acc-f', 'NEDCASH', '0787051175');
  const d = {
    ...deps(15200), resolveProviders: async () => LIVE4, beneficiariesAvailable: () => true,
    listDestinations: async () => [{ id: 'c1', method: 'NEDCASH', family: 'CASH', label: 'Cellphone •••175', nickname: null, fingerprint: fp }],
    getIdentity: async () => ({ fullName: 'Nieuwoudt Gresse', idLast3: '083' }),
    loadIdentity: async () => ({ fullName: 'Nieuwoudt Gresse', idNumber: '9001015009083' }),
    touchDestination: async ({ id }) => { touched.push(id); },
    saveDestination: async (a) => { saved.push(a); return { ok: true, label: `${a.nickname}: Cellphone •••175`, nickname: a.nickname }; },
  };
  const s0 = await startWithdraw({ account: founder, ask: { amountCents: 5000, method: 'CASHSEND' }, deps: d });
  assert.equal(s0.state, 'PAYOUT_MOBILE'); assert.match(s0.text, /1️⃣ Cellphone •••175/);
  const mine = await handleWithdrawReply({ account: founder, state: s0.state, data: s0.data, text: 'mine' });   // typed beside the list
  assert.equal(mine.state, 'PAYOUT_CONFIRM');
  const pin = await handleWithdrawReply({ account: founder, state: mine.state, data: mine.data, text: 'yes' });
  const done = await executeWithdraw({ account: founder, data: pin.data, deps: d });
  assert.equal(done.state, null, 'no second save offer for a number already saved'); assert.deepEqual(touched, ['c1'], 'counted as a use of the saved row');
  assert.match(done.text, /two SMSes from Absa: one with a 10-digit reference and one with a 6-digit PIN/); assert.match(done.text, /1️⃣ Go to any Absa ATM/); assert.match(done.text, /4️⃣ Enter the 10-digit reference from the first SMS, then the 6-digit PIN from the second/); assert.match(done.text, /If anything is unclear, just ask and I will guide you step by step/);
  // A new number: offered, and YES with a nickname saves under it.
  const s1 = await startWithdraw({ account: founder, ask: { amountCents: 5000, method: 'CASHSEND' }, deps: d });
  const other = await handleWithdrawReply({ account: founder, state: s1.state, data: s1.data, text: '083 111 2222' });
  const pin1 = await handleWithdrawReply({ account: founder, state: other.state, data: other.data, text: 'yes' });
  const done1 = await executeWithdraw({ account: founder, data: pin1.data, deps: d });
  assert.equal(done1.state, 'PAYOUT_SAVE'); assert.match(done1.text, /Save these details for next time \(Cellphone •••222\)\? Reply \*YES\*, or give them a name like "mine" or "mother"/);
  const yes = await handleWithdrawReply({ account: founder, state: 'PAYOUT_SAVE', data: done1.data, text: 'Yes please save it as my mother', deps: d });
  assert.equal(saved.length, 1); assert.equal(saved[0].nickname, 'My Mother'); assert.equal(saved[0].recipient.mobile, '0831112222');
  assert.match(yes.text, /✅ Saved as \*My Mother\*, encrypted: My Mother: Cellphone •••175/); assert.match(yes.text, /or say "my mother"/);
});
