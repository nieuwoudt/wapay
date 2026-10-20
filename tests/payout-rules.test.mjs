// Pay-out rules (founder, 2026-10-20): the new-account daily cap and KYC by threshold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { payoutRules, kycMode, checkPayoutRules, dailyCapCopy, kycThresholdCopy, rulesNote, DAY_MS } from '../lib/payout-rules.js';
import { requestPayout, kycRequired } from '../lib/payouts.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const NOW = Date.parse('2026-10-20T12:00:00Z');
const ID = 'cmvgbprub00fwhxajjvot4dtk';
const prismaWith = ({ paid = [], createdAt = new Date(NOW - 2 * DAY_MS), profile = {} } = {}) => ({
  providerRequest: { findMany: async ({ where }) => paid.filter((p) => !where.requestTs || new Date(p.at) >= where.requestTs.gte).map((p) => ({ metadata: { amountCents: p.cents } })), findUnique: async () => null, findFirst: async () => null },
  account: { findUnique: async () => ({ createdAt, profile }) },
});

test('rules and modes read from the environment with the agreed defaults', () => {
  const r = payoutRules({});
  assert.equal(r.newAccountDays, 7); assert.equal(r.newAccountDailyCapCents, 1000000); assert.equal(r.kycSingleCents, 300000); assert.equal(r.kycDailyCents, 1000000);
  assert.equal(kycMode({}), 'all'); assert.equal(kycMode({ WAPAY_PAYOUT_KYC: 'off' }), 'off'); assert.equal(kycMode({ WAPAY_PAYOUT_KYC: 'threshold' }), 'threshold'); assert.equal(kycMode({ WAPAY_PAYOUT_KYC: 'OFF' }), 'all', 'only exactly off is off');
  assert.equal(payoutRules({ WAPAY_PAYOUT_NEW_ACCOUNT_DAILY_CAP_CENTS: '500000' }).newAccountDailyCapCents, 500000);
});

test('kycRequired keeps the old behaviour and adds threshold mode', () => {
  const prev = process.env.WAPAY_PAYOUT_KYC;
  try {
    process.env.WAPAY_PAYOUT_KYC = 'off'; assert.equal(kycRequired(), false);
    process.env.WAPAY_PAYOUT_KYC = 'threshold'; assert.equal(kycRequired(), false, 'threshold mode does not gate everyone');
    delete process.env.WAPAY_PAYOUT_KYC; assert.equal(kycRequired(), true);
  } finally { if (prev === undefined) delete process.env.WAPAY_PAYOUT_KYC; else process.env.WAPAY_PAYOUT_KYC = prev; }
});

test('new accounts: R10,000 in any 24 hours, with the remaining amount explained', async () => {
  const env = { WAPAY_PAYOUT_KYC: 'off' };
  const fresh = { id: ID, createdAt: new Date(NOW - 1 * DAY_MS), profile: {} };
  const ok = await checkPayoutRules({ prisma: prismaWith({ paid: [{ at: NOW - 3600e3, cents: 280000 }] }), account: fresh, amountCents: 500000, now: NOW, env });
  assert.equal(ok.ok, true); assert.equal(ok.usedCents, 280000); assert.equal(ok.isNew, true);
  const over = await checkPayoutRules({ prisma: prismaWith({ paid: [{ at: NOW - 3600e3, cents: 800000 }] }), account: fresh, amountCents: 300000, now: NOW, env });
  assert.equal(over.ok, false); assert.equal(over.error, 'DAILY_CAP'); assert.equal(over.remainingCents, 200000);
  assert.match(dailyCapCopy(over), /up to R2,000 more works now/);
  const yesterday = await checkPayoutRules({ prisma: prismaWith({ paid: [{ at: NOW - 25 * 3600e3, cents: 800000 }] }), account: fresh, amountCents: 300000, now: NOW, env });
  assert.equal(yesterday.ok, true, 'a pay-out older than 24 hours no longer counts');
  const old = { id: ID, createdAt: new Date(NOW - 30 * DAY_MS), profile: {} };
  const oldOk = await checkPayoutRules({ prisma: prismaWith({ paid: [{ at: NOW - 3600e3, cents: 900000 }] }), account: old, amountCents: 300000, now: NOW, env });
  assert.equal(oldOk.ok, true, 'the cap is for accounts under a week old only');
  const none = dailyCapCopy({ capCents: 1000000, usedCents: 1000000, remainingCents: 0 });
  assert.match(none, /reached that for now/);
  for (const t of [dailyCapCopy(over), none]) { assert.ok(!/—/.test(t)); assert.ok(!/\b(tomorrow|soon|shortly|minutes?)\b/i.test(t)); }
});

test('threshold mode: R3,000 single or more than R10,000 in 24 hours needs the identity check; verified accounts pass', async () => {
  const env = { WAPAY_PAYOUT_KYC: 'threshold', DIDIT_API_KEY: 'k', DIDIT_WORKFLOW_ID: 'w', DIDIT_WEBHOOK_SECRET: 's' };
  const old = { id: ID, createdAt: new Date(NOW - 30 * DAY_MS), profile: {} };
  const single = await checkPayoutRules({ prisma: prismaWith(), account: old, amountCents: 300000, now: NOW, env });
  assert.equal(single.error, 'KYC_REQUIRED'); assert.equal(single.reason, 'SINGLE'); assert.equal(single.kycConfigured, true);
  assert.match(kycThresholdCopy(single), /Pay-outs of R3,000 or more need a once-off identity check on your phone\. Reply \*VERIFY\*/);
  const under = await checkPayoutRules({ prisma: prismaWith(), account: old, amountCents: 299900, now: NOW, env });
  assert.equal(under.ok, true);
  const daily = await checkPayoutRules({ prisma: prismaWith({ paid: [{ at: NOW - 3600e3, cents: 290000 }, { at: NOW - 7200e3, cents: 290000 }, { at: NOW - 9000e3, cents: 290000 }] }), account: old, amountCents: 200000, now: NOW, env });
  assert.equal(daily.error, 'KYC_REQUIRED'); assert.equal(daily.reason, 'DAILY');
  assert.match(kycThresholdCopy(daily), /more than R10,000 in 24 hours/);
  const verified = { ...old, profile: { kyc: { status: 'VERIFIED' } } };
  assert.equal((await checkPayoutRules({ prisma: prismaWith(), account: verified, amountCents: 300000, now: NOW, env })).ok, true);
  const notConfigured = kycThresholdCopy({ reason: 'SINGLE', thresholdCents: 300000, kycConfigured: false });
  assert.match(notConfigured, /being switched on\. For now up to R2,999 per pay-out works now/);
  assert.equal((await checkPayoutRules({ prisma: prismaWith(), account: old, amountCents: 300000, now: NOW, env: { WAPAY_PAYOUT_KYC: 'off' } })).ok, true, 'off means off');
  assert.equal((await checkPayoutRules({ prisma: prismaWith(), account: old, amountCents: 300000, now: NOW, env: {} })).ok, true, 'all-mode is gated elsewhere, not by threshold');
});

test('the rule note is said only when a rule can bite this account', () => {
  const env = { WAPAY_PAYOUT_KYC: 'threshold' };
  assert.match(rulesNote({ createdAt: new Date(NOW - DAY_MS), now: NOW, env }), /New accounts can pay out up to R10,000 in any 24 hours\. Pay-outs of R3,000 or more/);
  assert.equal(rulesNote({ createdAt: new Date(NOW - 30 * DAY_MS), verified: true, now: NOW, env }), '');
  assert.equal(rulesNote({ createdAt: new Date(NOW - 30 * DAY_MS), now: NOW, env: { WAPAY_PAYOUT_KYC: 'off' } }), '');
});

test('requestPayout refuses by the cap before any ledger move or rail call', async () => {
  const prev = { k: process.env.WAPAY_PAYOUT_KYC, e: process.env.WAPAY_PAYOUT_ENABLED };
  process.env.WAPAY_PAYOUT_KYC = 'off'; process.env.WAPAY_PAYOUT_ENABLED = 'true';
  try {
    let rail = 0; let ledger = 0;
    const prisma = prismaWith({ paid: [{ at: Date.now() - 3600e3, cents: 900000 }], createdAt: new Date(Date.now() - DAY_MS) });
    const out = await requestPayout({ prisma, ledger: async () => { ledger += 1; }, client: { createPayout: async () => { rail += 1; return {}; } }, account: { id: ID, msisdn: '27600000919', createdAt: new Date(Date.now() - DAY_MS), profile: {} }, intentId: 'pi-cap', method: 'PAYSHAP', amountCents: 200000, recipient: { mobile: '0760000000', idNumber: '9001015009087' }, pinProof: { ok: true } });
    assert.equal(out.ok, false); assert.equal(out.error, 'DAILY_CAP'); assert.equal(out.remainingCents, 100000); assert.equal(rail, 0); assert.equal(ledger, 0);
  } finally { if (prev.k === undefined) delete process.env.WAPAY_PAYOUT_KYC; else process.env.WAPAY_PAYOUT_KYC = prev.k; if (prev.e === undefined) delete process.env.WAPAY_PAYOUT_ENABLED; else process.env.WAPAY_PAYOUT_ENABLED = prev.e; }
});

test('the chat flow checks the rules at the amount step and maps the late errors; the dashboard shows referrals and the freeze', () => {
  const chat = read('../lib/payout-chat.js');
  assert.match(chat, /const rules = await checkPayoutRules\(\{ prisma: prismaClient, account, amountCents \}\);\n\s+if \(!rules\.ok\) \{[\s\S]{0,400}return rulesStop\(\{ rules, data, amountCents \}\);/);
  assert.match(chat, /if \(out\.error === 'DAILY_CAP'\)/);
  assert.match(chat, /if \(out\.error === 'KYC_REQUIRED' && out\.reason\)/);
  assert.match(chat, /data\.rulesNote = rulesNote\(/);
  const payouts = read('../lib/payouts.js');
  assert.ok(payouts.indexOf('checkPayoutRules({ prisma: prismaClient, account, amountCents })') < payouts.indexOf('validateIntentId(intentId)'), 'rules right after the freeze, before anything else is parsed');
  const admin = read('../pages/admin/index.js');
  assert.match(admin, /<h2>Referrals<\/h2>/); assert.match(admin, /c\.payoutFreeze && \(/);
  assert.match(read('../pages/api/admin/growth.js'), /\['organic', 'paylink', 'ad', 'referral', 'partner'\]/);
});
