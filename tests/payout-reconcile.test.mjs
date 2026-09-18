/**
 * Pay-out reconciliation (BUGLOG #53/#54). The founder's first live PayShap
 * (2026-09-15, R50) parked as PENDING with outcome UNKNOWN: OTT answered with
 * a status code outside our table, nothing of the response was recorded, no
 * webhook ever came, nothing existed to ask OTT again, and the next morning
 * "did my payment go through" was answered with a weeks-old R20 deposit.
 *
 * Locks: an unknown code is recorded with what OTT said and flagged for
 * reconcile; reconcilePayout applies ONLY known terminal codes (100 settles,
 * a failure code releases), leaves 98/99/unknown/transport failures exactly
 * where they are, and never performs a second pay-out; the sweep picks only
 * rows older than the grace period; the route is gated and read-only toward
 * OTT except for GetPaymentStatus; the chat handler consults the newest
 * pay-out and reconciles it live before answering.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { requestPayout, reconcilePayout, reconcilePendingPayouts, reconcileInitPayout, sweepPayoutsAndNotify, getLatestPayout, payoutOutcomeMessage, payoutReference } from '../lib/payouts.js';
import { matchDepositStatusRequest } from '../lib/deposits.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function env() {
  process.env.WAPAY_PAYOUT_ENABLED = 'true';
  process.env.OTT_PAYOUT_BASE_URL = 'https://test-payoutapi.example';
  process.env.OTT_PAYOUT_USERNAME = 'u'; process.env.OTT_PAYOUT_PASSWORD = 'p'; process.env.OTT_PAYOUT_API_KEY = 'k';
  delete process.env.WAPAY_PAYOUT_KYC;
}
function stubPrisma() {
  const prs = []; const journal = new Map(); const holds = new Map(); const accounts = new Map([['acc-1', { id: 'acc-1', waId: '27731234567' }]]);
  return {
    _prs: prs, _journal: journal, _holds: holds, _accounts: accounts,
    journalEntry: { async findUnique({ where }) { return journal.get(where.idemKey) ? { ...journal.get(where.idemKey) } : null; } },
    hold: { async findUnique({ where }) { return holds.get(where.idemKey) ? { ...holds.get(where.idemKey) } : null; } },
    account: { async findUnique({ where }) { return accounts.get(where.id) || null; } },
    providerRequest: {
      async findUnique({ where }) { const r = prs.find((x) => x.idemKey === where.idemKey); return r ? { ...r } : null; },
      async findFirst({ where = {} }) {
        const rows = prs.filter((x) => (!where.route || x.route === where.route) && (!where.accountId || x.accountId === where.accountId)).sort((a, b) => b.requestTs - a.requestTs);
        return rows[0] ? { ...rows[0] } : null;
      },
      async findMany({ where = {}, take }) {
        let rows = prs.filter((x) => (!where.route || x.route === where.route) && (!where.accountId || x.accountId === where.accountId) && (!where.status || x.status === where.status));
        if (where.metadata?.path) rows = rows.filter((x) => x.metadata?.[where.metadata.path[0]] === where.metadata.equals);
        if (where.requestTs?.lt) rows = rows.filter((x) => x.requestTs < where.requestTs.lt);
        return (take ? rows.slice(0, take) : rows).map((r) => ({ ...r }));
      },
      async create({ data }) { const row = { id: `pr${prs.length + 1}`, requestTs: new Date(Date.now() - prs.length * 1000), providerRef: null, ...data }; prs.push(row); return { ...row }; },
      async update({ where, data }) { const r = prs.find((x) => x.idemKey === where.idemKey); Object.assign(r, data); return { ...r }; },
    },
  };
}
function stubLedger({ spendCents = 100000, prisma = null } = {}) {
  const calls = []; const holds = prisma?._holds || new Map(); const journal = prisma?._journal || new Map(); let spend = spendCents; let cash = 0;
  return {
    calls, holds, journal, get spend() { return spend; }, get cash() { return cash; },
    async ensureWallet() { calls.push('ensureWallet'); },
    async postEntry(e) {
      calls.push(`post:${e.source}`);
      if (journal.has(e.idemKey)) return { idemKey: e.idemKey, replayed: true };
      journal.set(e.idemKey, { idemKey: e.idemKey, source: e.source });
      if (e.source === 'BALANCE_UPGRADE') { const amt = e.postings[0].debitCents; spend -= amt; cash += amt; }
      if (e.source === 'BALANCE_DOWNGRADE') { const amt = e.postings[0].debitCents; cash -= amt; spend += amt; }
      return { idemKey: e.idemKey };
    },
    async reserveHold({ idemKey, amountCents }) { calls.push('reserveHold'); holds.set(idemKey, { idemKey, amountCents, status: 'ACTIVE' }); cash -= amountCents; return { holdId: idemKey, status: 'ACTIVE' }; },
    async settleHold({ idemKey, entry }) { calls.push(`settleHold:${entry.source}`); const h = holds.get(idemKey); if (!h) throw new Error(`No hold for idemKey ${idemKey}`); h.status = 'SETTLED'; },
    async releaseHold({ idemKey }) { calls.push('releaseHold'); const h = holds.get(idemKey); if (!h) throw new Error(`No hold for idemKey ${idemKey}`); if (h.status !== 'ACTIVE') return { released: false, status: h.status }; h.status = 'RELEASED'; cash += h.amountCents; return { released: true }; },
  };
}
const providers = [{ method: 'PAYSHAP', label: 'PayShap', providerCode: '127', providerName: 'PayShap Account' }];
const kycd = { id: 'acc-1', msisdn: '27731234567', profile: { kyc: { status: 'VERIFIED' } } };
const recipient = { firstname: 'Nieuwoudt', surname: 'G', mobile: '078 705 1175', account_number: '62525898394', branch_code: '250655', branch_name: 'FNB', id_number: '9001185079083' };

/** PerformPayout answers with a code outside our table, as the sandbox did on 2026-09-15. */
const unknownCode = { httpStatus: 200, status: '7', settlement: 'PENDING', outcome: 'UNKNOWN', retriable: false, paymentReference: null, body: { status: 7, message: 'Queued at provider', account_number: '62525898394' } };
function client(perform, statusScript) {
  const calls = [];
  return {
    calls,
    async performPayout(args) { calls.push(['perform', args]); return typeof perform === 'function' ? perform(args) : perform; },
    async getPaymentStatus(args) { calls.push(['status', args]); if (typeof statusScript === 'function') return statusScript(args); if (statusScript instanceof Error) throw statusScript; return statusScript; },
  };
}
async function parked({ prisma, ledger, c, intentId = 'intent-7000' }) {
  const r = await requestPayout({ prisma, ledger, client: c, account: kycd, intentId, method: 'PAYSHAP', amountCents: 5000, recipient, providers });
  assert.equal(r.status, 'PENDING');
  return r;
}

test('an unknown PerformPayout code parks the pay-out WITH what OTT said, masked, and flags it for reconcile', async () => {
  env();
  const prisma = stubPrisma(); const ledger = stubLedger();
  const r = await parked({ prisma, ledger, c: client(unknownCode) });
  const row = prisma._prs[0];
  assert.equal(row.status, 'PENDING');
  assert.equal(row.metadata.outcome, 'UNKNOWN');
  assert.equal(row.metadata.reconcileRequired, true, 'UNKNOWN must be reconciled, not left forever');
  assert.equal(row.metadata.providerStatus, '7'); assert.equal(row.metadata.httpStatus, 200);
  assert.match(row.metadata.providerBody, /Queued at provider/);
  assert.ok(!row.metadata.providerBody.includes('62525898394'), 'the account number never lands in the row');
  assert.match(row.metadata.providerBody, /\*\*\*394/);
  assert.equal(ledger.holds.get('payout-acc-1-intent-7000-hold').status, 'ACTIVE', 'hold kept: we may have paid');
  const latest = await getLatestPayout({ prisma, accountId: 'acc-1' });
  assert.equal(latest.reference, r.reference); assert.equal(latest.status, 'PENDING'); assert.equal(latest.reconcileRequired, true); assert.equal(latest.providerStatus, '7');
});

test('reconcilePayout: OTT says 100 → settled, customer told; a repeat is a no-op', async () => {
  env();
  const prisma = stubPrisma(); const ledger = stubLedger();
  const c = client(unknownCode, { status: '100', settlement: 'SETTLE', outcome: 'SUCCESS', body: { status: 100, message: 'Payment successful' } });
  const r = await parked({ prisma, ledger, c });
  const out = await reconcilePayout({ prisma, ledger, client: c, reference: r.reference });
  assert.equal(out.status, 'SETTLED'); assert.equal(out.checked, true); assert.equal(out.providerStatus, '100'); assert.equal(out.accountId, 'acc-1'); assert.equal(out.amountCents, 5000);
  assert.equal(prisma._prs[0].status, 'SUCCESS');
  assert.equal(ledger.holds.get('payout-acc-1-intent-7000-hold').status, 'SETTLED');
  assert.equal(c.calls.filter((x) => x[0] === 'perform').length, 1, 'never a second PerformPayout');
  assert.equal(c.calls.at(-1)[1].yourUniqueReference, r.reference, 'GetPaymentStatus asked with OUR reference');
  assert.match(payoutOutcomeMessage(out), /✅ Your withdrawal of R50 by PayShap has been paid \(reference WP/);
  const again = await reconcilePayout({ prisma, ledger, client: c, reference: r.reference });
  assert.deepEqual(again, { ok: true, noop: true, status: 'SETTLED', reference: r.reference });
});

test('reconcilePayout: 98/99 or an unknown code leaves the hold alone but stamps what OTT said', async () => {
  env();
  for (const probe of [
    { status: '98', settlement: 'PENDING', outcome: 'PENDING', body: { status: 98, message: 'Pending transaction' } },
    { status: '7', settlement: 'PENDING', outcome: 'UNKNOWN', body: { status: 7 } },
  ]) {
    const prisma = stubPrisma(); const ledger = stubLedger();
    const c = client(unknownCode, probe);
    const r = await parked({ prisma, ledger, c });
    const out = await reconcilePayout({ prisma, ledger, client: c, reference: r.reference });
    assert.equal(out.status, 'PENDING'); assert.equal(out.checked, true); assert.equal(out.providerStatus, probe.status);
    assert.equal(prisma._prs[0].status, 'PENDING');
    assert.equal(prisma._prs[0].metadata.lastProviderStatus, probe.status);
    assert.ok(prisma._prs[0].metadata.lastCheckedAt, 'the check is dated');
    assert.equal(ledger.holds.get('payout-acc-1-intent-7000-hold').status, 'ACTIVE', 'never released on a non-terminal answer');
    assert.equal(ledger.calls.filter((x) => x === 'releaseHold' || x.startsWith('settleHold')).length, 0);
  }
});

test('reconcilePayout: a failure code releases the hold and the money is back in SPEND', async () => {
  env();
  const prisma = stubPrisma(); const ledger = stubLedger();
  const c = client(unknownCode, { status: '97', settlement: 'RELEASE', outcome: 'PROVIDER_FAILURE', body: { status: 97, message: 'Failed at provider' } });
  const r = await parked({ prisma, ledger, c });
  const out = await reconcilePayout({ prisma, ledger, client: c, reference: r.reference });
  assert.equal(out.status, 'FAILED'); assert.equal(prisma._prs[0].status, 'FAILED');
  assert.equal(ledger.holds.get('payout-acc-1-intent-7000-hold').status, 'RELEASED');
  assert.equal(ledger.spend, 100000, 'R50 + R8 fee back where they were'); assert.equal(ledger.cash, 0);
  assert.match(payoutOutcomeMessage(out), /❌ Your withdrawal of R50 by PayShap could not be completed/);
});

test('reconcilePayout: a transport failure is indeterminate — nothing changes, nothing is released', async () => {
  env();
  const prisma = stubPrisma(); const ledger = stubLedger();
  const boom = new Error('OTT payout transport failure: timeout'); boom.code = 'TRANSPORT_INDETERMINATE';
  const c = client(unknownCode, boom);
  const r = await parked({ prisma, ledger, c });
  const out = await reconcilePayout({ prisma, ledger, client: c, reference: r.reference });
  assert.equal(out.status, 'PENDING'); assert.equal(out.checked, false); assert.equal(out.error, 'TRANSPORT_INDETERMINATE');
  assert.equal(prisma._prs[0].status, 'PENDING'); assert.equal(ledger.holds.get('payout-acc-1-intent-7000-hold').status, 'ACTIVE');
  assert.equal((await reconcilePayout({ prisma, ledger, client: c, reference: 'WPNOPE' })).error, 'UNKNOWN_REFERENCE');
  assert.equal((await reconcilePayout({ prisma, ledger, client: c, reference: '' })).error, 'BAD_REFERENCE');
});

test('reconcilePendingPayouts sweeps only PENDING rows older than the grace period, oldest first', async () => {
  env();
  const prisma = stubPrisma(); const ledger = stubLedger();
  const c = client(unknownCode, ({ yourUniqueReference }) => ({ status: '100', settlement: 'SETTLE', outcome: 'SUCCESS', body: { status: 100, message: `ok ${yourUniqueReference}` } }));
  const a = await parked({ prisma, ledger, c, intentId: 'intent-8001' });
  const b = await parked({ prisma, ledger, c, intentId: 'intent-8002' });
  // a was created "now", b one second earlier (stub); a grace of 500ms picks only b
  const now = Date.now();
  const swept = await reconcilePendingPayouts({ prisma, ledger, client: c, olderThanMs: 500, now });
  assert.deepEqual(swept.map((x) => [x.reference, x.status]), [[b.reference, 'SETTLED']]);
  const rest = await reconcilePendingPayouts({ prisma, ledger, client: c, olderThanMs: 0, now: now + 5000 });
  assert.deepEqual(rest.map((x) => [x.reference, x.status]), [[a.reference, 'SETTLED']]);
  assert.deepEqual(await reconcilePendingPayouts({ prisma, ledger, client: c, olderThanMs: 0, now: now + 5000 }), [], 'nothing left to sweep');
});

test('withdrawal phrasings reach the deterministic status lookup', () => {
  for (const t of ['did my withdrawal go through', 'has my payout arrived', 'was my cash out paid', 'where is my withdrawal', 'withdrawal status', 'status of my payout', 'Did my payment to tbh go through']) {
    assert.ok(matchDepositStatusRequest(t), `should match: "${t}"`);
  }
  for (const t of ['withdraw R50', 'I want to withdraw money', 'how do I withdraw']) {
    assert.ok(!matchDepositStatusRequest(t), `must NOT match (that is a request): "${t}"`);
  }
});

/**
 * An INIT row exactly as requestPayout leaves it when the process dies before
 * PerformPayout answers: the row, then (optionally) the upgrade, then
 * (optionally) the hold, each posted through the same stubs the live flow uses.
 */
async function stranded({ prisma, ledger, intentId = 'intent-9000', upgrade = true, hold = true, ageMs = 60 * 60 * 1000, amountCents = 5000, feeCents = 800 }) {
  const idemKey = `payout-acc-1-${intentId}`;
  const reference = payoutReference(idemKey);
  const meta = { method: 'PAYSHAP', amountCents, feeCents, reference, recipient: { name: 'N G', mobile: '•••175', account: '•••394' }, businessId: null, intentId };
  const row = await prisma.providerRequest.create({ data: { provider: 'OTT', route: 'ott-payout', idemKey, status: 'INIT', accountId: 'acc-1', metadata: meta } });
  prisma._prs.find((x) => x.idemKey === idemKey).requestTs = new Date(Date.now() - ageMs);
  if (upgrade) await ledger.postEntry({ idemKey: `${idemKey}-upgrade`, source: 'BALANCE_UPGRADE', postings: [{ debitCents: amountCents + feeCents }] });
  if (hold) await ledger.reserveHold({ accountId: 'acc-1', amountCents: amountCents + feeCents, idemKey: `${idemKey}-hold` });
  ledger.calls.length = 0;
  return { ...row, idemKey, reference };
}
const noRecord = { status: 0, settlement: 'RELEASE', outcome: 'PAYOUT_REJECTED', body: { status: 0, message: 'Failed to retrieve record' } };
const holdOf = (prisma, k) => prisma._holds.get(`${k}-hold`);

test('INIT + OTT has no record + upgrade and hold posted: hold released, downgrade posted, row FAILED, customer fields returned', async () => {
  env();
  const prisma = stubPrisma(); const ledger = stubLedger({ prisma });
  const c = client(unknownCode, noRecord);
  const pr = await stranded({ prisma, ledger });
  assert.equal(ledger.spend, 100000 - 5800); assert.equal(ledger.cash, 0, 'R58 sits in the hold');
  const out = await reconcileInitPayout({ prisma, ledger, client: c, pr });
  assert.equal(out.ok, true); assert.equal(out.status, 'FAILED'); assert.equal(out.checked, true);
  assert.equal(out.accountId, 'acc-1'); assert.equal(out.amountCents, 5000); assert.equal(out.feeCents, 800); assert.equal(out.method, 'PAYSHAP'); assert.equal(out.reference, pr.reference);
  assert.deepEqual(ledger.calls, ['releaseHold', 'post:BALANCE_DOWNGRADE']);
  assert.equal(holdOf(prisma, pr.idemKey).status, 'RELEASED');
  assert.ok(prisma._journal.has(`${pr.idemKey}-downgrade`), 'the downgrade is keyed deterministically off the intent');
  assert.equal(ledger.spend, 100000, 'R50 + R8 fee back where they were'); assert.equal(ledger.cash, 0);
  const row = prisma._prs[0];
  assert.equal(row.status, 'FAILED'); assert.equal(row.metadata.outcome, 'INIT_ABANDONED_0'); assert.ok(row.metadata.finalisedAt); assert.ok(row.metadata.lastCheckedAt);
  assert.match(payoutOutcomeMessage(out), /❌ Your withdrawal of R50 by PayShap could not be completed/);
  assert.equal(c.calls.filter((x) => x[0] === 'perform').length, 0, 'never a PerformPayout from a reconcile');
  assert.equal(c.calls.at(-1)[1].yourUniqueReference, pr.reference, 'OTT asked with OUR reference');
  // a repeat is a no-op: the row is no longer INIT
  assert.equal((await reconcileInitPayout({ prisma, ledger, client: c, pr: prisma._prs[0] })).noop, true);
});

test('INIT + only the upgrade posted (died before reserveHold): downgrade posted, no release attempted', async () => {
  env();
  const prisma = stubPrisma(); const ledger = stubLedger({ prisma });
  const pr = await stranded({ prisma, ledger, hold: false });
  const out = await reconcileInitPayout({ prisma, ledger, client: client(unknownCode, noRecord), pr });
  assert.equal(out.status, 'FAILED'); assert.equal(out.released, false); assert.equal(out.downgraded, true);
  assert.deepEqual(ledger.calls, ['post:BALANCE_DOWNGRADE']);
  assert.equal(ledger.spend, 100000); assert.equal(ledger.cash, 0);
  assert.equal(prisma._prs[0].status, 'FAILED');
});

test('INIT with nothing posted (died before the upgrade): row FAILED, the ledger is never touched', async () => {
  env();
  const prisma = stubPrisma(); const ledger = stubLedger({ prisma });
  const pr = await stranded({ prisma, ledger, upgrade: false, hold: false });
  const out = await reconcileInitPayout({ prisma, ledger, client: client(unknownCode, { status: '97', settlement: 'RELEASE', outcome: 'PROVIDER_FAILURE', body: { status: 97, message: 'Failed at provider' } }), pr });
  assert.equal(out.status, 'FAILED'); assert.equal(out.released, false); assert.equal(out.downgraded, false);
  assert.deepEqual(ledger.calls, []);
  assert.equal(ledger.spend, 100000);
  assert.equal(prisma._prs[0].status, 'FAILED'); assert.equal(prisma._prs[0].metadata.outcome, 'INIT_ABANDONED_97');
});

test('INIT + OTT says 100 + hold present: the row settles through finalisePayout', async () => {
  env();
  const prisma = stubPrisma(); const ledger = stubLedger({ prisma });
  const pr = await stranded({ prisma, ledger });
  const out = await reconcileInitPayout({ prisma, ledger, client: client(unknownCode, { status: '100', settlement: 'SETTLE', outcome: 'SUCCESS', body: { status: 100, message: 'Payment successful' } }), pr });
  assert.equal(out.status, 'SETTLED'); assert.equal(out.accountId, 'acc-1'); assert.equal(out.amountCents, 5000); assert.equal(out.reference, pr.reference);
  assert.equal(prisma._prs[0].status, 'SUCCESS'); assert.equal(prisma._prs[0].metadata.outcome, 'SUCCESS');
  assert.equal(holdOf(prisma, pr.idemKey).status, 'SETTLED');
  assert.deepEqual(ledger.calls, ['settleHold:CASHOUT_PAYSHAP', 'post:CASHOUT_COST_PAYSHAP']);
  assert.equal(ledger.calls.includes('releaseHold'), false);
  assert.match(payoutOutcomeMessage(out), /✅ Your withdrawal of R50 by PayShap has been paid/);
});

test('INIT + OTT says 100 but no hold exists: NEEDS_OPERATOR, nothing moves', async () => {
  env();
  const prisma = stubPrisma(); const ledger = stubLedger({ prisma });
  const pr = await stranded({ prisma, ledger, hold: false });
  const out = await reconcileInitPayout({ prisma, ledger, client: client(unknownCode, { status: '100', settlement: 'SETTLE', outcome: 'SUCCESS', body: { status: 100, message: 'Payment successful' } }), pr });
  assert.equal(out.ok, false); assert.equal(out.status, 'NEEDS_OPERATOR');
  assert.equal(prisma._prs[0].status, 'NEEDS_OPERATOR'); assert.equal(prisma._prs[0].metadata.outcome, 'PAYOUT_INIT_SETTLED_WITHOUT_HOLD');
  assert.match(prisma._prs[0].metadata.providerBody, /Payment successful/);
  assert.deepEqual(ledger.calls, [], 'no settle without a hold, no release of what was paid');
});

test('INIT + OTT says 98: the row becomes PENDING with what OTT said and the hold stays', async () => {
  env();
  const prisma = stubPrisma(); const ledger = stubLedger({ prisma });
  const pr = await stranded({ prisma, ledger });
  const out = await reconcileInitPayout({ prisma, ledger, client: client(unknownCode, { status: '98', settlement: 'PENDING', outcome: 'PENDING', body: { status: 98, message: 'Pending transaction' } }), pr });
  assert.equal(out.status, 'PENDING'); assert.equal(out.checked, true); assert.equal(out.providerStatus, '98');
  assert.equal(prisma._prs[0].status, 'PENDING'); assert.equal(prisma._prs[0].metadata.lastProviderStatus, '98'); assert.equal(prisma._prs[0].metadata.reconcileRequired, true);
  assert.equal(holdOf(prisma, pr.idemKey).status, 'ACTIVE'); assert.deepEqual(ledger.calls, []);
  // the normal sweep now owns it
  const later = await reconcilePayout({ prisma, ledger, client: client(unknownCode, { status: '100', settlement: 'SETTLE', outcome: 'SUCCESS', body: { status: 100 } }), reference: pr.reference });
  assert.equal(later.status, 'SETTLED'); assert.equal(holdOf(prisma, pr.idemKey).status, 'SETTLED');
});

test('INIT + transport failure: indeterminate, nothing changes', async () => {
  env();
  const prisma = stubPrisma(); const ledger = stubLedger({ prisma });
  const boom = new Error('timeout'); boom.code = 'TRANSPORT_INDETERMINATE';
  const pr = await stranded({ prisma, ledger });
  const out = await reconcileInitPayout({ prisma, ledger, client: client(unknownCode, boom), pr });
  assert.equal(out.checked, false); assert.equal(out.status, 'INIT');
  assert.equal(prisma._prs[0].status, 'INIT'); assert.equal(holdOf(prisma, pr.idemKey).status, 'ACTIVE'); assert.deepEqual(ledger.calls, []);
});

test('the sweep picks INIT rows only past initOlderThanMs, routes them through the INIT recovery, and never calls performPayout', async () => {
  env();
  const prisma = stubPrisma(); const ledger = stubLedger({ prisma });
  const c = client(unknownCode, noRecord);
  const young = await stranded({ prisma, ledger, intentId: 'intent-9101', ageMs: 60 * 1000 });
  const old = await stranded({ prisma, ledger, intentId: 'intent-9102', ageMs: 30 * 60 * 1000 });
  const swept = await reconcilePendingPayouts({ prisma, ledger, client: c, olderThanMs: 0, initOlderThanMs: 10 * 60 * 1000 });
  assert.deepEqual(swept.map((x) => [x.reference, x.status]), [[old.reference, 'FAILED']]);
  assert.equal(prisma._prs.find((x) => x.idemKey === young.idemKey).status, 'INIT', 'a young INIT row is still mid-flight: untouched');
  assert.equal(holdOf(prisma, young.idemKey).status, 'ACTIVE');
  assert.equal(prisma._prs.find((x) => x.idemKey === old.idemKey).status, 'FAILED');
  assert.equal(c.calls.filter((x) => x[0] === 'perform').length, 0, 'the sweep never performs a pay-out');
  assert.equal(c.calls.filter((x) => x[0] === 'status').length, 1);
  // default grace is 10 minutes: the young row is still skipped without the option
  assert.deepEqual(await reconcilePendingPayouts({ prisma, ledger, client: c, olderThanMs: 0 }), []);
});

test('sweepPayoutsAndNotify reconciles PENDING + INIT rows and tells each finalised customer with the shared wording', async () => {
  env();
  const prisma = stubPrisma(); const ledger = stubLedger({ prisma });
  const c = client(unknownCode, ({ yourUniqueReference }) => (yourUniqueReference === pendingRef ? { status: '100', settlement: 'SETTLE', outcome: 'SUCCESS', body: { status: 100 } } : noRecord));
  const p = await parked({ prisma, ledger, c, intentId: 'intent-9201' });
  const pendingRef = p.reference;
  const i = await stranded({ prisma, ledger, intentId: 'intent-9202' });
  const sent = []; const send = async ({ to, text }) => { sent.push({ to, text }); };
  const out = await sweepPayoutsAndNotify({ prisma, ledger, client: c, send, olderThanMs: 0, initOlderThanMs: 0, now: Date.now() + 5000 });
  assert.equal(out.results.length, 2);
  assert.deepEqual(out.counts, { swept: 2, settled: 1, failed: 1, pending: 0, needsOperator: 0, unchecked: 0, errors: 0, notified: 2, notifyFailed: 0 });
  assert.deepEqual(out.notified.sort(), [i.reference, pendingRef].sort());
  assert.equal(sent.length, 2); assert.ok(sent.every((s) => s.to === '27731234567'));
  assert.ok(sent.some((s) => /✅ .*has been paid/.test(s.text))); assert.ok(sent.some((s) => /❌ .*could not be completed/.test(s.text)));
  assert.equal(c.calls.filter((x) => x[0] === 'perform').length, 1, 'only the original PerformPayout, never one from the sweep');
  const again = await sweepPayoutsAndNotify({ prisma, ledger, client: c, send, olderThanMs: 0, initOlderThanMs: 0, now: Date.now() + 5000 });
  assert.deepEqual(again.results, []); assert.equal(sent.length, 2, 'nobody is told twice');
});

test('static: the cron route is cron/secret/internal-key gated, calls the sweep, never a pay-out; daily-vas-sync sweeps best-effort', () => {
  const cron = read('../pages/api/cron/payout-reconcile.js');
  assert.match(cron, /x-vercel-cron'\] === '1'/); assert.match(cron, /process\.env\.CRON_SECRET && key === process\.env\.CRON_SECRET/);
  assert.match(cron, /requireInternalAuth\(req, res\)/); assert.match(cron, /import \{ requireInternalAuth \} from '\.\.\/\.\.\/\.\.\/lib\/internal-auth\.js'/);
  assert.match(cron, /if \(!isAuthed\(req, res\)\) return;/);
  assert.match(cron, /await sweepPayoutsAndNotify\(\{ olderThanMs, initOlderThanMs, limit \}\)/);
  assert.match(cron, /type: 'cron_payout_reconcile'/);
  assert.match(cron, /if \(req\.method !== 'GET'\)/);
  assert.ok(!/performPayout|requestPayout|\.payout\(/.test(cron), 'the cron can never start a pay-out');
  const vas = read('../pages/api/cron/daily-vas-sync.js');
  const at = vas.indexOf('await sweepPayoutsAndNotify(');
  assert.ok(at > -1, 'daily-vas-sync runs the sweep');
  assert.ok(at > vas.indexOf('await syncProductEmbeddings('), 'after the embeddings step');
  const before = vas.slice(0, at);
  assert.ok(before.lastIndexOf('try {') > before.lastIndexOf('catch'), 'the sweep call sits inside its own try');
  assert.match(vas.slice(at), /catch \(e\) \{[\s\S]*cron_payout_sweep_failed/);
  assert.match(vas, /type: 'cron_payout_sweep'/);
  assert.match(vas, /return res\.status\(200\)\.json\(\{ \.\.\.out, turnsPurged, integrity: .*?, embeddings, payoutSweep, jobs \}\)/, 'the cron response never depends on the sweep');
});

test('static: the reconcile route is internal-key gated, asks OTT only GetPaymentStatus, and uses the shared customer wording', () => {
  const src = read('../pages/api/internal/payout-reconcile.js');
  assert.match(src, /if \(!keyOk\(req\)\) return res\.status\(401\)/);
  assert.match(src, /timingSafeEqual/);
  assert.match(src, /Cache-Control', 'private, no-store'/);
  assert.match(src, /if \(req\.method !== 'GET' && req\.method !== 'POST'\) return res\.status\(405\)/);
  assert.ok(!/performPayout|requestPayout|\.payout\(/.test(src), 'the route can never start a pay-out');
  assert.match(src, /reconcilePayout\(\{ reference \}\)/); assert.match(src, /reconcilePendingPayouts\(\{ olderThanMs, limit \}\)/);
  assert.match(src, /payoutOutcomeMessage\(r\)/, 'the customer hears the webhook wording');
  assert.ok(!/recipient/.test(src.replace(/never the recipient/, '')), 'no recipient detail in the operator payload');
  const hook = read('../pages/api/webhooks/ott-payout.js');
  assert.match(hook, /text: payoutOutcomeMessage\(out\)/, 'one source of customer wording for both finalisers');
});

test('static: the chat status handler consults the newest pay-out and reconciles a PENDING one live before answering', () => {
  const p = read('../pages/api/webhooks/message-processor-v2.js');
  const start = p.indexOf('async function handleDepositStatus');
  const body = p.slice(start, p.indexOf('\nasync function ', start));
  assert.match(body, /getLatestPayout\(\{ accountId: account\.id \}\)/, 'pay-outs are looked up alongside deposits');
  assert.match(body, /const wantsPayout = /); assert.match(body, /const wantsDeposit = /); assert.match(body, /payoutIsNewer/);
  assert.match(body, /return await handlePayoutStatus\(\{ from, account, payout, altLine \}\)/);
  const ps = p.indexOf('async function handlePayoutStatus');
  assert.ok(ps > -1, 'the pay-out branch exists');
  const pbody = p.slice(ps, p.indexOf('\n/**', ps));
  assert.match(pbody, /if \(status === 'PENDING'\) \{\s*\n\s*checked = await reconcilePayout\(\{ reference: payout\.reference \}\)/, 'PENDING is checked with OTT, not guessed');
  assert.ok(pbody.indexOf('reconcilePayout(') < pbody.indexOf('getUserBalance(from)'), 'the balance is read AFTER the reconcile');
  assert.match(pbody, /has not been confirmed by the bank yet/); assert.match(pbody, /held aside for it, not lost/);
  assert.match(pbody, /was paid \(reference/); assert.match(pbody, /did not go through \(reference/);
  assert.ok((pbody.match(/Balance: R\$\{balance\}/g) || []).length >= 3, 'every pay-out answer carries the live balance');
  // both call sites hand the customer's words to the handler
  assert.equal((p.match(/handleDepositStatus\(\{ from, account, rawText: text \}\)/g) || []).length, 2);
});
