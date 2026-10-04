/**
 * The WaPay Money Map can never drift from what production charges.
 *
 * docs/commercials/rows.json (the dashboard's data), docs/commercials/model.js
 * (the fee arithmetic the page runs in the browser) and
 * docs/commercials/code-facts.json (the committed snapshot) must all equal
 * lib/ledger-core.js and lib/deposits.js at the five reference amounts and
 * across every amount the product accepts. A fee change in code without
 * `node docs/commercials/sync-from-code.mjs` + `node docs/commercials/assemble.mjs`
 * fails here, on purpose.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

for (const k of ['WAPAY_DEPOSIT_FEE_BPS', 'WAPAY_DEPOSIT_FEE_FIXED_CENTS', 'WAPAY_ADUMO_FEE_BPS', 'WAPAY_ADUMO_FEE_FIXED_CENTS', 'WAPAY_PAYREQ_FREE_BELOW_CENTS', 'WAPAY_VAT_REGISTERED']) delete process.env[k];

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dir = path.join(root, 'docs', 'commercials');
const require = createRequire(import.meta.url);
const MoneyMap = require(path.join(dir, 'model.js'));
const { FEES, VAT_BPS, cashoutFeeCents, cashoutRailCostCents, cashoutMarginCents, bps, inclVatCents } = await import('../lib/ledger-core.js');
const { depositFeeCents, paymentRequestFeeCents, cardRailFee, PAYREQ_FREE_BELOW_CENTS, MIN_DEPOSIT_CENTS, MAX_DEPOSIT_CENTS } = await import('../lib/deposits.js');
const { MIN_PAYOUT_CENTS, MAX_PAYOUT_CENTS, PAYOUT_METHODS } = await import('../lib/payouts.js');
const { snapshotFromCode, gridFromModel } = await import('../docs/commercials/sync-from-code.mjs');

const rowsDoc = JSON.parse(readFileSync(path.join(dir, 'rows.json'), 'utf8'));
const facts = JSON.parse(readFileSync(path.join(dir, 'code-facts.json'), 'utf8'));
const AMOUNTS = rowsDoc.referenceAmountsCents;
const STATUSES = ['SIGNED', 'LIVE', 'ASSUMED', 'PROPOSED', 'UNKNOWN'];
const rowById = Object.fromEntries(rowsDoc.rows.map((r) => [r.id, r]));

test('the reference amounts are the five the founder asked for', () => {
  assert.deepEqual(AMOUNTS, [5000, 20000, 50000, 100000, 300000]);
});

test('model.js mirrors depositFeeCents at every deposit amount', () => {
  for (let a = MIN_DEPOSIT_CENTS; a <= MAX_DEPOSIT_CENTS; a += 100) {
    assert.equal(MoneyMap.depositFeeCents(a), depositFeeCents(a), `deposit fee at ${a}`);
  }
  for (const a of [1001, 1999, 4999, 5001, 12345, 299999]) assert.equal(MoneyMap.depositFeeCents(a), depositFeeCents(a));
});

test('model.js mirrors paymentRequestFeeCents on both rails, every rand R5..R3000 and the taper cents', () => {
  for (const rail of ['PAYFAST', 'ADUMO']) {
    for (let a = 500; a <= 300000; a += 100) assert.equal(MoneyMap.paymentRequestFeeCents(a, rail), paymentRequestFeeCents(a, rail), `${rail} ${a}`);
    for (let a = 4900; a <= 6000; a += 1) assert.equal(MoneyMap.paymentRequestFeeCents(a, rail), paymentRequestFeeCents(a, rail), `${rail} taper ${a}`);
  }
  assert.equal(MoneyMap.PAYREQ_FREE_BELOW_CENTS, PAYREQ_FREE_BELOW_CENTS);
  assert.deepEqual(MoneyMap.CARD_RAIL.PAYFAST, cardRailFee('PAYFAST'));
  assert.deepEqual(MoneyMap.CARD_RAIL.ADUMO, cardRailFee('ADUMO'));
});

test('model.js mirrors the cash-out fee, rail cost and margin for every method and amount', () => {
  assert.equal(MoneyMap.VAT_BPS, VAT_BPS);
  for (const [method, cfg] of Object.entries(FEES.cashout)) {
    const bands = cfg.bands.map(([max, fee]) => [Number.isFinite(max) ? max : null, fee]);
    const cost = { fixedCents: cfg.railCostExVatCents, bps: cfg.switchingBps || 0, exVat: true };
    for (let a = 1000; a <= MAX_PAYOUT_CENTS; a += 100) {
      assert.equal(MoneyMap.bandFeeCents(bands, a), cashoutFeeCents(method, a), `${method} fee ${a}`);
      assert.equal(MoneyMap.cashoutRailCostCents(cost, a), cashoutRailCostCents(method, a), `${method} cost ${a}`);
      assert.equal(MoneyMap.bandFeeCents(bands, a) - MoneyMap.cashoutRailCostCents(cost, a), cashoutMarginCents(method, a), `${method} margin ${a}`);
    }
  }
  assert.equal(MoneyMap.inclVatCents(996), inclVatCents(996));
  assert.equal(MoneyMap.bps(12345, 600), bps(12345, 600));
});

test('rows.json carries the same parameters as FEES and the deposit module', () => {
  // Cash-out rows: bands and rail costs per method.
  for (const row of rowsDoc.rows.filter((r) => r.codeRef?.fn === 'cashout')) {
    const cfg = FEES.cashout[row.codeRef.method];
    assert.ok(cfg, `${row.id}: method ${row.codeRef.method} exists in FEES.cashout`);
    assert.deepEqual(row.price.bands, cfg.bands.map(([max, fee]) => [Number.isFinite(max) ? max : null, fee]), `${row.id} bands`);
    assert.equal(row.cost.fixedCents, cfg.railCostExVatCents, `${row.id} rail cost ex VAT`);
    assert.equal(row.cost.bps || 0, cfg.switchingBps || 0, `${row.id} switching bps`);
    assert.equal(row.cost.exVat, true, `${row.id} rail cost is quoted ex VAT`);
    assert.ok(PAYOUT_METHODS[row.codeRef.method] || row.codeRef.method === 'PAYAT', `${row.id}: a pay-out method the service knows, or Pay@`);
  }
  // Voucher loads: the discount the ledger applies.
  for (const row of rowsDoc.rows.filter((r) => r.codeRef?.fn === 'loadDiscount')) {
    const cfg = FEES.load[row.codeRef.rail];
    assert.ok(cfg, `${row.id}: rail in FEES.load`);
    assert.equal(cfg.creditPolicy, 'NET', `${row.id}: voucher loads credit NET`);
    assert.equal(row.price.discountBps, cfg.discountBps, `${row.id} discount bps`);
  }
  // Card rails: FACE credit, the fee booked separately.
  assert.equal(FEES.load.PAYFAST.creditPolicy, 'FACE');
  assert.equal(FEES.load.ADUMO.creditPolicy, 'FACE');
  // Commissions per category.
  for (const row of rowsDoc.rows.filter((r) => r.codeRef?.fn === 'commission')) {
    const b = FEES.commissionBps[row.codeRef.category];
    assert.ok(b !== undefined, `${row.id}: category ${row.codeRef.category} in FEES.commissionBps`);
    assert.equal(row.commission.bookedBps, b, `${row.id} booked bps equals the ledger`);
  }
  // The voucher gift: R3 flat, 0 bps booked, contract 4%.
  for (const row of rowsDoc.rows.filter((r) => r.codeRef?.fn === 'voucherGift')) {
    assert.equal(row.commission.bookedBps, FEES.voucherGift.commissionBps, `${row.id} booked commission`);
    if (row.price.kind === 'flat') assert.equal(row.price.flatCents, FEES.voucherGift.flatFeeCents, `${row.id} gift fee`);
  }
  // Sends.
  assert.equal(FEES.send.freeForSpendBalance, true);
  assert.equal(rowById['send.cash_balance'].price.flatCents, FEES.send.flatCents);
  assert.equal(rowById['send.wapay_to_wapay'].price.flatCents, 0);
  // Pay-out limits as the service enforces them.
  assert.equal(MIN_PAYOUT_CENTS, 2000);
  assert.equal(MAX_PAYOUT_CENTS, 300000);
  for (const id of ['out.payshap', 'out.cashsend']) assert.equal(rowById[id].limits.minCents, 5000, `${id}: OTT system minimum R50`);
  for (const id of ['out.nedcash', 'out.ewallet']) assert.equal(rowById[id].limits.minCents, 2000, `${id}: product minimum R20`);
});

test('the committed code-facts.json equals a fresh snapshot of the code (re-run sync-from-code after a fee change)', () => {
  const fresh = snapshotFromCode();
  const strip = (o) => { const { generatedAt, build, ...rest } = o; return rest; };
  const { rowsVersion, rowsDate, referenceAmountsCents, grid, ...committed } = facts;
  assert.deepEqual(strip(committed), strip(fresh));
  assert.deepEqual(referenceAmountsCents, AMOUNTS);
  assert.equal(rowsVersion, rowsDoc.version, 'rows.json version changed: re-run sync-from-code');
  assert.deepEqual(grid, gridFromModel(), 'the committed grid differs from rows.json + model.js: re-run sync-from-code');
});

test('the dashboard grid equals the charging functions at the five reference amounts', () => {
  for (const a of AMOUNTS) {
    const key = String(a);
    for (const row of rowsDoc.rows) {
      const cell = facts.grid[row.id][key];
      const fn = row.codeRef?.fn;
      if (!fn || cell.na) continue;
      if (fn === 'depositFeeCents') assert.equal(cell.price, depositFeeCents(a), `${row.id} @${a}`);
      if (fn === 'paymentRequestFeeCents') assert.equal(cell.price, paymentRequestFeeCents(a, row.codeRef.rail), `${row.id} @${a}`);
      if (fn === 'cashout') {
        assert.equal(cell.price, cashoutFeeCents(row.codeRef.method, a), `${row.id} fee @${a}`);
        assert.equal(cell.costIncl, cashoutRailCostCents(row.codeRef.method, a), `${row.id} cost @${a}`);
        assert.equal(cell.margin, cashoutMarginCents(row.codeRef.method, a), `${row.id} margin @${a}`);
      }
      if (fn === 'loadDiscount') assert.equal(cell.credited, a - bps(a, FEES.load[row.codeRef.rail].discountBps), `${row.id} credited @${a}`);
      if (fn === 'commission') assert.equal(cell.booked, bps(a, FEES.commissionBps[row.codeRef.category]), `${row.id} booked @${a}`);
      if (fn === 'voucherGift') {
        assert.equal(cell.booked, bps(a, FEES.voucherGift.commissionBps), `${row.id} booked @${a}`);
        if (row.price.kind === 'flat') assert.equal(cell.price, FEES.voucherGift.flatFeeCents);
      }
      if (fn === 'sendSpend') assert.equal(cell.price, 0);
      if (fn === 'sendCash') assert.equal(cell.price, FEES.send.flatCents);
    }
  }
});

test('every number has a status from the vocabulary and a source; every ASSUMED, PROPOSED or UNKNOWN number has a question', () => {
  const ids = new Set();
  for (const row of rowsDoc.rows) {
    assert.ok(!ids.has(row.id), `${row.id} is unique`);
    ids.add(row.id);
    assert.ok(rowsDoc.sections[row.section], `${row.id}: section ${row.section} exists`);
    assert.ok(['LIVE', 'PILOT', 'BUILT', 'NOT_BUILT', 'OFF'].includes(row.productState), `${row.id} productState`);
    assert.ok(MoneyMap.PAYER_LABEL[row.payer], `${row.id} payer`);
    assert.ok(row.owner, `${row.id} has a decision owner`);
    const numbers = [row.cost, row.price, row.commission, row.proposedPrice].filter(Boolean);
    assert.ok(numbers.length >= 2, `${row.id} states a cost and a price`);
    let needsQuestion = false;
    for (const n of numbers) {
      assert.ok(STATUSES.includes(n.status), `${row.id}: status ${n.status}`);
      assert.ok(typeof n.source === 'string' && n.source.length > 12, `${row.id}: a source for every number`);
      if (n.status !== 'SIGNED' && n.status !== 'LIVE') needsQuestion = true;
    }
    if (needsQuestion) {
      const q = row.question || (row.questionRef && rowById[row.questionRef] && rowById[row.questionRef].question);
      assert.ok(q, `${row.id}: an ASSUMED, PROPOSED or UNKNOWN number needs a sign-off question (own or via questionRef)`);
    }
    if (row.questionRef) assert.ok(rowById[row.questionRef]?.question, `${row.id}: questionRef points at a row with a question`);
  }
});

test('signed-but-unbooked commission is visible: the OTT voucher rows show 4% contract and 0 booked', () => {
  for (const id of ['vend.ott_voucher_self', 'vend.ott_voucher_gift']) {
    const r = rowById[id];
    assert.equal(r.commission.status, 'SIGNED');
    assert.equal(r.commission.bps, 400);
    assert.equal(r.commission.bookedBps, 0);
    const c = facts.grid[id]['10000'] || MoneyMap.compute(r, 10000);
    const at100 = MoneyMap.compute(r, 10000);
    assert.equal(at100.commissionCents, 400);
    assert.equal(at100.commissionBookedCents, 0);
    assert.equal(at100.marginCents - at100.marginBookedCents, 400);
    assert.ok(c, 'row computes');
  }
});

test('the voucher-load VAT gap is stated: contract 6% ex VAT, credit face less 6%, 90c per R100 against WaPay', () => {
  for (const id of ['in.blu.voucher_load', 'in.ott.voucher_load']) {
    const r = MoneyMap.compute(rowById[id], 10000);
    assert.equal(r.creditedCents, 9400);
    assert.equal(r.receivedCents, 9310);
    assert.equal(r.marginCents, -90);
  }
});

test('the generated block in docs/COMMERCIALS.md and the assembled page are current', () => {
  const md = readFileSync(path.join(root, 'docs', 'COMMERCIALS.md'), 'utf8');
  assert.match(md, /<!-- MONEY_MAP_TABLES:BEGIN -->/);
  assert.match(md, /<!-- MONEY_MAP_TABLES:END -->/);
  assert.ok(md.includes(`Money Map data version ${rowsDoc.version}`), 'COMMERCIALS.md names the rows.json version');
  const html = path.join(dir, 'money-map.html');
  assert.ok(existsSync(html), 'money-map.html is assembled');
  const page = readFileSync(html, 'utf8');
  assert.ok(page.includes(`"version": "${rowsDoc.version}"`) || page.includes(`"version":"${rowsDoc.version}"`), 'the page embeds the current rows.json');
  for (const id of Object.keys(rowById)) assert.ok(page.includes(`"${id}"`), `page carries row ${id}`);
});

test('nothing the founder will send carries an em dash', () => {
  const texts = [JSON.stringify(rowsDoc), readFileSync(path.join(root, 'docs', 'COMMERCIALS.md'), 'utf8')];
  for (const t of texts) assert.ok(!t.includes('—'), 'no em dash');
});
