// The express fee and the fraud triage (founder 2026-10-24). Money under two hours old can leave at double
// the fee, never more than the customer confirmed; every pay-out request is scored 1 to 5 and reported to
// the founder; a level-5 request waits for a person until the founder clears the account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { proofFor } from './helpers/pin-proof.mjs';

process.env.WAPAY_INTERNAL_API_KEY ||= 'test-internal-key-for-proofs';
const { expressFor, recentReceipts, expressRules, expressFeeLine, RECEIPT_SOURCE_RE } = await import('../lib/payout-express.js');
const { payoutTriage, levelOf, reviewLevel, reviewNeeded, destinationKey, payoutRequestAlertText, clearanceOf, PAYOUT_REVIEW_COPY } = await import('../lib/payout-triage.js');
const { requestPayout, quotePayout } = await import('../lib/payouts.js');
const { buildCashout } = await import('../lib/ledger-core.js');
const { confirmAsk, executeWithdraw, affordableMaxCents, feeChangedCopy } = await import('../lib/payout-chat.js');
const { createFixtureDeps, FIXTURE_CELL } = await import('../lib/app-dev-fixture.js');
const { payoutCheck } = await import('../lib/app-money.js');
const { withdrawRulesLine } = await import('../lib/fee-facts.js');

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const MIN = 60 * 1000;
const NOW = Date.now();

function env() {
  process.env.WAPAY_PAYOUT_ENABLED = 'true';
  process.env.OTT_PAYOUT_BASE_URL = 'https://test-payoutapi.example';
  process.env.OTT_PAYOUT_USERNAME = 'u'; process.env.OTT_PAYOUT_PASSWORD = 'p'; process.env.OTT_PAYOUT_API_KEY = 'k';
  process.env.WAPAY_PAYOUT_KYC = 'off';
  delete process.env.WAPAY_PAYOUT_REVIEW_LEVEL;
}

test('express: only the part that needs money under two hours old doubles the fee; old money pays the normal fee', () => {
  const fresh = [{ cents: 25000, at: NOW - 30 * MIN }];
  const old = expressFor({ balanceCents: 30000, receipts: fresh, amountCents: 4000, normalFeeCents: 800, now: NOW });
  assert.equal(old.express, false, 'R40 + R8 fits in the R50 that was already there');
  const ex = expressFor({ balanceCents: 30000, receipts: fresh, amountCents: 10000, normalFeeCents: 800, now: NOW });
  assert.equal(ex.express, true); assert.equal(ex.feeCents, 1600); assert.equal(ex.freshCents, 25000); assert.equal(ex.settledCents, 5000);
  assert.equal(ex.normalFromAt, fresh[0].at + 120 * MIN, 'the normal fee is back when that money is two hours old');
  assert.equal(expressFor({ balanceCents: 30000, receipts: [{ cents: 25000, at: NOW - 3 * 60 * MIN }], amountCents: 10000, normalFeeCents: 800, now: NOW }).express, false, 'older money is not fresh');
  assert.equal(expressFor({ balanceCents: 30000, receipts: fresh, amountCents: 10000, normalFeeCents: 800, now: NOW, env: { WAPAY_PAYOUT_EXPRESS_FEE_MULTIPLIER: '1' } }).express, false, 'a multiplier of 1 switches it off');
  assert.equal(expressFor({ balanceCents: 30000, receipts: fresh, amountCents: 40000, normalFeeCents: 800, now: NOW }).normalFromAt, null, 'more than the balance never becomes normal');
  assert.match(expressFeeLine(ex), /^The fee is doubled because some of this money reached your balance less than 2 hours ago\. From \d\d:\d\d the fee is R8\.$/);
  assert.deepEqual(expressRules({}), { windowMs: 120 * MIN, multiplier: 2 });
});

test('fresh money is what came in from outside: paid links, top-ups, sends, claimed gifts; never internal moves or refunds', async () => {
  for (const s of ['LOAD_PAYFAST', 'LOAD_ADUMO', 'BLU_DEPOSIT', 'P2P_SEND', 'GIFT_CLAIM_BALANCE', 'MANUAL_GIFT_TO_WALLET', 'REFERRAL_REWARD', 'TEST_CREDIT_KYC']) assert.ok(RECEIPT_SOURCE_RE.test(s), s);
  for (const s of ['BALANCE_UPGRADE', 'BALANCE_DOWNGRADE', 'VAS_AIRTIME_FAILED', 'GIFT_REFUND', 'REVERSAL_LOAD_PAYFAST', 'CASHOUT_PAYSHAP']) assert.ok(!RECEIPT_SOURCE_RE.test(s), s);
  const prisma = { journalLine: { async findMany({ where }) {
    assert.deepEqual(where.accountCode.in, ['WALLET:acc1:SPEND', 'WALLET:acc1:CASH']);
    return [
      { creditCents: 30000, entry: { source: 'LOAD_PAYFAST', createdAt: new Date(NOW - 20 * MIN) } },
      { creditCents: 30000, entry: { source: 'BALANCE_UPGRADE', createdAt: new Date(NOW - 10 * MIN) } },
      { creditCents: 5000, entry: { source: 'P2P_SEND', createdAt: new Date(NOW - 50 * MIN) } },
    ];
  } } };
  assert.deepEqual(await recentReceipts({ prisma, accountId: 'acc1', now: NOW }), [{ cents: 5000, at: NOW - 50 * MIN }, { cents: 30000, at: NOW - 20 * MIN }]);
  assert.deepEqual(await recentReceipts({ prisma: { journalLine: { async findMany() { throw new Error('db down'); } } }, accountId: 'acc1' }), [], 'a failed read is no fresh money: a fee, never a gate');
});

test('the quote and the ledger carry the agreed fee', () => {
  const q = quotePayout({ method: 'PAYSHAP', amountCents: 10000, feeMultiplier: 2 });
  assert.equal(q.feeCents, 1600); assert.equal(q.normalFeeCents, 800); assert.equal(q.express, true); assert.equal(q.totalCents, 11600);
  assert.equal(quotePayout({ method: 'PAYSHAP', amountCents: 10000 }).express, false);
  const e = buildCashout({ accountId: 'acc1', amountCents: 10000, idemKey: 'k', method: 'PAYSHAP', feeCents: 1600 });
  assert.equal(e.postings.find((p) => p.accountCode === 'WALLET:acc1:CASH').debitCents, 11600);
  assert.equal(e.postings.find((p) => p.accountCode === 'REVENUE:FEE:CASHOUT').creditCents, 1600);
  assert.equal(buildCashout({ accountId: 'acc1', amountCents: 10000, idemKey: 'k', method: 'PAYSHAP' }).postings.find((p) => p.accountCode === 'REVENUE:FEE:CASHOUT').creditCents, 800, 'older rows: the banded fee');
});

// ---- requestPayout end to end, with stubs ----
const providers = [{ method: 'PAYSHAP', label: 'PayShap', providerCode: '66', providerName: 'PayShap Account', minCents: 5000, maxCents: 300000 }];
const recipient = { firstname: 'Lerato', surname: 'M', mobile: '073 123 4567', account_number: '62012345678', branch_code: '250655', branch_name: 'FNB', id_number: '9001015009087' };
function stubPrisma({ account, total = 30000, paidLinks = [], intents = [], otherPayers = [], frozen = [], sameDest = [], history = [], existing = null } = {}) {
  const prs = existing ? [existing] : []; const audits = [];
  return {
    _prs: prs, _audits: audits,
    account: { async findUnique({ where }) { return where.id === account.id ? { ...account } : null; }, async findMany({ where }) { return where?.profile ? frozen : []; } },
    providerRequest: {
      async findUnique({ where }) { const r = prs.find((x) => x.idemKey === where.idemKey); return r ? { ...r } : null; },
      async findMany({ where }) {
        if (where?.route === 'payrequest') return where.NOT ? otherPayers : intents;
        if (where?.metadata?.path?.[0] === 'destKey') return sameDest;
        if (where?.route === 'ott-payout') return history;
        return [];
      },
      async create({ data }) { const row = { id: `pr${prs.length + 1}`, requestTs: new Date(), providerRef: null, ...data }; prs.push(row); return { ...row }; },
      async update({ where, data }) { const r = prs.find((x) => x.idemKey === where.idemKey); Object.assign(r, data); return { ...r }; },
    },
    paymentRequest: { async findMany() { return paidLinks; } },
    journalEntry: { async findMany() { return []; } },
    wallet: { async findMany() { return [{ balanceType: 'SPEND', availableCents: total }, { balanceType: 'CASH', availableCents: 0 }]; } },
    auditLog: { async create({ data }) { audits.push(data); return data; } },
  };
}
function stubLedger() {
  const calls = []; const holds = new Map(); const settled = [];
  return {
    calls, holds, settled,
    async ensureWallet() { calls.push('ensureWallet'); },
    async postEntry(e) { calls.push(`post:${e.source}`); return { idemKey: e.idemKey }; },
    async reserveHold({ idemKey, amountCents }) { calls.push('reserveHold'); holds.set(idemKey, { amountCents, status: 'ACTIVE' }); return {}; },
    async settleHold({ idemKey, entry }) { calls.push(`settleHold:${entry.source}`); settled.push(entry); holds.get(idemKey).status = 'SETTLED'; },
    async releaseHold({ idemKey }) { calls.push('releaseHold'); holds.get(idemKey).status = 'RELEASED'; },
  };
}
const settleRail = (seen = []) => ({ async performPayout(a) { seen.push(a); return { settlement: 'SETTLE', outcome: 'SETTLED', status: 100, paymentReference: 'OTT1' }; }, async getPaymentStatus() { return {}; } });
const oldVerified = { id: 'acc-old-verified-000001', waId: '27731234567', createdAt: new Date(NOW - 60 * 24 * 60 * MIN), profile: { kyc: { status: 'VERIFIED', fullName: 'Lerato M' } } };
const pay = ({ prisma, ledger = stubLedger(), client = settleRail(), account = oldVerified, amountCents = 10000, intentId = 'intent-x0001', receipts = [], expectedFeeCents = null, alerts = [] }) =>
  requestPayout({ prisma, ledger, client, account, intentId, method: 'PAYSHAP', amountCents, recipient, providers, readFloat: async () => null, authorization: proofFor(account, { intentId, amountCents }), receipts, expectedFeeCents, alertRequest: async (a) => { alerts.push(a); } });

test('requestPayout: money under two hours old doubles the fee in the hold, the books and the receipt; the founder hears about it', async () => {
  env();
  const prisma = stubPrisma({ account: oldVerified }); const ledger = stubLedger(); const alerts = [];
  const out = await pay({ prisma, ledger, receipts: [{ cents: 25000, at: NOW - 30 * MIN }], alerts });
  assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.status, 'SETTLED'); assert.equal(out.feeCents, 1600); assert.equal(out.express, true);
  const meta = prisma._prs[0].metadata;
  assert.equal(meta.feeCents, 1600); assert.equal(meta.express, true); assert.equal(meta.normalFeeCents, 800); assert.equal(meta.freshCents, 25000);
  assert.match(meta.destKey, /^[0-9a-f]{32}$/, 'a keyed destination hash, never the number'); assert.ok(!JSON.stringify(meta).includes('62012345678'));
  assert.equal(meta.triage.level, 1, 'an old, ID-checked account');
  assert.equal([...ledger.holds.values()][0].amountCents, 11600, 'the hold covers the doubled fee');
  const entry = ledger.settled[0];
  assert.equal(entry.postings.find((p) => /:CASH$/.test(p.accountCode)).debitCents, 11600);
  assert.equal(entry.postings.find((p) => p.accountCode === 'REVENUE:FEE:CASHOUT').creditCents, 1600);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /^🟢 Pay-out request, fraud level 1\/5 \(very unlikely\)\nR100 by PayShap · fee R16 \(double, money under 2 h old\)\nAccount •••4567 Lerato M · ID checked/);
  assert.match(alerts[0].text, /Result: paid$/);
  assert.equal(prisma._audits[0].event, 'PAYOUT_REQUEST'); assert.equal(prisma._audits[0].metadata.outcome, 'SETTLED'); assert.equal(prisma._audits[0].metadata.level, 1); assert.equal(prisma._audits[0].metadata.express, true);
  const normal = await pay({ prisma: stubPrisma({ account: oldVerified }), intentId: 'intent-x0002', receipts: [] });
  assert.equal(normal.feeCents, 800); assert.equal(normal.express, false);
});

test('requestPayout: a fee higher than the one confirmed is refused before anything moves; a lower one is charged', async () => {
  env();
  const prisma = stubPrisma({ account: oldVerified }); const ledger = stubLedger(); const seen = []; const alerts = [];
  const out = await pay({ prisma, ledger, client: settleRail(seen), receipts: [{ cents: 25000, at: NOW - 30 * MIN }], expectedFeeCents: 800, alerts });
  assert.equal(out.ok, false); assert.equal(out.error, 'FEE_CHANGED'); assert.equal(out.feeCents, 1600); assert.equal(out.expectedFeeCents, 800);
  assert.deepEqual(prisma._prs, []); assert.deepEqual(ledger.calls, []); assert.equal(seen.length, 0);
  assert.match(alerts[0].text, /Result: stopped, the fee went up after the confirmation/);
  assert.match(feeChangedCopy(out), /^💸 The fee for this pay-out is now R16, not the R8 you confirmed, because money reached your balance less than 2 hours ago\. From \d\d:\d\d the fee is R8 again\. Nothing was sent and nothing has left your balance\. Say \*withdraw\* to start again\.$/);
  const lower = await pay({ prisma: stubPrisma({ account: oldVerified }), intentId: 'intent-x0003', receipts: [], expectedFeeCents: 1600 });
  assert.equal(lower.ok, true); assert.equal(lower.feeCents, 800, 'the window passed: the lower fee');
});

// The 22 October burst, as rows: opened today, six card payments in an hour from different numbers, one of those
// numbers paying three other accounts, money under two hours old.
function burst(extraProfile = {}) {
  const account = { id: 'acc-burst-0000000000001', waId: '27831112222', createdAt: new Date(NOW - 3 * 60 * MIN), profile: { ...extraProfile } };
  const paidLinks = Array.from({ length: 6 }, (_, i) => ({ id: `PRB${i}`, payerRef: `PAYFAST:${i}`, paidAt: new Date(NOW - 50 * MIN), amountCents: 30000 }));
  const intents = paidLinks.map((l, i) => ({ id: `pfreq-${l.id}`, metadata: { requestCode: l.id, payerMsisdn: `073123450${i}` } }));
  return { account, prisma: stubPrisma({ account, total: 180000, paidLinks, intents, otherPayers: [{ accountId: 'x1' }, { accountId: 'x2' }, { accountId: 'x3' }] }) };
}

test('the burst pattern scores level 5 and waits for a person: nothing written, held or sent; the founder is told', async () => {
  env();
  const { account, prisma } = burst(); const ledger = stubLedger(); const seen = []; const alerts = [];
  const out = await pay({ prisma, ledger, client: settleRail(seen), account, amountCents: 50000, intentId: 'intent-b0001', receipts: [{ cents: 180000, at: NOW - 50 * MIN }], alerts });
  assert.equal(out.ok, false); assert.equal(out.error, 'REVIEW'); assert.equal(out.level, 5);
  assert.deepEqual(prisma._prs, []); assert.deepEqual(ledger.calls, []); assert.equal(seen.length, 0);
  assert.match(alerts[0].text, /^🔴 Pay-out request, fraud level 5\/5 \(very likely\)/);
  assert.match(alerts[0].text, /Why: account opened in the last 24 hours; pays out money that arrived under 2 hours ago; 6 card payments in 24 hours; a payer of this account also paid 3 other accounts this week/);
  assert.match(alerts[0].text, /Result: HELD for your check, nothing sent\nTo act: clear or freeze account acc-burst-0000000000001$/);
  assert.equal(prisma._audits[0].metadata.outcome, 'REVIEW'); assert.deepEqual(prisma._audits[0].metadata.reasons.slice(0, 1), ['NEW_TODAY']);
  assert.ok(!/—/.test(PAYOUT_REVIEW_COPY)); assert.ok(!/\b(soon|shortly|within|hours?|minutes?|today|tomorrow)\b/i.test(PAYOUT_REVIEW_COPY), 'no time promise to the customer');
  // The founder cleared the account: the same request goes through (and still reports its level).
  const cleared = burst({ payouts: { clearedUntil: new Date(NOW + 3600e3).toISOString(), clearedBy: 'founder' } });
  const alerts2 = [];
  const ok = await pay({ prisma: cleared.prisma, account: cleared.account, amountCents: 50000, intentId: 'intent-b0002', receipts: [{ cents: 180000, at: NOW - 50 * MIN }], alerts: alerts2 });
  assert.equal(ok.ok, true, JSON.stringify(ok)); assert.match(alerts2[0].text, /Result: paid \(cleared by the founder\)/);
  // The review can be switched off; the request then goes and is still reported.
  process.env.WAPAY_PAYOUT_REVIEW_LEVEL = 'off';
  try { assert.equal((await pay({ prisma: burst().prisma, account: burst().account, amountCents: 50000, intentId: 'intent-b0003', receipts: [{ cents: 180000, at: NOW - 50 * MIN }] })).ok, true); } finally { delete process.env.WAPAY_PAYOUT_REVIEW_LEVEL; }
});

test('triage levels: genuine, self-funded, a frozen destination, money moved with a frozen account', async () => {
  const genuine = await payoutTriage({ prisma: stubPrisma({ account: oldVerified }), account: oldVerified, amountCents: 20000, method: 'PAYSHAP', recipient, now: NOW });
  assert.equal(genuine.level, 1); assert.equal(genuine.reasons[0].code === 'ID_CHECKED' || genuine.reasons.length === 1, true);
  const self = { id: 'acc-self-000000000000001', waId: '27731234567', createdAt: new Date(NOW - 3 * 24 * 60 * MIN), profile: {} };
  const links = [0, 1].map((i) => ({ id: `PRS${i}`, payerRef: `PAYFAST:${i}`, paidAt: new Date(NOW - 5 * 60 * MIN), amountCents: 300000 }));
  const t = await payoutTriage({ prisma: stubPrisma({ account: self, paidLinks: links, intents: links.map((l) => ({ id: `pfreq-${l.id}`, metadata: { requestCode: l.id, payerMsisdn: '0731234567' } })) }), account: self, amountCents: 300000, method: 'PAYSHAP', recipient, express: { express: true }, now: NOW });
  assert.equal(t.level, 5); assert.deepEqual(t.reasons.map((r) => r.code), ['OWN_CARD', 'NEW_WEEK', 'FRESH_MONEY', 'FIRST_ALL']);
  assert.equal(t.reasons[0].text, 'paid 2 of its own links by card with its own number');
  const key = destinationKey('PAYSHAP', recipient);
  const viaFrozen = await payoutTriage({ prisma: stubPrisma({ account: oldVerified, frozen: [{ id: 'acc-frozen-1', waId: '27840000000' }], sameDest: [{ accountId: 'acc-frozen-1' }] }), account: oldVerified, amountCents: 20000, method: 'PAYSHAP', recipient, now: NOW });
  assert.equal(viaFrozen.level, 5, 'a frozen account\'s destination is level 5 even for an old, checked account'); assert.equal(viaFrozen.destKey, key);
  const shared = await payoutTriage({ prisma: stubPrisma({ account: oldVerified, sameDest: [{ accountId: 'acc-other' }] }), account: oldVerified, amountCents: 20000, method: 'PAYSHAP', recipient, now: NOW });
  assert.ok(shared.reasons.some((r) => r.code === 'SHARED_DESTINATION'));
  const p = stubPrisma({ account: oldVerified, frozen: [{ id: 'acc-frozen-2', waId: '27845550000' }] });
  p.journalEntry.findMany = async () => [{ lines: [{ accountCode: 'WALLET:acc-frozen-2:SPEND' }, { accountCode: `WALLET:${oldVerified.id}:SPEND` }] }];
  assert.ok((await payoutTriage({ prisma: p, account: oldVerified, amountCents: 20000, method: 'PAYSHAP', recipient, now: NOW })).level >= 4);
  assert.deepEqual([levelOf(-3), levelOf(0), levelOf(1), levelOf(3), levelOf(5), levelOf(7), levelOf(12)], [1, 1, 2, 3, 4, 5, 5]);
  assert.equal(reviewLevel({}), 5); assert.equal(reviewLevel({ WAPAY_PAYOUT_REVIEW_LEVEL: '4' }), 4); assert.equal(reviewLevel({ WAPAY_PAYOUT_REVIEW_LEVEL: 'off' }), null);
  assert.equal(reviewNeeded({ triage: { level: 5, cleared: null }, env: {} }), true); assert.equal(reviewNeeded({ triage: { level: 5, cleared: { until: 'x' } }, env: {} }), false); assert.equal(reviewNeeded({ triage: { level: 4 }, env: {} }), false);
  assert.equal(clearanceOf({ payouts: { clearedUntil: new Date(NOW - 1000).toISOString() } }, NOW), null, 'an expired clearance does not count');
  assert.notEqual(destinationKey('PAYSHAP', { account_number: '62012345678' }), destinationKey('CASHSEND', { mobile: '62012345678' }));
  assert.equal(destinationKey('CASHSEND', { mobile: '0731234567' }), destinationKey('NEDCASH', { mobile: '27731234567' }), 'a phone is the same phone in either form');
});

test('a replay and a paused pay-out are not reported again', async () => {
  env();
  const alerts = [];
  const existing = { id: 'pr1', idemKey: `payout-${oldVerified.id}-intent-r0001`, status: 'SUCCESS', requestTs: new Date(), metadata: { reference: 'WPX', amountCents: 10000, feeCents: 800, method: 'PAYSHAP' } };
  const replay = await pay({ prisma: stubPrisma({ account: oldVerified, existing }), intentId: 'intent-r0001', alerts });
  assert.equal(replay.replayed, true); assert.equal(alerts.length, 0);
  const held = stubPrisma({ account: oldVerified });
  held.processedMessage = { async findUnique({ where }) { return where.waMessageId === 'payout-hold:global' ? { id: 'h' } : null; } };
  const paused = await pay({ prisma: held, intentId: 'intent-r0002', alerts });
  assert.equal(paused.error, 'PAYOUT_HOLD'); assert.equal(alerts.length, 0);
});

test('the chat: the confirmation names the doubled fee and when it ends; the PIN step sends the confirmed fee and words the new refusals', async () => {
  const data = { method: 'PAYSHAP', amountCents: 10000, balanceCents: 30000, receipts: [{ cents: 25000, at: Date.now() - 30 * MIN }], limits: { PAYSHAP: { minCents: 5000, maxCents: 300000 } }, recipient: { savedLabel: 'FNB account •••678' }, intentId: 'wd-exp-0001' };
  const c = confirmAsk(data);
  assert.match(c.text, /Fee: R16 \(double the usual R8\)\nThe fee is doubled because some of this money reached your balance less than 2 hours ago\. From \d\d:\d\d the fee is R8\./);
  assert.match(c.text, /Total leaving your balance: \*R116\*/);
  assert.equal(c.data.feeCents, 1600); assert.equal(c.data.express, true);
  assert.equal(confirmAsk({ ...data, receipts: [] }).data.feeCents, 800);
  const lim = { PAYSHAP: { minCents: 5000, maxCents: 300000 } };
  assert.equal(affordableMaxCents({ method: 'PAYSHAP', balanceCents: 30000, limits: lim }), 29200);
  assert.equal(affordableMaxCents({ method: 'PAYSHAP', balanceCents: 30000, limits: lim, receipts: data.receipts }), 28400, 'all of it with the doubled fee');
  const account = { id: 'acc-chat-0000000000001', waId: '27731234567', profile: { kyc: { status: 'VERIFIED', fullName: 'Lerato M' } } };
  const wd = { ...c.data, recipient: { mobile: '0731234567', account_number: '62012345678', branch_code: '250655', branch_name: 'FNB', id_number: '9001015009087' } };
  const seen = [];
  const reqOut = async (out) => executeWithdraw({ account, data: wd, pinProof: proofFor(account, wd), deps: { requestPayout: async (a) => { seen.push(a); return out; }, pinResetCoolOff: () => null, loadIdentity: async () => null } });
  const changed = await reqOut({ ok: false, error: 'FEE_CHANGED', feeCents: 1600, expectedFeeCents: 800, normalFeeCents: 800, normalFromAt: null });
  assert.equal(seen[0].expectedFeeCents, 1600, 'the fee the customer confirmed travels with the pay-out');
  assert.match(changed.text, /^💸 The fee for this pay-out is now R16, not the R8 you confirmed/);
  assert.equal((await reqOut({ ok: false, error: 'REVIEW', level: 5 })).text, PAYOUT_REVIEW_COPY);
});

test('the web app: the check shows the doubled fee and why, and the request carries the fee that was seen', async () => {
  const deps = createFixtureDeps();
  const account = deps.prisma._tables.account.find((a) => a.msisdn === FIXTURE_CELL);
  deps.recentReceipts = async () => [{ cents: 100000000, at: Date.now() - 10 * MIN }];
  const check = await payoutCheck(deps, { account, method: 'PAYSHAP', amountCents: 5000, destinationId: 'cfixturedest0000000001' });
  assert.equal(check.ok, true, JSON.stringify(check)); assert.equal(check.express, true); assert.equal(check.feeCents, 2 * check.normalFeeCents);
  assert.match(check.feeNote, /reached your balance less than 2 hours ago/);
  deps.recentReceipts = async () => [];
  const normal = await payoutCheck(deps, { account, method: 'PAYSHAP', amountCents: 5000, destinationId: 'cfixturedest0000000001' });
  assert.equal(normal.express, false); assert.equal(normal.feeNote, null);
  assert.match(read('../pages/app/pay-out.js'), /proof: step1\.data\.proof, feeCents: check\.feeCents \}/);
  assert.match(read('../pages/api/app/payout.js'), /feeCents: intOf\(b\.feeCents\)/);
});

test('an operator pay-out never carries the express fee; the business portal quotes it and sends the fee it showed', async () => {
  env();
  const prisma = stubPrisma({ account: oldVerified });
  const out = await requestPayout({ prisma, ledger: stubLedger(), client: settleRail(), account: oldVerified, intentId: 'intent-op001', method: 'PAYSHAP', amountCents: 10000, recipient, providers, readFloat: async () => null, authorization: proofFor(oldVerified, { intentId: 'intent-op001', amountCents: 10000 }), receipts: [{ cents: 25000, at: NOW - 30 * MIN }], allowExpress: false, alertRequest: async () => {} });
  assert.equal(out.ok, true); assert.equal(out.feeCents, 800, 'the founder chose the timing, not the customer');
  assert.match(read('../lib/ops-payout.js'), /authorization, allowExpress: false \}\);/);
  const biz = read('../pages/api/business/payout.js');
  assert.match(biz, /expectedFeeCents: Number\.isInteger\(body\.feeCents\) \? body\.feeCents : null/);
  assert.match(biz, /feeNote: ex\?\.express \? expressFeeLine\(ex\) : null/);
  assert.match(read('../pages/business/index.js'), /recipient: rec, feeCents: quote\.feeCents,/);
});

test('the readouts: the bot quotes the rules, the flags show them, Mission Control lists the requests, the review route needs a reason', () => {
  assert.equal(withdrawRulesLine({ WAPAY_PAYOUT_KYC: 'threshold' }), 'Money that reached your balance less than 2 hours ago costs double the fee to withdraw. You can withdraw up to R3000 in any 24 hours, and more than R1000 in 24 hours needs a once-off ID check.');
  assert.match(read('../pages/api/internal/flags.js'), /payoutRules: \(\(\) =>/);
  assert.match(read('../pages/admin/index.js'), /<h2>Pay-out requests<\/h2>\n\s+<PayoutRequests tick=\{tick\} \/>/);
  assert.match(read('../pages/api/admin/payout-requests.js'), /requireAdmin\(req\)\.ok/);
  const review = read('../pages/api/internal/payout-review.js');
  assert.match(review, /requireInternalAuth\(req, res\)/); assert.match(review, /NEED_REASON/);
  const payouts = read('../lib/payouts.js');
  const core = payouts.slice(payouts.indexOf('async function requestPayoutCore('));
  assert.ok(core.indexOf('verifyPinProof(authorization') < core.indexOf('payoutTriage({'), 'only a request with a valid PIN is scored');
  assert.ok(core.indexOf("error: 'REVIEW'") < core.indexOf('providerRequest.create('), 'the review comes before any row');
  assert.ok(core.indexOf("error: 'FEE_CHANGED'") < core.indexOf('providerRequest.create('), 'the fee check comes before any row');
  const text = payoutRequestAlertText({ triage: { level: 3, reasons: [{ code: 'NEW_WEEK', points: 2, text: 'account 3 days old' }], facts: { verified: false } }, account: { waId: '27731234567', displayName: 'Thandi' }, amountCents: 50000, method: 'CASHSEND', feeCents: 1800, out: { ok: true, status: 'PENDING' } });
  assert.ok(!/—/.test(text)); assert.ok(!/9001015009087|62012345678/.test(text));
  assert.match(text, /^🟡 Pay-out request, fraud level 3\/5 \(possible\)\nR500 by Absa cash · fee R18\nAccount •••4567 Thandi · ID not checked\nWhy: account 3 days old\nResult: with the bank rail$/);
});
