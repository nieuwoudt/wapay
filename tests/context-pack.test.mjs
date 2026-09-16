/**
 * Context pack (v1.4 agent, "the moat"): the per-customer record read on
 * every turn. Locks: the source tables are read in ONE Promise.all batch,
 * every sub-query is best-effort, movements are normalised and sorted newest
 * first, the pending pay-out is surfaced with its held amount, nothing
 * unmasked or secret (no full msisdn, voucherPin never selected) reaches the
 * pack, the rendered record fits the prompt budget, and the founder's status
 * questions rank the right candidate first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadContextPack, renderCustomerRecord, statusCandidates, rankCandidates, formatRands,
  maskMsisdn, formatSast, RECORD_HEADER, RECORD_MAX_CHARS,
} from '../lib/context-pack.js';

const NOW = new Date('2026-09-16T07:30:00.000Z'); // 09:30 SAST
const ago = (ms) => new Date(NOW.getTime() - ms);
const H = 3600 * 1000;

const account = {
  id: 'acc-1', waId: '27787051175', msisdn: '0787051175', displayName: 'Nieuwoudt',
  profile: { language: 'af', kyc: { status: 'VERIFIED' } },
};

function fixtures() {
  return {
    wallet: [
      { balanceType: 'SPEND', availableCents: 10000, pendingCents: 0, updatedAt: NOW },
      { balanceType: 'CASH', availableCents: 2500, pendingCents: 5500, updatedAt: NOW },
    ],
    hold: [
      { id: 'h1', idemKey: 'payout-acc-1-intent-7000-hold', amountCents: 5500, reason: 'payout PAYSHAP WPABCDEFGHIJKLMN', createdAt: ago(11 * H), status: 'ACTIVE', wallet: { balanceType: 'CASH' } },
    ],
    providerRequest: [
      { id: 'pr-payout', provider: 'OTT', route: 'ott-payout', idemKey: 'payout-acc-1-intent-7000', status: 'PENDING', providerRef: null, requestTs: ago(11 * H),
        metadata: { method: 'PAYSHAP', amountCents: 5000, feeCents: 500, reference: 'WPABCDEFGHIJKLMN', recipient: { name: 'Nieuwoudt G', mobile: '•••175', account: '•••394' }, outcome: 'UNKNOWN', reconcileRequired: true, providerStatus: '7' } },
      { id: 'pr-dep', provider: 'PAYFAST', route: 'deposit', idemKey: 'dep-1', status: 'SUCCESS', providerRef: '2179045', requestTs: ago(20 * 24 * H),
        metadata: { accountId: 'acc-1', waId: '27787051175', amountCents: 2000, feeCents: 300, grossCents: 2300 } },
      { id: 'pr-dep-pending', provider: 'PAYFAST', route: 'deposit', idemKey: 'dep-2', status: 'PENDING', providerRef: null, requestTs: ago(2 * H),
        metadata: { accountId: 'acc-1', amountCents: 10000, feeCents: 400, grossCents: 10400 } },
      { id: 'prev-air', provider: 'BLU', route: 'airtime-preview', idemKey: 'prev-air', status: 'SUCCESS', providerRef: 'BLU-77', requestTs: ago(30 * H),
        metadata: { msisdn: '0834561234', amountCents: 1000, totalCents: 1150, vendorId: 1, vendorName: 'Vodacom', expiresAt: ago(29 * H).toISOString() } },
      { id: 'prev-air-quote', provider: 'BLU', route: 'airtime-preview', idemKey: 'prev-air-quote', status: 'PENDING', providerRef: null, requestTs: ago(40 * H),
        metadata: { msisdn: '0834561234', amountCents: 500, totalCents: 650, expiresAt: ago(39 * H).toISOString() } },
      { id: 'prev-data', provider: 'BLU', route: 'data-preview', idemKey: 'prev-data', status: 'FAILED', providerRef: null, requestTs: ago(3 * 24 * H),
        metadata: { msisdn: '0787051175', productId: 'p1', productName: 'MTN 1GB', priceCents: 8500, totalCents: 8650 } },
      { id: 'prev-elec', provider: 'BLU', route: 'electricity-preview', idemKey: 'prev-elec', status: 'SUCCESS', providerRef: 'ELEC-9', requestTs: ago(5 * 24 * H),
        metadata: { meterNumber: '01234567890', amountCents: 20000, serviceFee: 300, totalCents: 20300, municipalityName: 'City of Cape Town' } },
      { id: 'prev-fuel', provider: 'YOYO', route: 'fuel-preview', idemKey: 'prev-fuel', status: 'RECONCILE', providerRef: 'FUEL-1', requestTs: ago(6 * H),
        metadata: { amountCents: 30000, feeCents: 800, totalCents: 30800 } },
      { id: 'prev-vgift', provider: 'OTT', route: 'voucher-preview', idemKey: 'prev-vgift', status: 'SUCCESS', providerRef: '998877', requestTs: ago(5 * H),
        metadata: { amountCents: 5000, feeCents: 400, totalCents: 5400, recipientMsisdn: '0798743910' } },
      { id: 'redeem-1', provider: 'OTT', route: 'ott-redeem', idemKey: 'redeem-1', status: 'SUCCESS', providerRef: 'V123', requestTs: ago(7 * 24 * H),
        metadata: { valueCents: 10000, serial: '1122334455' } },
      { id: 'pfreq-PR7K', provider: 'PAYFAST', route: 'payrequest', idemKey: 'wapay-payreq-PR7K2FQ4', status: 'SUCCESS', providerRef: 'pf-1', requestTs: ago(4 * H),
        metadata: { amountCents: 14500, feeCents: 500, grossCents: 15000, requestCode: 'PR7K2FQ4' } },
    ],
    pendingGift: [
      // The voucher send above (merged into prev-vgift, never a second SEND).
      { id: 'g-sent', senderAccountId: 'acc-1', recipientMsisdn: '0798743910', amountCents: 5000, rail: 'OTT', status: 'ISSUED', voucherSerial: '5566778899', idemKey: 'wapay-vgift-gift-prev-vgift', createdAt: ago(5 * H), deliveredAt: null, voucherPin: 'SECRET-PIN-0000' },
      // The fuel wiCode to self (covered by the FUEL row).
      { id: 'g-fuel', senderAccountId: 'acc-1', recipientMsisdn: '0787051175', amountCents: 30000, rail: 'YOYO', status: 'ISSUED', voucherSerial: '42', idemKey: 'wapay-fuel-gift-prev-fuel', createdAt: ago(6 * H), deliveredAt: null, voucherPin: 'SECRET-PIN-1111' },
      // A gift received from someone else, waiting to be claimed.
      { id: 'g-recv', senderAccountId: 'acc-9', recipientMsisdn: '0787051175', amountCents: 2500, rail: 'OTT', status: 'ISSUED', voucherSerial: '9988776655', idemKey: 'wapay-vgift-gift-other', createdAt: ago(1 * H), deliveredAt: null, voucherPin: 'SECRET-PIN-2222' },
    ],
    paymentRequest: [
      { id: 'PR7K2FQ4', amountCents: 15000, note: 'Lunch', status: 'PAID', payerRef: 'PAYFAST:2179099', createdAt: ago(9 * H), paidAt: ago(4 * H), expiresAt: new Date(NOW.getTime() + 6 * 24 * H) },
      { id: 'PRZZZ111', amountCents: 8000, note: null, status: 'PENDING', payerRef: null, createdAt: ago(1.5 * H), paidAt: null, expiresAt: new Date(NOW.getTime() + 7 * 24 * H) },
      { id: 'PROLD222', amountCents: 3000, note: 'old', status: 'PENDING', payerRef: null, createdAt: ago(10 * 24 * H), paidAt: null, expiresAt: ago(3 * 24 * H) },
    ],
    beneficiary: [
      { name: 'Philly', msisdn: '0798743910', lastUsedAt: ago(5 * H) },
      { name: null, msisdn: '0834561234', lastUsedAt: ago(30 * H) },
      { name: 'Mom', msisdn: '0821112222', lastUsedAt: ago(90 * 24 * H) },
    ],
  };
}

/**
 * Stub prisma: every findMany records `start:<table>`, waits a tick, then
 * records `end:<table>` and resolves the fixture. A table listed in `fail`
 * rejects instead. `args` keeps each call's argument for select inspection.
 */
function stubPrisma(fx = fixtures(), { fail = [] } = {}) {
  const calls = []; const args = {};
  const model = (name) => ({
    async findMany(a) {
      calls.push(`start:${name}`); args[name] = a;
      await new Promise((r) => setTimeout(r, 2));
      calls.push(`end:${name}`);
      if (fail.includes(name)) throw new Error(`${name} exploded`);
      return (fx[name] || []).map((r) => ({ ...r }));
    },
  });
  return {
    calls, args,
    wallet: model('wallet'), hold: model('hold'),
    providerRequest: { ...model('providerRequest'), async findFirst(a) {
      // The dedicated pending pay-out lookup (2026-09-16): newest PENDING/INIT pay-out row.
      args.pendingPayout = a;
      const rows = fx.providerRequest.filter((r) => r.route === 'ott-payout' && ['PENDING', 'INIT'].includes(r.status)).sort((x, y) => y.requestTs - x.requestTs);
      return rows[0] ? { ...rows[0] } : null;
    } },
    pendingGift: { async findMany(a) {
      const which = a?.where?.senderAccountId ? 'giftsSent' : 'giftsReceived';
      calls.push(`start:${which}`); args[which] = a;
      await new Promise((r) => setTimeout(r, 2));
      calls.push(`end:${which}`);
      if (fail.includes(which)) throw new Error(`${which} exploded`);
      const rows = a?.where?.senderAccountId
        ? fx.pendingGift.filter((g) => g.senderAccountId === a.where.senderAccountId)
        : fx.pendingGift.filter((g) => (a.where.recipientMsisdn.in || []).includes(g.recipientMsisdn) || (a.where.recipientMsisdn.endsWith && g.recipientMsisdn.endsWith(a.where.recipientMsisdn.endsWith)));
      // Honour the select the way Prisma would: only selected columns come back.
      return rows.map((g) => Object.fromEntries(Object.entries(g).filter(([k]) => a.select?.[k])));
    } },
    paymentRequest: model('paymentRequest'), beneficiary: model('beneficiary'),
  };
}

test('all seven source queries start before any resolves: one Promise.all batch', async () => {
  const prisma = stubPrisma();
  await loadContextPack({ prisma, account, now: NOW });
  const starts = prisma.calls.filter((c) => c.startsWith('start:'));
  const firstEnd = prisma.calls.findIndex((c) => c.startsWith('end:'));
  assert.equal(starts.length, 7, prisma.calls.join(','));
  assert.equal(firstEnd, 7, `every query must be started before the first one resolves: ${prisma.calls.join(',')}`);
  assert.deepEqual(new Set(starts), new Set(['start:wallet', 'start:hold', 'start:providerRequest', 'start:giftsSent', 'start:giftsReceived', 'start:paymentRequest', 'start:beneficiary']));
});

test('a failed sub-query yields an empty part and a warning, never a throw', async () => {
  const prisma = stubPrisma(fixtures(), { fail: ['hold', 'beneficiary', 'giftsReceived'] });
  const pack = await loadContextPack({ prisma, account, now: NOW });
  assert.equal(pack.warnings.length, 3, pack.warnings.join(' | '));
  assert.match(pack.warnings.join(' '), /hold exploded/);
  assert.deepEqual(pack.beneficiaries, []);
  assert.equal(pack.vouchersWaiting, 0);
  assert.equal(pack.balances.spendCents, 10000, 'the wallets still landed');
  assert.ok(pack.pendingPayout, 'the pay-out is still surfaced without the hold row');
  assert.equal(pack.pendingPayout.holdFound, false);
  assert.equal(pack.pendingPayout.heldCents, 5500, 'amount plus fee is the fallback for the held amount');
  // A prisma that throws synchronously is handled the same way.
  const broken = { ...stubPrisma(), wallet: { findMany() { throw new Error('sync boom'); } } };
  const p2 = await loadContextPack({ prisma: broken, account, now: NOW });
  assert.match(p2.warnings.join(' '), /wallets: sync boom/);
  assert.equal(p2.balances.spendCents, 0);
});

test('identity, balances and held amounts come from the ledger rows', async () => {
  const pack = await loadContextPack({ prisma: stubPrisma(), account, now: NOW });
  assert.equal(pack.accountId, 'acc-1'); assert.equal(pack.waId, '27787051175'); assert.equal(pack.msisdn, '0787051175');
  assert.equal(pack.displayName, 'Nieuwoudt'); assert.equal(pack.language, 'af'); assert.equal(pack.kyc, 'VERIFIED');
  assert.deepEqual(pack.balances, { spendCents: 10000, cashCents: 2500, heldSpendCents: 0, heldCashCents: 5500 });
  assert.deepEqual(pack.turns, []);
  for (const v of Object.values(pack.balances)) assert.ok(Number.isInteger(v));
});

test('movements: every kind normalised, unexecuted quotes and duplicate rails dropped, newest first', async () => {
  const pack = await loadContextPack({ prisma: stubPrisma(), account, now: NOW, movementLimit: 50 });
  const kinds = pack.movements.map((m) => m.kind);
  // Sorted newest first.
  for (let i = 1; i < pack.movements.length; i += 1) assert.ok(pack.movements[i - 1].at >= pack.movements[i].at, 'newest first');
  // One of each expected kind; no PAY_LINK duplicate from the 'payrequest' provider row; no SEND duplicate from the gift row; no FUEL duplicate from the wiCode gift.
  assert.equal(kinds.filter((k) => k === 'SEND').length, 1);
  assert.equal(kinds.filter((k) => k === 'FUEL').length, 1);
  assert.equal(kinds.filter((k) => k === 'PAY_LINK').length, 3);
  assert.equal(kinds.filter((k) => k === 'AIRTIME').length, 1, 'the PENDING airtime quote is not a movement');
  assert.equal(kinds.filter((k) => k === 'GIFT_RECEIVED').length, 1);
  assert.equal(kinds.filter((k) => k === 'DEPOSIT').length, 2);
  for (const mv of pack.movements) {
    assert.ok(['DEPOSIT', 'PAYOUT', 'AIRTIME', 'DATA', 'ELECTRICITY', 'FUEL', 'SEND', 'GIFT_RECEIVED', 'PAY_LINK', 'VOUCHER_LOAD'].includes(mv.kind), mv.kind);
    assert.ok(['SUCCESS', 'PENDING', 'FAILED', 'OPEN', 'EXPIRED', 'CANCELLED'].includes(mv.status), `${mv.kind} ${mv.status}`);
    assert.ok(Number.isInteger(mv.amountCents) && Number.isInteger(mv.feeCents), 'integer cents');
    assert.ok(mv.at instanceof Date); assert.ok(mv.source.table && mv.source.id); assert.equal(typeof mv.note, 'string');
  }
  const by = (id) => pack.movements.find((m) => m.source.id === id);
  assert.deepEqual({ ...by('pr-payout'), at: undefined, method: undefined, reconcileRequired: undefined, providerStatus: undefined },
    { kind: 'PAYOUT', amountCents: 5000, feeCents: 500, status: 'PENDING', counterparty: 'Nieuwoudt G acc •••394', reference: 'WPABCDEFGHIJKLMN', at: undefined, source: { table: 'providerRequest', id: 'pr-payout' }, note: 'PayShap pay-out, waiting on the bank rail (being checked)', method: undefined, reconcileRequired: undefined, providerStatus: undefined });
  assert.equal(by('pr-dep').status, 'SUCCESS'); assert.equal(by('pr-dep').amountCents, 2000); assert.equal(by('pr-dep').feeCents, 300); assert.equal(by('pr-dep').reference, '2179045');
  assert.equal(by('pr-dep-pending').status, 'PENDING');
  assert.equal(by('prev-air').counterparty, '083…1234'); assert.equal(by('prev-air').feeCents, 150); assert.equal(by('prev-air').note, 'Vodacom airtime');
  assert.equal(by('prev-data').status, 'FAILED'); assert.equal(by('prev-data').counterparty, 'own number'); assert.equal(by('prev-data').amountCents, 8500);
  assert.equal(by('prev-elec').kind, 'ELECTRICITY'); assert.equal(by('prev-elec').counterparty, 'meter …7890'); assert.equal(by('prev-elec').feeCents, 300);
  assert.equal(by('prev-fuel').status, 'PENDING', 'RECONCILE reads as pending');
  assert.equal(by('prev-vgift').kind, 'SEND'); assert.equal(by('prev-vgift').counterparty, '079…3910'); assert.equal(by('prev-vgift').reference, '…8899'); assert.equal(by('prev-vgift').note, 'voucher sent, not yet claimed');
  assert.equal(by('redeem-1').kind, 'VOUCHER_LOAD'); assert.equal(by('redeem-1').amountCents, 10000); assert.equal(by('redeem-1').reference, '…4455');
  assert.equal(by('g-recv').kind, 'GIFT_RECEIVED'); assert.equal(by('g-recv').status, 'PENDING');
  assert.equal(by('PR7K2FQ4').status, 'SUCCESS'); assert.equal(by('PR7K2FQ4').counterparty, 'card …9099'); assert.equal(by('PR7K2FQ4').reference, 'PR7K2FQ4');
  assert.equal(by('PRZZZ111').status, 'OPEN');
  assert.equal(by('PROLD222').status, 'EXPIRED', 'a PENDING link past expiresAt is EXPIRED');
  assert.ok(by('g-sent') == null, 'the gift row behind a voucher-preview SUCCESS is merged, not repeated');
  assert.ok(by('g-fuel') == null, 'the fuel wiCode gift is the FUEL row, not a SEND or a GIFT_RECEIVED');
  assert.equal(pack.movementsTotal, pack.movements.length);
});

test('movementLimit caps the list but the pending pay-out, open links and waiting vouchers are found over everything', async () => {
  const pack = await loadContextPack({ prisma: stubPrisma(), account, now: NOW, movementLimit: 3 });
  assert.equal(pack.movements.length, 3);
  assert.ok(pack.movementsTotal > 3);
  assert.equal(pack.pendingPayout.reference, 'WPABCDEFGHIJKLMN');
  assert.equal(pack.pendingPayout.heldCents, 5500, 'the ACTIVE hold amount (amount + fee) rides along');
  assert.equal(pack.pendingPayout.holdFound, true);
  assert.equal(pack.pendingPayout.method, 'PAYSHAP'); assert.equal(pack.pendingPayout.amountCents, 5000); assert.equal(pack.pendingPayout.feeCents, 500);
  assert.equal(pack.pendingPayout.reconcileRequired, true); assert.equal(pack.pendingPayout.providerStatus, '7');
  assert.deepEqual(pack.openPayLinks.map((l) => l.code), ['PRZZZ111'], 'PAID and expired links are not open');
  assert.equal(pack.vouchersWaiting, 1);
  assert.deepEqual(pack.beneficiaries, [{ name: 'Philly', msisdnTail: '3910' }, { name: null, msisdnTail: '1234' }, { name: 'Mom', msisdnTail: '2222' }]);
});

test('INIT pay-outs count as pending; a settled one leaves pendingPayout null', async () => {
  const fx = fixtures();
  fx.providerRequest[0] = { ...fx.providerRequest[0], status: 'INIT' };
  let pack = await loadContextPack({ prisma: stubPrisma(fx), account, now: NOW });
  assert.equal(pack.pendingPayout?.reference, 'WPABCDEFGHIJKLMN');
  fx.providerRequest[0] = { ...fx.providerRequest[0], status: 'SUCCESS' };
  fx.hold = [];
  pack = await loadContextPack({ prisma: stubPrisma(fx), account, now: NOW });
  assert.equal(pack.pendingPayout, null);
  assert.equal(pack.movements.find((m) => m.kind === 'PAYOUT').status, 'SUCCESS');
});

test('masking: no full msisdn in any movement and voucherPin is never selected', async () => {
  const prisma = stubPrisma();
  const pack = await loadContextPack({ prisma, account, now: NOW, movementLimit: 50 });
  assert.equal(prisma.args.giftsSent.select.voucherPin, undefined);
  assert.equal(prisma.args.giftsReceived.select.voucherPin, undefined);
  assert.ok(!('voucherPin' in prisma.args.giftsSent.select) && !('voucherPin' in prisma.args.giftsReceived.select));
  assert.deepEqual(prisma.args.giftsReceived.where, { recipientMsisdn: { in: ['0787051175', '27787051175', '+27787051175'] } }, 'received gifts are matched on the exact stored shapes (indexed), never a suffix scan');
  assert.deepEqual(prisma.args.giftsSent.where, { senderAccountId: 'acc-1' });
  assert.deepEqual(prisma.args.hold.where, { wallet: { accountId: 'acc-1' }, status: 'ACTIVE' });
  const blob = JSON.stringify({ ...pack, msisdn: undefined, waId: undefined });
  assert.ok(!/\b0\d{9}\b/.test(blob), `a full local msisdn leaked: ${blob}`);
  assert.ok(!/\b27\d{9}\b/.test(blob), 'a full international msisdn leaked');
  assert.ok(!blob.includes('SECRET-PIN'), 'a voucher PIN leaked');
  assert.ok(!blob.includes('01234567890'), 'a full meter number leaked');
  const text = renderCustomerRecord(pack, { now: NOW });
  assert.ok(!/\b0\d{9}\b/.test(text) && !text.includes('SECRET-PIN'));
});

test('renderCustomerRecord: header line, SAST dates, balances, pending pay-out, links, vouchers, names only; under the budget', async () => {
  const pack = await loadContextPack({ prisma: stubPrisma(), account, now: NOW, movementLimit: 10 });
  const text = renderCustomerRecord(pack, { now: NOW });
  const lines = text.split('\n');
  assert.equal(lines[0], RECORD_HEADER);
  assert.equal(lines[0], 'KNOWN CUSTOMER FACTS (from the ledger, this turn; quote these numbers, never others):');
  assert.ok(text.length <= RECORD_MAX_CHARS, `record is ${text.length} chars`);
  assert.match(text, /Name: Nieuwoudt \(078…1175\)\. Language: af\. KYC: VERIFIED\./);
  assert.match(text, /Balance to spend: R100; cash balance \(withdrawals only\): R25; R55 held for pending transactions\./);
  assert.match(text, /PENDING PAY-OUT: R50 by PayShap to Nieuwoudt G acc •••394, ref WPABCDEFGHIJKLMN, started 15 Sep 22:30, R55 \(amount plus fee\) is held/);
  assert.match(text, /^- 16 Sep 08:30 GIFT_RECEIVED R25 PENDING ref …6655$/m, 'movement line shape: date time kind amount status counterparty ref');
  assert.match(text, /^- 16 Sep 07:30 DEPOSIT R100 PENDING PayFast$/m);
  assert.match(text, /^- 16 Sep 05:30 PAY_LINK R150 SUCCESS card …9099 ref PR7K2FQ4$/m);
  assert.match(text, /^- 15 Sep 22:30 PAYOUT R50 PENDING Nieuwoudt G acc •••394 ref WPABCDEFGHIJKLMN$/m);
  assert.match(text, /Open pay links: PRZZZ111 R80 \(expires 23 Sep 09:30\)\./);
  assert.match(text, /Vouchers waiting to be claimed: 1\./);
  assert.match(text, /Saved people: Philly, Mom\./, 'names only, never numbers');
  const people = lines.find((l) => l.startsWith('Saved people:'));
  assert.ok(!/\d/.test(people), `saved people carry no number: ${people}`);
  assert.ok(!text.includes('—'), 'no em dashes');
  assert.match(text, /- \(\d+ older not shown\)/, 'the cap is stated');
});

test('renderCustomerRecord truncates the movement list to stay under 1,800 characters', () => {
  const movements = Array.from({ length: 60 }, (_, i) => ({
    kind: 'AIRTIME', amountCents: 1000 + i, feeCents: 0, status: 'SUCCESS', counterparty: '083…1234', reference: `BLU-${1000 + i}`,
    at: ago(i * H), source: { table: 'providerRequest', id: `x${i}` }, note: 'airtime',
  }));
  const pack = {
    displayName: 'A very long display name indeed', msisdn: '0787051175', language: 'en', kyc: 'NOT_VERIFIED',
    balances: { spendCents: 1, cashCents: 0, heldSpendCents: 0, heldCashCents: 0 },
    movements, movementsTotal: 90, pendingPayout: null, openPayLinks: [], vouchersWaiting: 0, beneficiaries: [{ name: 'X' }], warnings: [],
  };
  const text = renderCustomerRecord(pack, { now: NOW });
  assert.ok(text.length <= RECORD_MAX_CHARS, `${text.length}`);
  assert.ok(text.startsWith(RECORD_HEADER));
  assert.match(text, /Saved people: X\.$/, 'the footer always survives; only movements are cut');
  const shown = (text.match(/^- \d\d \w{3} /gm) || []).length;
  assert.ok(shown > 5 && shown < 60, `${shown} shown`);
  assert.match(text, new RegExp(`- \\(${90 - shown} older not shown\\)`));
  const empty = renderCustomerRecord({ ...pack, movements: [], movementsTotal: 0, beneficiaries: [] }, { now: NOW });
  assert.match(empty, /Recent activity: none yet\./); assert.match(empty, /Pending pay-out: none\./); assert.match(empty, /Saved people: none\./);
});

test('statusCandidates: money-in/out kinds inside the window, newest first', async () => {
  const pack = await loadContextPack({ prisma: stubPrisma(), account, now: NOW, movementLimit: 50 });
  const c = statusCandidates(pack, { now: NOW });
  assert.deepEqual(c.map((m) => m.source.id), ['PRZZZ111', 'pr-dep-pending', 'PR7K2FQ4', 'prev-vgift', 'pr-payout'], 'AIRTIME/FUEL/GIFT_RECEIVED are not payment-status candidates; the 20-day-old deposit is outside the window');
  const wide = statusCandidates(pack, { now: NOW, withinMs: 30 * 24 * H });
  assert.ok(wide.map((m) => m.source.id).includes('pr-dep'));
  assert.ok(wide.map((m) => m.source.id).includes('redeem-1'));
  assert.deepEqual(statusCandidates({ movements: [] }, { now: NOW }), []);
  assert.deepEqual(statusCandidates(null), []);
});

test('rankCandidates: the founder\'s sentences put the right kind first; stable otherwise', async () => {
  const pack = await loadContextPack({ prisma: stubPrisma(), account, now: NOW, movementLimit: 50 });
  const c = statusCandidates(pack, { now: NOW });
  // "Did my payment to tbh go through": no rail word, order untouched (newest first).
  assert.deepEqual(rankCandidates(c, 'Did my payment to tbh go through').map((m) => m.source.id), c.map((m) => m.source.id));
  // "No my payment to my fnb account I did last night?": the PayShap pay-out first.
  const fnb = rankCandidates(c, 'No my payment to my fnb account I did last night?');
  assert.equal(fnb[0].kind, 'PAYOUT'); assert.equal(fnb[0].reference, 'WPABCDEFGHIJKLMN');
  assert.deepEqual(fnb.slice(1).map((m) => m.source.id), c.filter((m) => m.kind !== 'PAYOUT').map((m) => m.source.id), 'the rest keep their order');
  assert.equal(rankCandidates(c, 'did my payshap withdrawal go through')[0].kind, 'PAYOUT');
  assert.equal(rankCandidates(c, 'did my card deposit go through')[0].kind, 'DEPOSIT');
  assert.equal(rankCandidates(c, 'has my top up loaded')[0].kind, 'DEPOSIT');
  assert.equal(rankCandidates(c, 'has anyone paid me on my link')[0].kind, 'PAY_LINK');
  assert.equal(rankCandidates(c, 'did the voucher I sent go through')[0].kind, 'SEND');
  assert.equal(rankCandidates(c, 'did the money I sent go through')[0].kind, 'SEND');
  assert.equal(rankCandidates(c, 'did the money I sent to my absa go through')[0].kind, 'PAYOUT', 'a bank name outranks the generic send word');
  assert.deepEqual(rankCandidates([], 'fnb'), []);
  assert.deepEqual(rankCandidates(null, 'fnb'), []);
  assert.notEqual(rankCandidates(c, ''), c, 'always a copy, never the caller\'s array');
});

test('formatRands, maskMsisdn and formatSast', () => {
  assert.equal(formatRands(1250), 'R12.50'); assert.equal(formatRands(1200), 'R12'); assert.equal(formatRands(5), 'R0.05');
  assert.equal(formatRands(0), 'R0'); assert.equal(formatRands(-1250), '-R12.50'); assert.equal(formatRands(null), 'R0'); assert.equal(formatRands('abc'), 'R0');
  assert.equal(formatRands(1249.6), 'R12.50', 'rounded to integer cents, never a float in the copy');
  assert.equal(maskMsisdn('0834564421'), '083…4421'); assert.equal(maskMsisdn('27834564421'), '083…4421'); assert.equal(maskMsisdn('+27 83 456 4421'), '083…4421');
  assert.equal(maskMsisdn(''), ''); assert.equal(maskMsisdn('12'), '');
  assert.equal(formatSast(new Date('2026-09-15T20:04:00.000Z'), NOW), '15 Sep 22:04');
  assert.equal(formatSast(new Date('2025-12-31T22:30:00.000Z'), NOW), '01 Jan 00:30', 'year shown only when it differs');
  assert.equal(formatSast(new Date('2025-06-01T10:00:00.000Z'), NOW), '01 Jun 2025 12:00');
  assert.equal(formatSast(null, NOW), ''); assert.equal(formatSast('garbage', NOW), '');
});
