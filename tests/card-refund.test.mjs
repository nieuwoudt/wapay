// A card refund made by hand in the PayFast or Adumo dashboard is booked in the ledger (BUGLOG #146, 2026-11-09).
// The shapes are the frozen account •••1332 of 7 and 8 November: three R3,000 links paid by card (each credited
// R2,871.70) and one R50 card top-up. Everything runs against an in-memory database whose transactions roll back,
// through the real builders and the real postEntry, so the short-balance race and the double call are the real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.WAPAY_INTERNAL_API_KEY ||= 'test-internal-key-for-proofs';
const { buildLoad, buildSend, ACCT, RAIL } = await import('../lib/ledger-core.js');
const { postEntry } = await import('../lib/ledger-post.js');
const { paymentRequestFeeCents, depositFeeCents } = await import('../lib/deposits.js');
const { planCardRefund, postCardRefund, refusalStatus, refundIdemKeyFor, normaliseProviderRef, summariseLoad, cardRefundAlertText, maskDigits, REFUNDED_STATUS } = await import('../lib/card-refund.js');
const { watchlist } = await import('../lib/watchlist.js');
const { default: handler } = await import('../pages/api/internal/card-refund.js');

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const ACC = 'cacctfrozen00000000001332';
const WA = '27600001332';
const OTHER = 'cacctother000000000000077';

// ---------------------------------------------------------------------------
// In-memory database: only the query shapes lib/card-refund.js and postEntry use.
// ---------------------------------------------------------------------------
function memoryDb() {
  const t = { account: [], wallet: [], journalEntry: [], journalLine: [], providerRequest: [], paymentRequest: [], auditLog: [] };
  let seq = 0;
  const id = (p) => `${p}${String(++seq).padStart(6, '0')}`;
  const clone = (v) => structuredClone(v);
  const cond = (v, c) => {
    if (c && typeof c === 'object' && !Array.isArray(c) && !(c instanceof Date)) {
      if ('in' in c) return c.in.includes(v);
      if ('gte' in c) return v >= c.gte;
      return false;
    }
    return v === c;
  };
  const match = (row, where = {}) => Object.entries(where).every(([k, c]) => cond(row[k], c));
  const p2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
  const apply = (row, data) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && ('increment' in v || 'decrement' in v)) row[k] = row[k] + (v.increment || 0) - (v.decrement || 0);
      else row[k] = clone(v);
    }
  };
  const withLines = (e) => ({ ...clone(e), lines: t.journalLine.filter((l) => l.entryId === e.id).map(clone) });
  const simple = (name) => ({
    async findUnique({ where }) { const r = t[name].find((x) => match(x, where)); return r ? clone(r) : null; },
    async findFirst({ where }) { const r = t[name].find((x) => match(x, where)); return r ? clone(r) : null; },
    async findMany({ where = {} } = {}) { return t[name].filter((x) => match(x, where)).map(clone); },
    async update({ where, data }) { const r = t[name].find((x) => match(x, where)); if (!r) throw Object.assign(new Error('not found'), { code: 'P2025' }); apply(r, data); return clone(r); },
    async updateMany({ where, data }) { const rows = t[name].filter((x) => match(x, where)); rows.forEach((r) => apply(r, data)); return { count: rows.length }; },
    async create({ data }) { const row = { id: id(name), ...clone(data) }; if (t[name].some((x) => x.id === row.id)) throw p2002(); t[name].push(row); return clone(row); },
  });
  const db = {
    t,
    account: simple('account'),
    wallet: simple('wallet'),
    providerRequest: simple('providerRequest'),
    paymentRequest: simple('paymentRequest'),
    auditLog: simple('auditLog'),
    journalEntry: {
      async findUnique({ where, include }) { const e = t.journalEntry.find((x) => match(x, where)); return e ? (include?.lines ? withLines(e) : clone(e)) : null; },
      async findMany({ where = {} } = {}) { return t.journalEntry.filter((x) => match(x, where)).map(clone); },
      async create({ data }) {
        if (t.journalEntry.some((x) => x.idemKey === data.idemKey)) throw p2002();
        const { lines, ...rest } = data;
        const e = { id: id('je'), createdAt: new Date(), ...clone(rest) };
        t.journalEntry.push(e);
        for (const l of lines.create) t.journalLine.push({ id: id('jl'), entryId: e.id, ...clone(l) });
        return withLines(e);
      },
    },
    // A failed transaction leaves nothing behind, as Postgres does.
    async $transaction(fn) {
      const snap = clone(t);
      try {
        return await fn(db);
      } catch (error) {
        for (const k of Object.keys(t)) t[k] = snap[k];
        throw error;
      }
    },
  };
  return db;
}

/** Debits minus credits over every line: zero, always. */
const trialBalance = (db) => db.t.journalLine.reduce((s, l) => s + (l.debitCents || 0) - (l.creditCents || 0), 0);
/** What the journal says a wallet holds; must equal the stored row. */
const derived = (db, accountId) => db.t.journalLine.filter((l) => l.accountCode === ACCT.wallet(accountId, 'SPEND')).reduce((s, l) => s + (l.creditCents || 0) - (l.debitCents || 0), 0);
const netOf = (db, code) => db.t.journalLine.filter((l) => l.accountCode === code).reduce((s, l) => s + (l.debitCents || 0) - (l.creditCents || 0), 0);
const balanceOf = (db, accountId = ACC) => db.t.wallet.find((w) => w.accountId === accountId).availableCents;

/** A link paid by card exactly as pages/api/pay/checkout.js + the PayFast ITN leave it. */
// `stamped`: the load carries the charge that credited it as externalRef, as the ITN and settleCardPayment write it
// since 2026-11-09. The 7-8 November payments predate that, so the •••1332 seed is unstamped.
async function payLinkByCard(db, { code, amountCents = 300000, ref, rail = 'PAYFAST', payer = '0600005055', stamped = false, payerRef = `${rail}:${ref}` }) {
  const feeCents = paymentRequestFeeCents(amountCents, rail);
  const idemKey = `wapay-payreq-${code}`;
  db.t.paymentRequest.push({ id: code, accountId: ACC, amountCents, status: 'PAID', payerRef, paidAt: new Date(), createdAt: new Date(), expiresAt: new Date(Date.now() + 6 * 86400e3) });
  db.t.providerRequest.push({ id: `pfreq-${code}`, provider: rail, route: 'payrequest', idemKey, status: 'SUCCESS', providerRef: ref, accountId: ACC, requestTs: new Date(), metadata: { accountId: ACC, waId: WA, amountCents: amountCents - feeCents, feeCents, grossCents: amountCents, requestCode: code, rail, payerMsisdn: payer } });
  await postEntry({ ...buildLoad({ accountId: ACC, rail, faceCents: amountCents - feeCents, customerFeeCents: feeCents, idemKey }), ...(stamped ? { externalRef: ref } : {}) }, { tx: db });
  return { idemKey, feeCents };
}

/** A card top-up exactly as createDepositIntent + the PayFast ITN leave it (the fee is on top). */
async function topUpByCard(db, { key, amountCents = 5000, ref, stamped = false }) {
  const feeCents = depositFeeCents(amountCents);
  const idemKey = `wapay-pfdep-${key}`;
  db.t.providerRequest.push({ id: key, provider: 'PAYFAST', route: 'deposit', idemKey, status: 'SUCCESS', providerRef: ref, accountId: ACC, requestTs: new Date(), metadata: { accountId: ACC, waId: WA, amountCents, feeCents, grossCents: amountCents + feeCents } });
  await postEntry({ ...buildLoad({ accountId: ACC, rail: RAIL.PAYFAST, faceCents: amountCents, customerFeeCents: feeCents, idemKey }), ...(stamped ? { externalRef: ref } : {}) }, { tx: db });
  return { idemKey, feeCents };
}

async function seed1332() {
  const db = memoryDb();
  db.t.account.push({ id: ACC, waId: WA }, { id: OTHER, waId: '27600000077' });
  db.t.wallet.push({ id: 'w1', accountId: ACC, balanceType: 'SPEND', availableCents: 0, pendingCents: 0 }, { id: 'w2', accountId: OTHER, balanceType: 'SPEND', availableCents: 0, pendingCents: 0 });
  await topUpByCard(db, { key: 'earliertopupaaaa', amountCents: 1830, ref: '3000000000' }); // what it held before 7 Nov
  await payLinkByCard(db, { code: 'PRLINKAA', ref: '3051111585' });
  await payLinkByCard(db, { code: 'PRLINKBB', ref: '3052222407', payer: '0600005073' });
  await payLinkByCard(db, { code: 'PRLINKCC', ref: '3053333461' });
  await topUpByCard(db, { key: 'novembereightaaa', amountCents: 5000, ref: '3060000050' });
  return db;
}

/** The ops alert as opsPersonAlert behaves: once per key (its ProcessedMessage claim). */
function alerts() {
  const sent = [];
  const seen = new Set();
  return {
    sent,
    seen,
    deps: {
      opsPersonAlert: async (a) => {
        if (seen.has(a.key)) return { skipped: 'DUPLICATE' };
        seen.add(a.key);
        sent.push(a);
        return { sent: 1, recipients: 1, text: a.text };
      },
    },
  };
}

test('the seeded account matches 7-8 November: R2,871.70 per R3,000 link, R8,683.40 held, books balanced', async () => {
  const db = await seed1332();
  assert.equal(paymentRequestFeeCents(300000), 12830, 'the receiver fee on R3,000 (docs/COMMERCIALS.md)');
  assert.equal(balanceOf(db), 868340);
  assert.equal(trialBalance(db), 0);
});

test('happy path: the dry run writes nothing; the refund mirrors the whole load, closes the link, audits, alerts once, messages nobody', async () => {
  const db = await seed1332();
  const before = { entries: db.t.journalEntry.length, audits: db.t.auditLog.length };

  const plan = await planCardRefund({ prisma: db, providerRef: '3051111585' });
  assert.equal(plan.ok, true);
  assert.equal(plan.referenceCheck, 'LINK', 'the paid link names the charge that credited');
  assert.equal(plan.original.source, 'LOAD_PAYFAST');
  assert.equal(plan.original.idemKey, 'wapay-payreq-PRLINKAA');
  assert.deepEqual(plan.amounts, { chargedCents: 300000, walletCreditCents: 287170, feeRevenueCents: 12830, walletDebitCents: 287170, feeReversedCents: 12830 });
  assert.deepEqual(plan.wallet, { balanceType: 'SPEND', availableCents: 868340, pendingCents: 0, debitCents: 287170, afterCents: 581170 });
  assert.deepEqual(plan.paymentRequest, { code: 'PRLINKAA', status: 'PAID', becomes: REFUNDED_STATUS });
  assert.equal(plan.phone, '•••1332');
  assert.equal(plan.payer, '•••5055');
  assert.equal(plan.reversal.source, 'REVERSAL_LOAD_PAYFAST');
  assert.equal(db.t.journalEntry.length, before.entries, 'a dry run posts nothing');
  assert.equal(db.t.paymentRequest.find((r) => r.id === 'PRLINKAA').status, 'PAID', 'a dry run marks nothing');

  const { sent, deps } = alerts();
  const out = await postCardRefund({ prisma: db, providerRef: 'PAYFAST:3051111585', reason: 'stolen card, refunded in PayFast', by: 'founder', deps });
  assert.equal(out.ok, true);
  assert.equal(out.reversed, true);
  assert.equal(balanceOf(db), 581170);
  assert.equal(out.wallet.afterCents, 581170);

  // The reversal is the exact mirror: the fee revenue goes too, and clearing gives back the gross the payer paid.
  const rev = db.t.journalEntry.find((e) => e.idemKey === refundIdemKeyFor('wapay-payreq-PRLINKAA'));
  assert.equal(rev.source, 'REVERSAL_LOAD_PAYFAST');
  assert.equal(rev.externalRef, '3051111585');
  assert.equal(rev.metadata.reversalOf, 'wapay-payreq-PRLINKAA');
  assert.equal(rev.metadata.by, 'founder');
  const lines = db.t.journalLine.filter((l) => l.entryId === rev.id).map((l) => [l.accountCode, l.debitCents ?? 0, l.creditCents ?? 0]).sort();
  assert.deepEqual(lines, [['CLEARING:PAYFAST', 0, 300000], ['REVENUE:FEE:DEPOSIT', 12830, 0], [`WALLET:${ACC}:SPEND`, 287170, 0]].sort());
  assert.equal(trialBalance(db), 0, 'the books still balance');
  assert.equal(derived(db, ACC), balanceOf(db), 'the stored balance equals the journal');
  assert.equal(netOf(db, ACCT.providerExpense('PAYFAST')), 0, 'no processor cost line is invented: the card fee was never booked per payment');

  const request = db.t.paymentRequest.find((r) => r.id === 'PRLINKAA');
  assert.equal(request.status, 'REFUNDED');
  const intent = db.t.providerRequest.find((r) => r.idemKey === 'wapay-payreq-PRLINKAA');
  assert.equal(intent.status, 'SUCCESS', 'the processor did take the money; the refund is recorded beside it');
  assert.deepEqual(Object.keys(intent.metadata.refund).sort(), ['at', 'by', 'providerRef', 'reason', 'reversalIdemKey']);
  assert.equal(intent.metadata.payerMsisdn, '0600005055', 'the rest of the intent is kept');

  assert.equal(db.t.auditLog.length, before.audits + 1);
  assert.equal(db.t.auditLog[0].event, 'CARD_REFUND');
  assert.equal(db.t.auditLog[0].accountId, ACC);
  assert.equal(db.t.auditLog[0].metadata.walletDebitCents, 287170);

  assert.equal(sent.length, 1, 'one ops alert');
  assert.equal(sent[0].key, 'card-refund:wapay-payreq-PRLINKAA');
  assert.match(sent[0].text, /R3,000\.00 charged by card \(PayFast …1585/);
  assert.match(sent[0].text, /•••1332/);
  assert.match(sent[0].text, /R2,871\.70 off the balance, now R5,811\.70; fee revenue R128\.30 reversed/);
  assert.match(sent[0].text, /Link PRLINKAA is now refunded/);
  assert.match(sent[0].text, /No message went to the customer/);
  assert.ok(!/27600001332|0600001332|0600005055/.test(JSON.stringify({ out, texts: sent.map((s) => s.text), audit: db.t.auditLog })), 'masked numbers only: the answer, the alert and the audit row');
});

test('a second call refuses ALREADY_REVERSED: no second entry, no second debit, no second audit row or alert', async () => {
  const db = await seed1332();
  const { sent, deps } = alerts();
  await postCardRefund({ prisma: db, providerRef: '3052222407', reason: 'stolen card', by: 'founder', deps });
  const state = { entries: db.t.journalEntry.length, balance: balanceOf(db), audits: db.t.auditLog.length };

  const again = await postCardRefund({ prisma: db, providerRef: '3052222407', reason: 'stolen card', by: 'founder', deps });
  assert.equal(again.ok, false);
  assert.equal(again.refused, 'ALREADY_REVERSED');
  assert.equal(refusalStatus(again.refused), 409);
  assert.ok(again.existing.journalEntryId);
  assert.equal(db.t.journalEntry.length, state.entries);
  assert.equal(balanceOf(db), state.balance);
  assert.equal(db.t.auditLog.length, state.audits);
  assert.equal(sent.length, 1);
  // The same refund named by its idemKey is the same refund.
  const byKey = await postCardRefund({ prisma: db, idemKey: 'wapay-payreq-PRLINKBB', reason: 'stolen card', deps });
  assert.equal(byKey.refused, 'ALREADY_REVERSED');
  assert.equal((await planCardRefund({ prisma: db, providerRef: '3052222407' })).refused, 'ALREADY_REVERSED');
  assert.equal(trialBalance(db), 0);
});

test('a second call repairs what a first call that died after the money left undone (mark, audit, alert)', async () => {
  const db = await seed1332();
  const { sent, seen, deps } = alerts();
  await postCardRefund({ prisma: db, providerRef: '3053333461', reason: 'stolen card', by: 'founder', deps });
  // As if the function died after the commit: the audit row and the alert never happened, the link still reads PAID.
  db.t.auditLog.length = 0;
  sent.length = 0;
  seen.clear();
  db.t.paymentRequest.find((r) => r.id === 'PRLINKCC').status = 'PAID';
  const balance = balanceOf(db);

  const again = await postCardRefund({ prisma: db, providerRef: '3053333461', reason: 'stolen card', by: 'founder', deps });
  assert.equal(again.refused, 'ALREADY_REVERSED');
  assert.equal(again.repaired.requestMarked, true);
  assert.equal(again.repaired.auditWritten, true);
  assert.equal(db.t.paymentRequest.find((r) => r.id === 'PRLINKCC').status, 'REFUNDED');
  assert.equal(db.t.auditLog.length, 1);
  assert.equal(db.t.auditLog[0].metadata.by, 'founder', 'the repair keeps the first call\'s operator, from the entry');
  assert.equal(sent.length, 1);
  assert.equal(balanceOf(db), balance, 'a repair never moves money');
  const third = await postCardRefund({ prisma: db, providerRef: '3053333461', reason: 'stolen card', deps });
  assert.equal(third.repaired.auditWritten, false);
  assert.equal(sent.length, 1, 'still one alert');
});

test('short balance: refused SHORT with the numbers, nothing written, the wallet never goes negative', async () => {
  const db = await seed1332();
  // The customer moved R7,000 to another account before the refund (the freeze stops this today; the guard must not rely on it).
  await postEntry(buildSend({ fromAccountId: ACC, toAccountId: OTHER, amountCents: 700000, idemKey: 'send-before-refund' }), { tx: db });
  assert.equal(balanceOf(db), 168340);
  const snapshot = structuredClone(db.t);
  const { sent, deps } = alerts();

  const plan = await planCardRefund({ prisma: db, providerRef: '3051111585' });
  assert.equal(plan.ok, false);
  assert.equal(plan.refused, 'SHORT');
  assert.equal(plan.shortCents, 287170 - 168340);
  assert.equal(plan.wallet.availableCents, 168340);
  assert.equal(plan.wallet.afterCents, undefined, 'no after-balance is shown for a refund that cannot post');

  const out = await postCardRefund({ prisma: db, providerRef: '3051111585', reason: 'stolen card', deps });
  assert.equal(out.refused, 'SHORT');
  assert.equal(refusalStatus(out.refused), 409);
  assert.deepEqual(db.t, snapshot, 'nothing written: no entry, no mark, no audit row');
  assert.equal(sent.length, 0, 'no alert for a refusal');
  assert.ok(balanceOf(db) >= 0);
});

test('short balance found only at the debit (money spent after the check): the transaction rolls back whole', async () => {
  const db = await seed1332();
  await postEntry(buildSend({ fromAccountId: ACC, toAccountId: OTHER, amountCents: 700000, idemKey: 'send-before-refund' }), { tx: db });
  // The dry-run read is stale (it saw the balance before the send); the conditional decrement in postEntry decides.
  const stale = { ...db, wallet: { ...db.wallet, findFirst: async () => ({ availableCents: 868340, pendingCents: 0 }) } };
  stale.$transaction = db.$transaction;
  const snapshot = structuredClone(db.t);
  const { sent, deps } = alerts();
  const out = await postCardRefund({ prisma: stale, providerRef: '3051111585', reason: 'stolen card', deps });
  assert.equal(out.refused, 'SHORT');
  assert.equal(out.shortCents, 287170 - 168340);
  assert.deepEqual(db.t, snapshot, 'the entry, the link mark and the intent flag all rolled back');
  assert.equal(sent.length, 0);
});

test('a non-LOAD entry is refused: a link paid from a WaPay balance, a voucher load', async () => {
  const db = memoryDb();
  db.t.account.push({ id: ACC, waId: WA }, { id: OTHER, waId: '27600000077' });
  db.t.wallet.push({ id: 'w1', accountId: ACC, balanceType: 'SPEND', availableCents: 0, pendingCents: 0 }, { id: 'w2', accountId: OTHER, balanceType: 'SPEND', availableCents: 50000, pendingCents: 0 });
  // A link paid from a balance shares the link's idemKey but is a P2P_SEND.
  await postEntry(buildSend({ fromAccountId: OTHER, toAccountId: ACC, amountCents: 20000, idemKey: 'wapay-payreq-PRBALANC' }), { tx: db });
  await postEntry(buildLoad({ accountId: ACC, rail: RAIL.BLU, faceCents: 10000, idemKey: 'blu-load-voucherabc' }), { tx: db });
  const snapshot = structuredClone(db.t);
  for (const idemKey of ['wapay-payreq-PRBALANC', 'blu-load-voucherabc']) {
    const plan = await planCardRefund({ prisma: db, idemKey });
    assert.equal(plan.refused, 'NOT_A_CARD_LOAD', idemKey);
    const out = await postCardRefund({ prisma: db, idemKey, reason: 'test' });
    assert.equal(out.refused, 'NOT_A_CARD_LOAD', idemKey);
    assert.equal(refusalStatus(out.refused), 422);
  }
  // A reversal is not a load either: refunding a refund is refused.
  const s = await seed1332();
  await postCardRefund({ prisma: s, providerRef: '3051111585', reason: 'stolen card', deps: alerts().deps });
  assert.equal((await planCardRefund({ prisma: s, idemKey: refundIdemKeyFor('wapay-payreq-PRLINKAA') })).refused, 'NOT_A_CARD_LOAD');
  assert.deepEqual(db.t, snapshot);
});

test('a second charge for an already-credited link is refused: it never reached a balance', async () => {
  const db = await seed1332();
  // The payer was charged twice for PRLINKAA; the ITN's markDeposit overwrote the intent's providerRef with the second id.
  db.t.providerRequest.find((r) => r.idemKey === 'wapay-payreq-PRLINKAA').providerRef = '3059999999';
  const balance = balanceOf(db);
  const dup = await postCardRefund({ prisma: db, providerRef: '3059999999', reason: 'duplicate charge', deps: alerts().deps });
  assert.equal(dup.refused, 'NOT_THE_CREDITED_PAYMENT');
  assert.equal(dup.requestCode, 'PRLINKAA');
  assert.equal(dup.creditedBy, 'card …1585');
  assert.equal(balanceOf(db), balance);
  // The payment that did credit the link is still found by its own reference (the paid link's payerRef).
  const real = await postCardRefund({ prisma: db, providerRef: '3051111585', reason: 'stolen card', deps: alerts().deps });
  assert.equal(real.ok, true);
  assert.equal(real.original.providerRef, '3051111585');
});

test('the R50 top-up: the fee the customer paid on top comes back too, and all four 1332 payments leave the books balanced', async () => {
  const db = await seed1332();
  const fee = depositFeeCents(5000);
  const plan = await planCardRefund({ prisma: db, providerRef: '3060000050' });
  assert.equal(plan.paymentRequest, null, 'a top-up has no link');
  assert.deepEqual(plan.amounts, { chargedCents: 5000 + fee, walletCreditCents: 5000, feeRevenueCents: fee, walletDebitCents: 5000, feeReversedCents: fee });
  // 8 November predates the recorded crediting charge, and a top-up has no link to name it: the operator confirms.
  assert.equal(plan.referenceCheck, 'UNVERIFIED');
  assert.match(plan.confirm.check, /exactly one successful payment for m_payment_id novembereightaaa/);
  const { sent, deps } = alerts();
  const before = structuredClone(db.t);
  const unconfirmed = await postCardRefund({ prisma: db, providerRef: '3060000050', reason: 'stolen cards', deps });
  assert.equal(unconfirmed.refused, 'CONFIRM_ONLY_CHARGE');
  assert.equal(refusalStatus(unconfirmed.refused), 409);
  assert.deepEqual(db.t, before, 'nothing written without the confirmation');
  for (const ref of ['3051111585', '3052222407', '3053333461']) {
    const out = await postCardRefund({ prisma: db, providerRef: ref, reason: 'stolen cards, refunded in PayFast', by: 'founder', deps });
    assert.equal(out.ok, true, ref);
    assert.equal(out.referenceCheck, 'LINK', 'a paid link names the charge that credited it');
  }
  const topUp = await postCardRefund({ prisma: db, providerRef: '3060000050', reason: 'stolen cards, refunded in PayFast', by: 'founder', onlyCharge: true, deps });
  assert.equal(topUp.ok, true);
  assert.equal(db.t.auditLog.at(-1).metadata.onlyChargeConfirmed, true, 'the audit row says it was booked on the operator\'s word');
  assert.equal(balanceOf(db), 1830, 'only what the account held before 7 November is left');
  assert.equal(derived(db, ACC), 1830);
  assert.equal(trialBalance(db), 0);
  assert.equal(netOf(db, 'REVENUE:FEE:DEPOSIT'), -depositFeeCents(1830), 'only the earlier top-up\'s fee stays as revenue');
  assert.equal(netOf(db, 'CLEARING:PAYFAST'), 1830 + depositFeeCents(1830), 'clearing holds only the earlier top-up');
  assert.deepEqual(db.t.paymentRequest.map((r) => r.status), ['REFUNDED', 'REFUNDED', 'REFUNDED']);
  assert.ok(db.t.providerRequest.find((r) => r.id === 'novembereightaaa').metadata.refund);
  assert.equal(db.t.auditLog.length, 4);
  assert.equal(sent.length, 4);
  assert.match(sent[3].text, new RegExp(`R${(5000 + fee) / 100}\\.00 charged by card \\(PayFast …0050`), 'the payer gets what they paid, fee included');
  assert.match(sent[3].text, /booked on the operator's word that it was the only one/);
});

test('a top-up charged twice: the recorded crediting charge decides, the duplicate is refused, the real one is found', async () => {
  const db = await seed1332();
  // Since 2026-11-09 the ITN writes the crediting charge on the load. Charge A credited; a second charge B on the
  // same m_payment_id replayed the entry, and markDeposit overwrote the intent's providerRef with B.
  await topUpByCard(db, { key: 'doublechargedaaa', amountCents: 10000, ref: '3070000001', stamped: true });
  db.t.providerRequest.find((r) => r.id === 'doublechargedaaa').providerRef = '3070000002';
  const balance = balanceOf(db);
  const dup = await postCardRefund({ prisma: db, providerRef: '3070000002', reason: 'duplicate charge refunded', deps: alerts().deps });
  assert.equal(dup.refused, 'NOT_THE_CREDITED_PAYMENT', 'the charge that never reached a balance moves nothing');
  assert.equal(dup.creditedBy, 'card …0001');
  assert.equal(balanceOf(db), balance);
  const real = await planCardRefund({ prisma: db, providerRef: '3070000001' });
  assert.equal(real.ok, true, 'the crediting charge is found by the load itself, not the overwritten intent');
  assert.equal(real.referenceCheck, 'ENTRY');
  assert.equal(real.confirm, undefined, 'no confirmation needed when the books name the charge');
});

test('a link whose payerRef names no charge (REPAIR:replayed) is not refused as a second charge', async () => {
  const db = await seed1332();
  await payLinkByCard(db, { code: 'PRREPAIRA', ref: '3080000001', payerRef: 'REPAIR:replayed', stamped: true });
  const stamped = await planCardRefund({ prisma: db, providerRef: '3080000001' });
  assert.equal(stamped.ok, true);
  assert.equal(stamped.referenceCheck, 'ENTRY');
  await payLinkByCard(db, { code: 'PRREPAIRB', ref: '3080000002', payerRef: 'REPAIR:replayed' });
  const older = await planCardRefund({ prisma: db, providerRef: '3080000002' });
  assert.equal(older.ok, true, 'found through the intent');
  assert.equal(older.referenceCheck, 'UNVERIFIED', 'but booked only on the operator\'s word');
});

test('before the REFUNDED migration a link refusal is clear (NEEDS_MIGRATION, 503) and nothing is written', async () => {
  const db = await seed1332();
  const oldCheck = `CHECK ((status = ANY (ARRAY['PENDING'::text, 'PAID'::text, 'CANCELLED'::text, 'EXPIRED'::text])))`;
  db.$queryRaw = async () => [{ def: oldCheck }];
  const before = structuredClone(db.t);
  const plan = await planCardRefund({ prisma: db, providerRef: '3051111585' });
  assert.equal(plan.refused, 'NEEDS_MIGRATION');
  assert.equal(plan.migration, '20261109_payment_request_refunded');
  assert.equal(refusalStatus(plan.refused), 503);
  const out = await postCardRefund({ prisma: db, providerRef: '3051111585', reason: 'stolen card', deps: alerts().deps });
  assert.equal(out.refused, 'NEEDS_MIGRATION');
  // A top-up marks no link, so it does not wait for the migration.
  assert.equal((await planCardRefund({ prisma: db, providerRef: '3060000050' })).ok, true);
  db.$queryRaw = async () => [{ def: oldCheck.replace("'EXPIRED'::text", "'EXPIRED'::text, 'REFUNDED'::text") }];
  assert.equal((await planCardRefund({ prisma: db, providerRef: '3051111585' })).ok, true, 'after the migration');

  // When the check cannot be read, the database's own refusal rolls the whole transaction back.
  delete db.$queryRaw;
  const update = db.paymentRequest.updateMany;
  db.paymentRequest.updateMany = async () => { throw new Error('new row for relation "payment_requests" violates check constraint "payment_requests_status_valid"'); };
  const late = await postCardRefund({ prisma: db, providerRef: '3051111585', reason: 'stolen card', deps: alerts().deps });
  assert.equal(late.refused, 'NEEDS_MIGRATION');
  assert.deepEqual(db.t, before, 'the reversal rolled back with the mark');
  db.paymentRequest.updateMany = update;
  const migration = read('../packages/domain/prisma/migrations/20261109_payment_request_refunded/migration.sql');
  assert.match(migration, /DROP CONSTRAINT IF EXISTS "payment_requests_status_valid"/);
  assert.match(migration, /CHECK \("status" IN \('PENDING', 'PAID', 'CANCELLED', 'EXPIRED', 'REFUNDED'\)\)/);
});

test('operator free text keeps no number whole: the entry, the audit row and the alert', async () => {
  const db = await seed1332();
  const { sent, deps } = alerts();
  const out = await postCardRefund({ prisma: db, providerRef: '3051111585', reason: 'payer 082 123 4567 says stolen, ref 27821234567', by: 'founder 0821234567', deps });
  assert.equal(out.ok, true);
  const stored = JSON.stringify({ entries: db.t.journalEntry, audit: db.t.auditLog, intents: db.t.providerRequest.map((r) => r.metadata?.refund || null), alert: sent.map((s) => s.text) });
  assert.ok(!/082 123 4567|27821234567|0821234567/.test(stored), 'no whole number anywhere');
  assert.match(sent[0].text, /payer •••4567 says stolen, ref •••4567\. By founder •••4567\./);
  assert.equal(maskDigits('R3000 on 7 Nov'), 'R3000 on 7 Nov', 'amounts and dates stay readable');
});

test('the card loads now carry the charge that credited them; the readers the review found treat REFUNDED as refunded', () => {
  const itn = read('../pages/api/payfast/itn.js');
  assert.match(itn, /posted = await postEntry\(\{\s*\.\.\.buildLoad\(\{[\s\S]{0,260}\}\),[\s\S]{0,400}externalRef: params\.pf_payment_id \|\| null,\s*\}\);/);
  const settle = read('../lib/card-settlement.js');
  assert.match(settle, /postEntry\(\{ \.\.\.buildLoad\(\{[^}]*\}\), externalRef: providerRef \|\| null \}\)/);
  const processor = read('../pages/api/webhooks/message-processor-v2.js');
  assert.match(processor, /let intentRefunded = request\.status === 'REFUNDED';[\s\S]{0,400}intentRefunded = intentRefunded \|\| Boolean\(intent\?\.metadata\?\.refund\);[\s\S]{0,200}if \(intentRefunded\) \{/, 'a payer asking for a receipt is never told the money reached the requester');
  assert.ok(processor.indexOf('if (intentRefunded)') < processor.indexOf('a card payment WAS received on it'));
  assert.match(processor, /row\.status === 'REFUNDED' \? `It was paid by card and that payment was refunded to the card, so nobody can pay it\.`/);
  assert.match(processor, /row\.status === 'REFUNDED' \? 'its card payment was refunded to the card'/);
  assert.match(read('../lib/business.js'), /status === 'closed'\) where\.OR = \[\{ status: 'CANCELLED' \}, \{ status: 'EXPIRED' \}, \{ status: 'REFUNDED' \}/);
  assert.match(read('../pages/api/admin/metrics.js'), /const paidToday = all\.filter\(\(r\) => r\.status === 'PAID' && r\.paidAt/);
  const portal = read('../lib/app-portal.js');
  assert.ok(portal.indexOf("key.startsWith('card-refund-')") < portal.indexOf("return { ...base, kind: 'ADJUSTMENT'"), 'the reversal is named in the customer\'s activity, not "Balance correction"');
  assert.match(portal, /title: code \? `Link payment refunded/);
});

test('an Adumo link is found by its ADUMO payerRef and reverses into CLEARING:ADUMO', async () => {
  const db = await seed1332();
  await payLinkByCard(db, { code: 'PRADUMOX', ref: 'ab12cd34-0000-4000-8000-00000000abcd', rail: 'ADUMO' });
  const out = await postCardRefund({ prisma: db, providerRef: 'ADUMO:ab12cd34-0000-4000-8000-00000000abcd', reason: 'test refund', deps: alerts().deps });
  assert.equal(out.ok, true);
  assert.equal(out.rail, 'ADUMO');
  assert.equal(out.reversal.source, 'REVERSAL_LOAD_ADUMO');
  assert.equal(netOf(db, 'CLEARING:ADUMO'), 0);
  assert.equal(trialBalance(db), 0);
});

test('lookups: bad input, unknown and ambiguous references, a reference that contradicts the idemKey', async () => {
  const db = await seed1332();
  assert.equal((await planCardRefund({ prisma: db })).refused, 'NO_REFERENCE');
  assert.equal((await planCardRefund({ prisma: db, providerRef: 'x y' })).refused, 'BAD_REFERENCE');
  assert.equal((await planCardRefund({ prisma: db, idemKey: 'a b' })).refused, 'BAD_IDEMKEY');
  assert.equal((await planCardRefund({ prisma: db, providerRef: '1234567' })).refused, 'NOT_FOUND');
  assert.equal((await planCardRefund({ prisma: db, providerRef: '3051111585', idemKey: 'wapay-payreq-PRLINKBB' })).refused, 'REFERENCE_MISMATCH');
  db.t.providerRequest.push({ id: 'x1', route: 'deposit', idemKey: 'wapay-pfdep-dupaaa', providerRef: '777', metadata: {} }, { id: 'x2', route: 'deposit', idemKey: 'wapay-pfdep-dupbbb', providerRef: '777', metadata: {} });
  assert.equal((await planCardRefund({ prisma: db, providerRef: '777' })).refused, 'AMBIGUOUS');
  assert.equal((await postCardRefund({ prisma: db, providerRef: '3051111585', reason: '   ' })).refused, 'NO_REASON');
  assert.equal(normaliseProviderRef(' PayFast:3051111585 '), '3051111585');
  assert.deepEqual([400, 404, 422, 409, 409, 409].map(String), ['NO_REASON', 'NOT_FOUND', 'NOT_A_CARD_LOAD', 'SHORT', 'ALREADY_REVERSED', 'AMBIGUOUS'].map((r) => String(refusalStatus(r))));
  assert.deepEqual(summariseLoad([{ accountCode: 'CLEARING:PAYFAST', debitCents: 300000 }, { accountCode: `WALLET:${ACC}:SPEND`, creditCents: 287170 }, { accountCode: 'REVENUE:FEE:DEPOSIT', creditCents: 12830 }]), { chargedCents: 300000, walletCreditCents: 287170, feeRevenueCents: 12830 });
});

test('after a refund the link map, the customer\'s links, the agent and the watchlist stop counting it as paid', async () => {
  const { pinStatusOf } = await import('../lib/link-map.js');
  assert.equal(pinStatusOf({ status: 'REFUNDED' }), 'closed');
  const { linkView } = await import('../lib/app-portal.js');
  assert.equal(linkView({ id: 'PRLINKAA', status: 'REFUNDED', amountCents: 300000, createdAt: new Date(), expiresAt: new Date(Date.now() + 86400e3), payerRef: 'PAYFAST:3051111585' }).status, 'REFUNDED', 'never shown as open again');
  assert.match(read('../pages/app/links.js'), /REFUNDED: \['Refunded', 'grey'\]/);
  const pack = read('../lib/context-pack.js');
  assert.match(pack, /if \(s === 'REFUNDED'\) return 'REFUNDED';/, 'the agent reads a refunded link as refunded, not open');
  assert.match(pack, /status: refunded \? 'REFUNDED' : base\.status/, 'and a refunded card deposit as refunded');

  // Watchlist: a refunded payment to a frozen account is no longer money paid, but the payer stays on the list.
  const F = 'frozen-acc-0000000000001';
  const prisma = {
    account: { async findMany({ where }) { return where?.profile ? [{ id: F, waId: '27600001332', createdAt: new Date(), profile: { payouts: { frozen: true } } }] : (where?.id?.in || []).map((id) => ({ id, waId: '27600001332', profile: {} })); } },
    journalEntry: { async findMany() { return []; } },
    linkVisit: { async findMany() { return []; } },
    providerRequest: { async findMany({ where }) { return where.route === 'payrequest' ? [{ accountId: F, metadata: { payerMsisdn: '0600005055', amountCents: 287170, refund: { at: '2026-11-09T10:00:00Z' } } }, { accountId: F, metadata: { payerMsisdn: '0600005055', amountCents: 287170 } }] : []; } },
    auditLog: { async findMany() { return []; } },
    conversationTurn: { async findMany() { return []; } },
    wallet: { async findMany() { return []; } },
  };
  const w = await watchlist({ prisma });
  assert.deepEqual(w.payers, [{ number: '•••5055', paidAccounts: 1, paidFrozenAccounts: 1, refundedFrozenAccounts: 1, totalCents: 287170, isFrozenAccount: false }]);
  prisma.providerRequest.findMany = async ({ where }) => (where.route === 'payrequest' ? [{ accountId: F, metadata: { payerMsisdn: '0600005055', amountCents: 287170, refund: { at: 'x' } } }] : []);
  const all = await watchlist({ prisma });
  assert.deepEqual(all.payers, [{ number: '•••5055', paidAccounts: 0, paidFrozenAccounts: 0, refundedFrozenAccounts: 1, totalCents: 0, isFrozenAccount: false }], 'a payer whose every payment was refunded is still watched');
  // Metrics read status = 'PAID' and net REVERSAL_<X> against X; a REFUNDED link drops out of both by construction.
  const metrics = read('../pages/api/admin/metrics.js');
  assert.match(metrics, /WHERE status = 'PAID'/);
  assert.match(metrics, /startsWith\('REVERSAL_'\)/);
});

test('the route: internal key first, GET is the dry run, POST books; it calls no processor and messages no customer', async () => {
  const call = async ({ method = 'GET', headers = {}, query = {}, body = {} }) => {
    const res = { code: null, json: null, headers: {}, status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k] = v; }, json(j) { this.json = j; return this; } };
    await handler({ method, headers, query, body, url: '/api/internal/card-refund' }, res);
    return res;
  };
  assert.equal((await call({})).code, 401, 'no key, no answer');
  const key = { 'x-internal-api-key': process.env.WAPAY_INTERNAL_API_KEY };
  assert.equal((await call({ method: 'DELETE', headers: key })).code, 405);
  const dry = await call({ headers: key });
  assert.equal(dry.code, 400);
  assert.equal(dry.json.dryRun, true);
  assert.equal(dry.json.refused, 'NO_REFERENCE');
  const noReason = await call({ method: 'POST', headers: key, body: { providerRef: '3051111585' } });
  assert.equal(noReason.code, 400);
  assert.equal(noReason.json.refused, 'NO_REASON');

  const route = read('../pages/api/internal/card-refund.js');
  assert.ok(route.indexOf('requireInternalAuth(req, res)') < route.indexOf('planCardRefund('), 'the key before anything is read');
  const lib = read('../lib/card-refund.js');
  for (const forbidden of [/from '\.\/say\.js'/, /from '\.\/notify\.js'/, /@wapay\/whatsapp/, /request-notify/, /from '\.\/adumo\.js'/, /providers-payfast/, /payout-freeze/, /payout-approval/, /allowNegative: true/]) {
    assert.doesNotMatch(lib + route, forbidden, `no ${forbidden}`);
  }
  assert.match(lib, /opsPersonAlert/, 'the one outbound line is the masked ops alert');
  assert.equal(cardRefundAlertText({ plan: { rail: 'PAYFAST', accountId: ACC, phone: '•••1332', original: { providerRef: '3051111585' }, amounts: { chargedCents: 300000, walletDebitCents: 287170, feeReversedCents: 12830 }, paymentRequest: null }, reason: 'x', by: 'y' }).includes('27600001332'), false);
});
