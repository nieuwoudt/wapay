/**
 * Founder test 2026-09-17 (BUGLOG #68): R66 in the wallet, CashSend picked
 * (R50 minimum, R18 fee). The flow asked "between R50 and R3000", refused 50
 * as "more than you have, up to R48", then refused 48 as "below the R50
 * minimum". A method the balance cannot cover must be named as such on the
 * menu, refused with the reason at the pick, and every ceiling the flow
 * states must be reachable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { startWithdraw, handleWithdrawReply, affordableMaxCents } from '../lib/payout-chat.js';
import { quotePayout } from '../lib/payouts.js';

const env = () => { process.env.WAPAY_PAYOUT_ENABLED = 'true'; process.env.WAPAY_PAYOUT_KYC = 'off'; };
const verified = { id: 'acc_afford', waId: '27600000901', msisdn: '27600000901', profile: { kyc: { status: 'VERIFIED', firstName: 'Test', lastName: 'Person' } } };
const deps = (totalCents) => ({ payoutBalances: async () => ({ spendCents: 0, cashCents: totalCents, totalCents }), requestPayout: async () => ({ ok: true, status: 'SETTLED', reference: 'WPTEST', amountCents: 0, feeCents: 0 }) });
const live = [
  { method: 'PAYSHAP', providerCode: '127', providerName: 'PayShap Account', minCents: 5000, maxCents: 15000000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile', 'account_number', 'branch_code'] },
  { method: 'CASHSEND', providerCode: '112', providerName: 'ABSA CashSend', minCents: 5000, maxCents: 300000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
  { method: 'NEDCASH', providerCode: '113', providerName: 'Nedbank Cardless', minCents: 2000, maxCents: 300000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
  { method: 'EWALLET', providerCode: '114', providerName: 'FNB eWallet', minCents: 2000, maxCents: 300000, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
];
const R = (c) => 'R' + (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));

test('affordableMaxCents: null when the minimum plus its fee does not fit; otherwise the largest whole rand whose total fits', () => {
  const limits = Object.fromEntries(live.map((p) => [p.method, { minCents: p.minCents, maxCents: p.maxCents }]));
  const needCash = quotePayout({ method: 'CASHSEND', amountCents: 5000, minCents: 5000, maxCents: 300000 }).totalCents;
  assert.ok(needCash > 6600, 'the founder case: R66 cannot cover CashSend at its minimum');
  assert.equal(affordableMaxCents({ method: 'CASHSEND', balanceCents: 6600, limits }), null);
  assert.equal(affordableMaxCents({ method: 'CASHSEND', balanceCents: needCash, limits }), 5000, 'exactly the minimum plus its fee');
  const capShap = affordableMaxCents({ method: 'PAYSHAP', balanceCents: 6600, limits });
  assert.ok(capShap >= 5000 && capShap <= 6600);
  assert.ok(quotePayout({ method: 'PAYSHAP', amountCents: capShap, minCents: 5000, maxCents: 15000000 }).totalCents <= 6600, 'the cap itself fits');
  assert.ok(capShap + 100 > 15000000 || quotePayout({ method: 'PAYSHAP', amountCents: capShap + 100, minCents: 5000, maxCents: 15000000 }).totalCents > 6600, 'one rand more does not');
  assert.equal(affordableMaxCents({ method: 'PAYSHAP', balanceCents: 100000000, limits }), 15000000, 'never above the method maximum');
  assert.equal(affordableMaxCents({ method: 'NOPE', balanceCents: 6600, limits }), null);
});

test('R66 against CashSend: the menu names what it needs, the pick is refused with the reason and the alternatives, and no unreachable ceiling is ever promised', async () => {
  env();
  const d = { ...deps(6600), resolveProviders: async () => live };
  const menu = await startWithdraw({ account: verified, ask: {}, deps: d });
  assert.equal(menu.state, 'PAYOUT_METHOD');
  const needCash = quotePayout({ method: 'CASHSEND', amountCents: 5000, minCents: 5000, maxCents: 300000 }).totalCents;
  assert.match(menu.text, new RegExp('2️⃣ \\*Cash at an Absa ATM\\*.*\\(needs ' + R(needCash).replace('.', '\\.') + ' with the fee\\)'));
  assert.doesNotMatch(menu.text.split('\n').find((l) => l.startsWith('3️⃣')) || '', /needs/, 'an affordable option carries no warning');

  const pick = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: '2' });
  assert.equal(pick.state, 'PAYOUT_METHOD', 'no amount question for a method the balance cannot cover');
  assert.equal(pick.data.method, null);
  assert.match(pick.text, new RegExp('^With R66 you cannot use cash at an Absa ATM yet: the R50 minimum plus the ' + R(needCash - 5000).replace('.', '\\.') + ' fee is ' + R(needCash).replace('.', '\\.') + '\\.'));
  assert.match(pick.text, /Reply \*1\* or \*3\* or \*4\* for PayShap or cash at a Nedbank ATM or an FNB eWallet, or add money first\./);
  assert.doesNotMatch(pick.text, /up to R48/);

  const ned = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: pick.data, text: '3' });
  assert.equal(ned.state, 'PAYOUT_AMOUNT');
  const capNed = affordableMaxCents({ method: 'NEDCASH', balanceCents: 6600, limits: menu.data.limits });
  assert.match(ned.text, new RegExp('Between R20 and ' + R(capNed).replace('.', '\\.') + '\\. You have R66 available'));
  const tooMuch = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: ned.data, text: '66' });
  assert.equal(tooMuch.state, 'PAYOUT_AMOUNT');
  assert.match(tooMuch.text, new RegExp('You can withdraw up to ' + R(capNed).replace('.', '\\.') + ' by Cash at a Nedbank ATM\\.'));
  const ok = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: ned.data, text: String(capNed / 100) });
  assert.notEqual(ok.state, 'PAYOUT_AMOUNT', 'the stated ceiling is accepted');

  // the agent's proposal path: R50 by CashSend lands on the same refusal
  const direct = await startWithdraw({ account: verified, ask: { amountCents: 5000, method: 'CASHSEND' }, deps: d });
  assert.equal(direct.state, 'PAYOUT_METHOD');
  assert.match(direct.text, /you cannot use cash at an Absa ATM yet/);

  // the entry gate counts the fee: R25 covers no option once the fee is added
  const poor = await startWithdraw({ account: verified, ask: {}, deps: { ...deps(2500), resolveProviders: async () => live } });
  assert.equal(poor.state, null);
  assert.match(poor.text, /Withdrawals start at R20 plus the fee, so the smallest one needs R\d+(\.\d\d)?, and you have R25 available right now\./);
});

test('a bare option number typed at the amount step switches the method instead of being read as rands (founder typed "3" after "choose *3*", 2026-09-17)', async () => {
  env();
  const d = { ...deps(10000), resolveProviders: async () => live };
  const menu = await startWithdraw({ account: verified, ask: {}, deps: d });
  const absa = await handleWithdrawReply({ account: verified, state: 'PAYOUT_METHOD', data: menu.data, text: '2' });
  assert.equal(absa.state, 'PAYOUT_AMOUNT');
  // Since 2026-09-18 the below-minimum reply offers one switch as a yes/no
  // instead of listing menu numbers, so a bare option number is tested on its
  // own: at the amount step, '3' still means option 3, never R3.
  const switched = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: absa.data, text: '3' });
  assert.equal(switched.data.method, 'NEDCASH', '"3" picks option 3');
  assert.equal(switched.state, 'PAYOUT_AMOUNT');
  assert.match(switched.text, /withdraw by Cash at a Nedbank ATM\? Between R20/);
  const nine = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: absa.data, text: '9' });
  // R9 is under every method's minimum, so there is nothing to offer: the
  // plain refusal, and still read as an amount rather than an option number.
  assert.match(nine.text, /^R9 is below the R50 minimum for cash at an Absa ATM\. Please type an amount of R50 or more/, 'a number above the option count is still an amount');
  const real = await handleWithdrawReply({ account: verified, state: 'PAYOUT_AMOUNT', data: switched.data, text: '30' });
  assert.notEqual(real.state, 'PAYOUT_AMOUNT', 'a real amount still moves on');
});
