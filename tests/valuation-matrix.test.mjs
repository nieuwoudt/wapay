/**
 * The live valuation matrix and the operator alerts (founder, 2026-10-19).
 * Locks: the repo model reproduces the artifact's great case to the rand;
 * the projection overlays measured inputs and nothing else; the alert text
 * carries aggregates only and fires once per event; the money paths call it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { projectionMatrix, simulate, preset, budgetFn, BUDGET_DEFAULT, milestones, fmtR } from '../lib/scale-model.js';
import { opsAlertRecipients, opsAlertMinCents, moneyInText, payoutLowText, opsMoneyIn, opsPayoutDone } from '../lib/ops-alerts.js';
import { floatWarnCents, sastDayStart } from '../lib/payout-float.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

test('the repo model is the artifact: the great case at month 6 and its milestones', () => {
  const res = simulate(preset('great'), budgetFn(BUDGET_DEFAULT));
  const r6 = res.rows[5];
  assert.equal(Math.round(r6.cumOnb / 100) * 100, 81600);
  assert.equal(Math.round(r6.mau / 100) * 100, 36800);
  assert.equal(fmtR(r6.revenue), 'R920k');
  assert.equal(fmtR(r6.valRev), 'R265m');
  assert.equal(fmtR(r6.valActive), 'R99.4m');
  assert.equal(fmtR(-res.minCash), 'R1.11m');
  const ms = milestones(res, [100000, 1000000]);
  assert.equal(ms[0].row.m, 7);
  assert.equal(ms[1].row.m, 13);
  // The plan case is the 13 September assessment, a far more modest path.
  const plan = simulate(preset('plan'), budgetFn(BUDGET_DEFAULT));
  assert.equal(fmtR(plan.rows[5].valRev), 'R17.9m');
  assert.equal(milestones(plan, [1000000])[0].row.m, 36);
});

test('projectionMatrix: plan, measured overlay under two budgets, bound cases, labels, what was used', () => {
  const v = projectionMatrix({ inputs: {}, currentMonthlySpend: 0 });
  assert.deepEqual(v.months, [6, 12, 24, 36]);
  assert.deepEqual(Object.keys(v.scenarios).sort(), ['great', 'now', 'nowCurrentSpend', 'plan', 'stop']);
  assert.deepEqual(v.scenarios.now.at, v.scenarios.plan.at, 'nothing measured: the measured run is the plan run');
  assert.equal(v.scenarios.nowCurrentSpend.at[0].spendMonthly, 0, 'no spend: no paid acquisition');
  assert.equal(v.monthLabels[6], 'Mar 2027');
  assert.equal(v.monthLabels[36], 'Sept 2029');
  assert.equal(v.measuredUsed.length, 0);
  const w = projectionMatrix({ inputs: { cpConv: 1.9, convToOnb: 63.5 }, currentMonthlySpend: 11500 });
  assert.ok(w.scenarios.now.at[0].accounts > v.scenarios.plan.at[0].accounts * 5, 'cheaper accounts compound under the plan budget');
  assert.ok(w.scenarios.nowCurrentSpend.at[0].accounts < w.scenarios.now.at[0].accounts, 'today\'s spend is far below the plan budget');
  assert.equal(w.currentMonthlySpend, 11500);
  assert.deepEqual(w.measuredUsed.map((u) => [u.key, u.status]), [['cpConv', 'great'], ['convToOnb', 'great']]);
  assert.equal(w.assumedCount, 29);
  const e = projectionMatrix({ inputs: { actToFund: 2, onbToAct: 40 }, earlyKeys: ['actToFund'] });
  assert.deepEqual(e.measuredUsed.map((u) => [u.key, u.early]), [['onbToAct', false], ['actToFund', true]]);
  assert.equal(e.earlyCount, 1);
  assert.ok(e.scenarios.now.at[1].valRev < v.scenarios.plan.at[1].valRev, 'a 2% paid-link rate pulls the projection below the plan');
  for (const sc of Object.values(w.scenarios)) {
    assert.equal(sc.at.length, 4);
    assert.ok(Number.isInteger(sc.peakFunding) && sc.peakFunding >= 0);
    assert.deepEqual(sc.milestones.map((m) => m.target), [1000, 10000, 100000, 1000000]);
  }
});

test('the growth route returns the matrix and the admin page renders it on both tabs', () => {
  const growth = read('../pages/api/admin/growth.js');
  assert.match(growth, /projectionMatrix\(\{ inputs: inputsForMatrix, earlyKeys, currentMonthlySpend: Math\.round\(\(\(spend7dCents \/ 100\) \/ 7\) \* 30\), launchMonth: '2026-10' \}\)/);
  assert.match(growth, /const earlyKeys = Object\.keys\(earlyRaw\)\.filter\(\(k\) => \(measuredRaw\[k\]\?\.n \?\? 0\) < MIN_SAMPLE && \(earlyRaw\[k\]\.n \?\? 0\) >= MIN_SAMPLE\)/);
  assert.match(growth, /scenarioUrl: scenario,\s*valuation,/);
  const page = read('../pages/admin/index.js');
  assert.equal((page.match(/Valuation matrix, live/g) || []).length, 2, 'the Dashboard card and the Growth card');
  assert.match(page, /<ValuationMatrix compact \/>/);
  assert.match(page, /<ValuationMatrix v=\{g\.valuation\} \/>/);
  assert.match(page, /\['Made a link', f\.linked, 'created a payment link'\]/);
  assert.match(page, /\['Customer balances', R\(v\.balancesCents \?\? v\.floatCents\)/);
  assert.ok(!page.includes("['Wallet float'"), 'the liability is no longer called a float');
  assert.match(page, /<FloatTile balancesCents=/);
  assert.match(page, /\['Money in today', R\(v\.today\?\.moneyInCents\)/);
  const metrics = read('../pages/api/admin/metrics.js');
  assert.match(metrics, /accounts,\s*linked,\s*funded,/);
  assert.match(metrics, /balancesCents: floatCents,/);
  assert.match(metrics, /moneyInCents: Number\(inRows\?\.\[0\]\?\.cents \|\| 0\)/);
});

// ---------------------------------------------------------------- the operator alerts

const position = { balancesCents: 38750, wallets: 6, walletsAbove20: 3, floatCents: 87012, floatError: null, floatConfigured: true, warnCents: 150000, coverX: 2.2, daysOfCover: 9.1, payouts7d: { n: 4, cents: 66700 }, payoutsToday: { n: 1, cents: 32500 }, openLinks: { n: 73, cents: 3072400 }, low: true };

test('recipients and the minimum come from env; unset means log only and every amount', () => {
  assert.deepEqual(opsAlertRecipients({ WAPAY_OPS_ALERT_MSISDNS: ' 27787051175, 0787051175 ,x' }), ['27787051175', '0787051175']);
  assert.deepEqual(opsAlertRecipients({}), []);
  assert.equal(opsAlertMinCents({}), 0);
  assert.equal(opsAlertMinCents({ WAPAY_OPS_ALERT_MIN_CENTS: '2500' }), 2500);
  assert.equal(floatWarnCents({}), 150000);
  assert.equal(floatWarnCents({ WAPAY_FLOAT_WARN_CENTS_OTT_PAYOUT: '500000' }), 500000);
  const d = sastDayStart(new Date('2026-10-19T01:30:00Z'));
  assert.equal(d.toISOString(), '2026-10-18T22:00:00.000Z', '01:30 UTC is still the 19th in South Africa');
});

test('the alert text: amount, source, balances, float, cover, open links; never a name, number or reference', () => {
  const account = { profile: { attribution: { ctwaClid: 'x' }, name: 'Thandi Mokoena' } };
  const t = moneyInText({ amountCents: 25000, kind: 'LINK_PAID', account, position });
  assert.match(t, /^💰 Money in: R250\.00 \(payment link paid by card\) to an ad-acquired customer\./);
  assert.match(t, /Customer balances: R387\.50 in 6 wallets \(3 at or above R20\)\./);
  assert.match(t, /Pay-out float: R870\.12 · cover 2\.2× of balances · 9\.1 days at the week's pace · warn level R1,500\.00\./);
  assert.match(t, /Open links: 73 \(R30,724\.00\)\. Pay-outs today: 1 \(R325\.00\)\./);
  assert.match(t, /Top up the OTT pay-out float now\.$/);
  assert.doesNotMatch(t, /Thandi|Mokoena|\d{9,}/);
  const fine = moneyInText({ amountCents: 1000, kind: 'DEPOSIT', account: {}, position: { ...position, low: false, coverX: 3 } });
  assert.match(fine, /card deposit\) to a customer\./);
  assert.match(fine, /Float is fine for now\.$/);
  const unreadable = moneyInText({ amountCents: 1000, kind: 'DEPOSIT', account: null, position: { ...position, floatCents: null, floatError: 'TIMEOUT', coverX: null, daysOfCover: null, low: null } });
  assert.match(unreadable, /not readable right now \(TIMEOUT\)/);
  const low = payoutLowText({ amountCents: 32500, method: 'PAYSHAP', position });
  assert.match(low, /^⚠️ Pay-out float R870\.12 after a R325\.00 PAYSHAP pay-out, below the warn level R1,500\.00\./);
  for (const s of [t, fine, unreadable, low]) assert.ok(!/[—–]/.test(s), 'no em dashes');
});

function stubDb({ dupes = new Set() } = {}) {
  const created = [];
  return {
    created,
    processedMessage: { create: async ({ data }) => { if (dupes.has(data.waMessageId)) { const e = new Error('dup'); e.code = 'P2002'; throw e; } created.push(data.waMessageId); return data; } },
    account: { findUnique: async () => ({ profile: { acquisitionSource: 'organic' } }), findFirst: async () => ({ id: 'acc' }) },
  };
}

test('money in: once per event, below the minimum skipped, delivered to every recipient with the float position', async () => {
  const sent = [];
  const deps = { floatPosition: async () => position, deliver: async ({ text, kind }) => { sent.push({ text, kind }); return { sent: 1, recipients: 1 }; } };
  const db = stubDb();
  const r1 = await opsMoneyIn({ amountCents: 25000, kind: 'LINK_PAID', accountId: 'a1', idemKey: 'pf-1', prisma: db, deps });
  assert.equal(r1.sent, 1);
  assert.match(r1.text, /Money in: R250\.00/);
  assert.deepEqual(db.created, ['ops-alert:in:pf-1']);
  const r2 = await opsMoneyIn({ amountCents: 25000, kind: 'LINK_PAID', accountId: 'a1', idemKey: 'pf-1', prisma: stubDb({ dupes: new Set(['ops-alert:in:pf-1']) }), deps });
  assert.deepEqual(r2, { skipped: 'DUPLICATE' });
  const prev = process.env.WAPAY_OPS_ALERT_MIN_CENTS;
  process.env.WAPAY_OPS_ALERT_MIN_CENTS = '5000';
  try {
    assert.deepEqual(await opsMoneyIn({ amountCents: 1000, kind: 'DEPOSIT', idemKey: 'pf-2', prisma: stubDb(), deps }), { skipped: 'BELOW_MIN' });
  } finally { if (prev === undefined) delete process.env.WAPAY_OPS_ALERT_MIN_CENTS; else process.env.WAPAY_OPS_ALERT_MIN_CENTS = prev; }
  assert.deepEqual(await opsMoneyIn({ amountCents: 0, idemKey: 'x', prisma: stubDb(), deps }), { skipped: 'NO_AMOUNT' });
  assert.deepEqual(await opsMoneyIn({ amountCents: 100, prisma: stubDb(), deps }), { skipped: 'NO_KEY' });
  // A failing float read never fails the alert or the money path.
  const r3 = await opsMoneyIn({ amountCents: 100, idemKey: 'pf-3', prisma: stubDb(), deps: { ...deps, floatPosition: async () => { throw new Error('rail down'); } } });
  assert.equal(r3.error, 'rail down');
  assert.equal(sent.length, 1);
});

test('after a pay-out: silent while the float is fine, one alert when it is thin', async () => {
  const sent = [];
  const deliver = async ({ text, kind }) => { sent.push({ text, kind }); return { sent: 1, recipients: 1 }; };
  const ok = await opsPayoutDone({ amountCents: 32500, method: 'PAYSHAP', reference: 'ref-1', prisma: stubDb(), deps: { floatPosition: async () => ({ ...position, low: false, coverX: 4 }), deliver } });
  assert.deepEqual(ok, { skipped: 'FLOAT_OK', floatCents: 87012 });
  const thin = await opsPayoutDone({ amountCents: 32500, method: 'PAYSHAP', reference: 'ref-2', prisma: stubDb(), deps: { floatPosition: async () => position, deliver } });
  assert.equal(thin.sent, 1);
  assert.match(thin.text, /^⚠️ Pay-out float/);
  assert.deepEqual(await opsPayoutDone({ amountCents: 1, reference: 'ref-2', prisma: stubDb({ dupes: new Set(['ops-alert:out:ref-2']) }), deps: { floatPosition: async () => position, deliver } }), { skipped: 'DUPLICATE' });
  assert.equal(sent.length, 1);
});

test('the money paths call the alert after a successful, non-replayed credit; the pay-out finalisation calls the float check', () => {
  const itn = read('../pages/api/payfast/itn.js');
  assert.match(itn, /await markDeposit\(\{ paymentId, status: 'SUCCESS', providerRef: params\.pf_payment_id \}\);\s*\/\/[^\n]*\n\s*if \(!posted\?\.replayed\) \{\s*const \{ opsMoneyIn \} = await import\('\.\.\/\.\.\/\.\.\/lib\/ops-alerts\.js'\);\s*await opsMoneyIn\(\{ amountCents, kind: intent\.route === 'deposit' \? 'DEPOSIT' : 'LINK_PAID', accountId, idemKey: intent\.idemKey \}\);/);
  const card = read('../lib/card-settlement.js');
  assert.match(card, /if \(!posted\?\.replayed\) \{\s*const \{ opsMoneyIn \} = await import\('\.\/ops-alerts\.js'\);\s*await opsMoneyIn\(\{ amountCents, kind: intent\.route === 'deposit' \? 'DEPOSIT' : 'LINK_PAID', accountId, idemKey: intent\.idemKey, prisma: prismaClient \}\);/);
  const payouts = read('../lib/payouts.js');
  assert.match(payouts, /log\('payout_finalised', \{ reference, status: 'SUCCESS' \}\);[\s\S]{0,200}await opsPayoutDone\(\{ amountCents: m\.amountCents, method: m\.method, reference: idemKey, prisma: prismaClient \}\);/);
  const alerts = read('../lib/ops-alerts.js');
  assert.doesNotMatch(alerts, /account\.waId|msisdn:|displayName|\.name\b/, 'the alert module never reaches for a customer identifier');
});
