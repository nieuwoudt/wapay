/**
 * WaPay Money Map: the fee arithmetic the dashboard runs in the browser.
 *
 * This file is a MIRROR of the charging functions in lib/ledger-core.js and
 * lib/deposits.js, written without imports so the same bytes can be inlined
 * into docs/commercials/money-map.html. tests/commercials-consistency.test.mjs
 * proves the mirror equals the real functions at every amount the product
 * accepts, so the dashboard can never drift from what production charges.
 *
 * Plain script on purpose: in the browser it defines `MoneyMap`; in Node
 * (CommonJS, since package.json has no "type") it also exports it.
 */
const MoneyMap = (() => {
  const VAT_BPS = 1500;

  /** lib/ledger-core.js bps(): basis points of an amount, rounded to the cent. */
  function bps(amountCents, basisPoints) {
    return Math.round((amountCents * basisPoints) / 10000);
  }

  /** lib/ledger-core.js inclVatCents(): gross an ex-VAT cost up, rounded UP. */
  function inclVatCents(exVatCents) {
    return Math.ceil((exVatCents * (10000 + VAT_BPS)) / 10000);
  }

  /** lib/deposits.js depositFeeCents(): rate + fixed, rounded UP to a whole rand. */
  function depositFeeCents(amountCents, rail = { bps: 420, fixedCents: 230 }) {
    const rawCents = Math.ceil((amountCents * rail.bps) / 10000) + rail.fixedCents;
    return Math.ceil(rawCents / 100) * 100;
  }

  const CARD_RAIL = {
    PAYFAST: { bps: 420, fixedCents: 230 },
    ADUMO: { bps: 250, fixedCents: 100 },
  };
  const PAYREQ_FREE_BELOW_CENTS = 5000;

  /** lib/deposits.js paymentRequestFeeCents(): free under R50, 10c rounding, taper. */
  function paymentRequestFeeCents(amountCents, rail = 'PAYFAST', vatRegistered = false) {
    if (amountCents < PAYREQ_FREE_BELOW_CENTS) return 0;
    const { bps: b, fixedCents } = CARD_RAIL[rail] || CARD_RAIL.PAYFAST;
    const exVatCents = Math.ceil((amountCents * b) / 10000) + fixedCents;
    const rawCents = vatRegistered ? Math.ceil((exVatCents * (10000 + VAT_BPS)) / 10000) : exVatCents;
    const fee = Math.ceil(rawCents / 10) * 10;
    const maxFeeForMonotonicNet = Math.max(0, amountCents - (PAYREQ_FREE_BELOW_CENTS - 100));
    return Math.min(fee, maxFeeForMonotonicNet);
  }

  /** lib/ledger-core.js cashoutFeeCents(): flat per band; null ceiling = catch-all. */
  function bandFeeCents(bands, amountCents) {
    for (const [maxCents, feeCents] of bands) {
      if (maxCents === null || maxCents === undefined || amountCents <= maxCents) return feeCents;
    }
    throw new Error(`No fee band covers ${amountCents}`);
  }

  /** lib/ledger-core.js cashoutRailCostCents(): fixed grossed up, switching accrued per transaction. */
  function cashoutRailCostCents(cost, amountCents) {
    const fixed = inclVatCents(cost.fixedCents);
    if (!cost.bps) return fixed;
    const switching = Math.ceil((amountCents * cost.bps * (10000 + VAT_BPS)) / 100000000);
    return fixed + switching;
  }

  /** A generic per-transaction supplier cost (card rails, Yoyo): ex and incl VAT, to the cent. */
  function railCostCents(cost, amountCents) {
    if (cost == null || cost.fixedCents == null || cost.bps == null) return null;
    const ex = cost.fixedCents + (amountCents * cost.bps) / 10000;
    const incl = cost.exVat ? (ex * (10000 + VAT_BPS)) / 10000 : ex;
    return { exCents: Math.round(ex), inclCents: Math.round(incl) };
  }

  function withinLimits(row, amountCents) {
    const lim = row.limits;
    if (!lim) return { ok: false, reason: 'not per transaction' };
    if (lim.minCents != null && amountCents < lim.minCents) return { ok: false, reason: 'below the minimum' };
    if (lim.maxCents != null && amountCents > lim.maxCents) return { ok: false, reason: 'above the maximum' };
    return { ok: true };
  }

  /**
   * Everything the map shows for one row at one amount, in integer cents.
   * marginCents uses the contract (or assumed) commission; marginBookedCents
   * uses what the ledger books today, so a signed-but-unbooked rate shows both.
   */
  function compute(row, amountCents) {
    const out = {
      amountCents,
      applicable: true,
      reason: null,
      priceCents: null,
      creditedCents: null,
      receivedCents: null,
      costExCents: null,
      costInclCents: null,
      commissionCents: null,
      commissionBookedCents: null,
      marginCents: null,
      marginBookedCents: null,
      costUnknown: false,
    };
    const lim = withinLimits(row, amountCents);
    if (!lim.ok) {
      out.applicable = false;
      out.reason = lim.reason;
      return out;
    }
    const price = row.price || {};
    const cost = row.cost || {};
    const com = row.commission || null;

    // Commission the supplier pays us (vending rows).
    if (com && com.bps != null) {
      out.commissionCents = bps(amountCents, com.bps);
      out.commissionBookedCents = bps(amountCents, com.bookedBps == null ? com.bps : com.bookedBps);
    }

    // What the customer pays WaPay.
    switch (price.kind) {
      case 'depositFee':
        out.priceCents = depositFeeCents(amountCents);
        break;
      case 'payreq':
        out.priceCents = paymentRequestFeeCents(amountCents, price.rail || 'PAYFAST');
        break;
      case 'bands':
        out.priceCents = bandFeeCents(price.bands, amountCents);
        break;
      case 'flat':
        out.priceCents = price.flatCents;
        break;
      case 'pct':
        out.priceCents = bps(amountCents, price.pctBps);
        break;
      case 'faceDiscount': {
        const discount = bps(amountCents, price.discountBps);
        out.priceCents = discount;
        out.creditedCents = amountCents - discount;
        break;
      }
      case 'face':
        out.priceCents = 0;
        break;
      default:
        out.priceCents = null;
    }

    // What the counterparty charges us.
    if (cost.kind === 'supplierNet') {
      // Face less commission: the supplier's price for the product itself.
      if (out.commissionCents == null) {
        out.costUnknown = true;
      } else {
        out.costExCents = amountCents - out.commissionCents;
        out.costInclCents = out.costExCents;
      }
    } else if (price.kind === 'bands') {
      if (cost.fixedCents == null) {
        out.costUnknown = true;
      } else {
        const ex = cost.fixedCents + Math.round((amountCents * (cost.bps || 0)) / 10000);
        out.costExCents = ex;
        out.costInclCents = cashoutRailCostCents(cost, amountCents);
      }
    } else if (price.kind === 'faceDiscount') {
      if (cost.bps == null) {
        out.costUnknown = true;
      } else {
        const ex = bps(amountCents, cost.bps) + (cost.fixedCents || 0);
        out.costExCents = ex;
        out.costInclCents = cost.exVat ? Math.round((ex * (10000 + VAT_BPS)) / 10000) : ex;
        out.receivedCents = amountCents - out.costInclCents;
      }
    } else {
      const rc = railCostCents(cost, amountCents);
      if (rc == null) {
        out.costUnknown = cost.status === 'UNKNOWN' || (cost.fixedCents == null && cost.bps == null && cost.monthlyCents == null && cost.perMessageUsd == null);
      } else {
        out.costExCents = rc.exCents;
        out.costInclCents = rc.inclCents;
      }
    }

    // Margin.
    if (out.costUnknown) {
      out.marginCents = null;
      out.marginBookedCents = null;
    } else if (cost.kind === 'supplierNet') {
      const fee = out.priceCents || 0;
      out.marginCents = fee + out.commissionCents;
      out.marginBookedCents = fee + out.commissionBookedCents;
    } else if (price.kind === 'faceDiscount') {
      out.marginCents = out.receivedCents - out.creditedCents;
      out.marginBookedCents = out.marginCents;
    } else if (out.priceCents == null && out.commissionCents == null) {
      out.marginCents = null;
      out.marginBookedCents = null;
    } else {
      const fee = out.priceCents || 0;
      const c = out.costInclCents || 0;
      out.marginCents = fee + (out.commissionCents || 0) - c;
      out.marginBookedCents = fee + (out.commissionBookedCents || 0) - c;
    }
    return out;
  }

  /** The five reference amounts for every row: the grid the founder asked for. */
  function grid(rows, amounts) {
    const result = {};
    for (const row of rows) {
      result[row.id] = {};
      for (const a of amounts) result[row.id][String(a)] = compute(row, a);
    }
    return result;
  }

  /** R12.34 with a thin-space thousands separator; negatives carry a leading minus. */
  function rand(cents, { sign = false } = {}) {
    if (cents == null || Number.isNaN(cents)) return '';
    const neg = cents < 0;
    const v = Math.abs(Math.round(cents));
    const whole = String(Math.floor(v / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    const frac = String(v % 100).padStart(2, '0');
    const body = `R${whole}.${frac}`;
    if (neg) return `-${body}`;
    return sign && cents > 0 ? `+${body}` : body;
  }

  /** "R2.30 + 3.20%" style description of a cost or price parameter set. */
  function describeRate(p) {
    if (!p) return '';
    if (p.monthlyCents != null) return `${rand(p.monthlyCents)} a month`;
    if (p.perMessageUsd != null) return `$${p.perMessageUsd} a message`;
    if (p.kind === 'supplierNet') return 'face less commission';
    if (p.fixedCents == null && p.bps == null) return 'not on file';
    const parts = [];
    if (p.fixedCents) parts.push(rand(p.fixedCents));
    if (p.bps) parts.push(`${(p.bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`);
    if (!parts.length) return 'R0';
    return parts.join(' + ') + (p.exVat ? ' ex VAT' : '');
  }

  function describePrice(p) {
    if (!p) return '';
    switch (p.kind) {
      case 'depositFee': return '4.20% + R2.30 on top, rounded up to the next rand';
      case 'payreq': return p.rail === 'ADUMO' ? 'R1 + 2.5% off the receiver, 10c rounding, free under R50' : 'R2.30 + 4.20% off the receiver, 10c rounding, free under R50';
      case 'bands':
        if (p.bands.length === 1) return `${rand(p.bands[0][1])} flat`.replace(/\.00/g, '');
        return p.bands.map(([max, fee]) => (max == null ? `${rand(fee)} above` : `${rand(fee)} up to ${rand(max)}`)).join(', ').replace(/\.00/g, '');
      case 'flat': return p.flatCents ? `${rand(p.flatCents)} flat` : 'free';
      case 'pct': return `${(p.pctBps / 100).toFixed(1).replace(/\.0$/, '')}% of face`;
      case 'faceDiscount': return `face less ${(p.discountBps / 100).toFixed(0)}% credited`;
      case 'face': return 'face value, no WaPay fee';
      case 'none': return 'no price set';
      default: return '';
    }
  }

  const PAYER_LABEL = {
    customer: 'the customer, on top',
    receiver: 'the receiver, off the credit',
    sender: 'the sender',
    business: 'the business',
    nobody: 'nobody (free or face value)',
    wapay: 'WaPay',
  };

  return {
    VAT_BPS,
    CARD_RAIL,
    PAYREQ_FREE_BELOW_CENTS,
    PAYER_LABEL,
    bps,
    inclVatCents,
    depositFeeCents,
    paymentRequestFeeCents,
    bandFeeCents,
    cashoutRailCostCents,
    railCostCents,
    compute,
    grid,
    rand,
    describeRate,
    describePrice,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MoneyMap;
