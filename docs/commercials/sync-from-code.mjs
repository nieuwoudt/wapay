#!/usr/bin/env node
/**
 * Snapshot what the code charges into docs/commercials/code-facts.json.
 *
 *   node docs/commercials/sync-from-code.mjs [--build <short hash>]
 *
 * The snapshot is what tests/commercials-consistency.test.mjs compares the
 * live functions against, and what the Money Map prints as "verified against
 * build X". Run it after ANY change to a fee in lib/ledger-core.js or
 * lib/deposits.js, then `node docs/commercials/assemble.mjs`, then republish.
 *
 * It computes with the code defaults: no WAPAY_DEPOSIT_FEE_* / WAPAY_ADUMO_FEE_*
 * / WAPAY_PAYREQ_FREE_BELOW_CENTS / WAPAY_VAT_REGISTERED override is read.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

for (const k of ['WAPAY_DEPOSIT_FEE_BPS', 'WAPAY_DEPOSIT_FEE_FIXED_CENTS', 'WAPAY_ADUMO_FEE_BPS', 'WAPAY_ADUMO_FEE_FIXED_CENTS', 'WAPAY_PAYREQ_FREE_BELOW_CENTS', 'WAPAY_VAT_REGISTERED']) delete process.env[k];

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '..', '..');
const require = createRequire(import.meta.url);
const MoneyMap = require('./model.js');
const ledger = await import(path.join(root, 'lib/ledger-core.js'));
const deposits = await import(path.join(root, 'lib/deposits.js'));
const payouts = await import(path.join(root, 'lib/payouts.js'));

const rowsDoc = JSON.parse(readFileSync(path.join(dir, 'rows.json'), 'utf8'));
const amounts = rowsDoc.referenceAmountsCents;
const buildArg = process.argv.indexOf('--build');
const build = buildArg > -1 ? String(process.argv[buildArg + 1] || '').trim() : 'unknown';

const bandsOf = (cfg) => cfg.bands.map(([max, fee]) => [Number.isFinite(max) ? max : null, fee]);

/** What the code charges, per function, at the reference amounts and as raw config. */
export function snapshotFromCode() {
  const fees = ledger.FEES;
  const snapshot = {
    generatedAt: new Date().toISOString(),
    build,
    vatBps: ledger.VAT_BPS,
    feeStyle: ledger.FEE_STYLE,
    deposit: { ...deposits.cardRailFee('PAYFAST'), minCents: deposits.MIN_DEPOSIT_CENTS, maxCents: deposits.MAX_DEPOSIT_CENTS },
    cardRail: { PAYFAST: deposits.cardRailFee('PAYFAST'), ADUMO: deposits.cardRailFee('ADUMO') },
    payreqFreeBelowCents: deposits.PAYREQ_FREE_BELOW_CENTS,
    vatRegistered: deposits.vatRegistered(),
    load: Object.fromEntries(Object.entries(fees.load).map(([k, v]) => [k, { discountBps: v.discountBps, creditPolicy: v.creditPolicy }])),
    send: { ...fees.send },
    voucherGift: { ...fees.voucherGift },
    cashout: Object.fromEntries(Object.entries(fees.cashout).map(([k, v]) => [k, { railCostExVatCents: v.railCostExVatCents, switchingBps: v.switchingBps || 0, bands: bandsOf(v) }])),
    commissionBps: { ...fees.commissionBps },
    payout: { minCents: payouts.MIN_PAYOUT_CENTS, maxCents: payouts.MAX_PAYOUT_CENTS, methods: Object.keys(payouts.PAYOUT_METHODS) },
    atReference: {},
  };
  for (const a of amounts) {
    const key = String(a);
    snapshot.atReference[key] = {
      depositFeeCents: a >= deposits.MIN_DEPOSIT_CENTS && a <= deposits.MAX_DEPOSIT_CENTS ? deposits.depositFeeCents(a) : null,
      paymentRequestFeeCents: { PAYFAST: deposits.paymentRequestFeeCents(a, 'PAYFAST'), ADUMO: deposits.paymentRequestFeeCents(a, 'ADUMO') },
      cashout: Object.fromEntries(Object.keys(fees.cashout).map((m) => [m, { feeCents: ledger.cashoutFeeCents(m, a), railCostCents: ledger.cashoutRailCostCents(m, a), marginCents: ledger.cashoutMarginCents(m, a) }])),
      commissionCents: Object.fromEntries(Object.entries(fees.commissionBps).map(([c, b]) => [c, ledger.bps(a, b)])),
      loadCreditedCents: Object.fromEntries(Object.entries(fees.load).map(([r, cfg]) => [r, cfg.creditPolicy === 'FACE' ? a : a - ledger.bps(a, cfg.discountBps)])),
    };
  }
  return snapshot;
}

/** The dashboard's grid, computed by the mirror, so the committed numbers are inspectable. */
export function gridFromModel() {
  const g = MoneyMap.grid(rowsDoc.rows, amounts);
  const compact = {};
  for (const [id, byAmount] of Object.entries(g)) {
    compact[id] = {};
    for (const [a, r] of Object.entries(byAmount)) {
      compact[id][a] = r.applicable
        ? { price: r.priceCents, credited: r.creditedCents, costEx: r.costExCents, costIncl: r.costInclCents, commission: r.commissionCents, booked: r.commissionBookedCents, margin: r.marginCents, marginBooked: r.marginBookedCents, costUnknown: r.costUnknown }
        : { na: r.reason };
    }
  }
  return compact;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = { ...snapshotFromCode(), rowsVersion: rowsDoc.version, rowsDate: rowsDoc.date, referenceAmountsCents: amounts, grid: gridFromModel() };
  writeFileSync(path.join(dir, 'code-facts.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote code-facts.json: build ${build}, ${rowsDoc.rows.length} rows, ${amounts.length} amounts`);
}
