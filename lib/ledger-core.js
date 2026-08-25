/**
 * WaPay Ledger Core — pure money math, no database, no I/O.
 *
 * This module is the single source of truth for HOW money moves in WaPay.
 * It builds balanced double-entry postings for every business flow and
 * derives the fees/commissions from one config object, so the business
 * model lives in exactly one place (see FEES below).
 *
 * Deliberately pure so every rule is unit-testable without Postgres.
 * The database-writing counterpart (postEntry) lives in @wapay/domain and
 * is the ONLY module allowed to persist what this one computes.
 *
 * Money is always integer cents, ZAR. Never floats.
 */

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

/** Balance types a customer can hold. */
export const BALANCE = {
  /** Spend-only. Phone-number identity, no KYC. Cannot be withdrawn as cash. */
  SPEND: 'SPEND',
  /** Withdrawable. Requires KYC. Full P2P + cash-out. */
  CASH: 'CASH',
};

export const ACCT = {
  /** Customer liability: what WaPay owes this user, per balance type. */
  wallet: (accountId, balanceType) => `WALLET:${accountId}:${balanceType}`,

  /** Money in transit to/from a provider rail. */
  clearing: (rail) => `CLEARING:${rail}`,

  /** Fee income (customer paid us). */
  feeRevenue: (kind) => `REVENUE:FEE:${kind}`,

  /** Commission income (supplier paid us for the sale). */
  commissionRevenue: (category) => `REVENUE:COMMISSION:${category}`,

  /** Cost of a provider rail (e.g. voucher redemption discount we absorb). */
  providerExpense: (rail) => `EXPENSE:PROVIDER:${rail}`,

  /** Promotional top-ups we gift to customers (acquisition cost). */
  PROMO_EXPENSE: 'EXPENSE:PROMO:LOAD_BONUS',
};

export const RAIL = {
  BLU: 'BLU',
  OTT: 'OTT',
  ONEVOUCHER: 'ONEVOUCHER',
  PAYFAST: 'PAYFAST',
  PAYAT: 'PAYAT',
  YOYO: 'YOYO',
};

// ---------------------------------------------------------------------------
// Business model — every fee WaPay charges or pays, in one place.
// Change the business model here, not in flow code.
// ---------------------------------------------------------------------------

export const FEES = {
  /**
   * Load (cash-in). `discountBps` is what the rail keeps out of face value,
   * so we only ever receive face - discount.
   * `creditPolicy`:
   *   'NET'  -> credit exactly what we received (customer bears the cost)
   *   'FACE' -> credit full face value (WaPay absorbs the discount as promo)
   */
  load: {
    [RAIL.BLU]: { discountBps: 600, creditPolicy: 'NET' }, // Blu keeps 6%
    [RAIL.OTT]: { discountBps: 600, creditPolicy: 'NET' }, // OTT redeem 6% + VAT
    [RAIL.ONEVOUCHER]: { discountBps: 600, creditPolicy: 'NET' },
    [RAIL.PAYFAST]: { discountBps: 0, creditPolicy: 'FACE' }, // card fee settled separately
  },

  /** P2P send: flat fee. Free when the value cannot be withdrawn (spend->spend). */
  send: {
    flatCents: 250,
    freeForSpendBalance: true,
  },

  /**
   * Voucher gift ("Send R50 to 084...") — WaPay sells the sender a GOODS
   * voucher issued on a provider rail (OTT today); never a money transfer.
   * Flat R3 per the locked fee model (flat fees, spend balance).
   *
   * commissionBps is 0 until OTT's rate card is signed in writing — do not
   * assume issuing commission we have no contract for. Bump it here (or via
   * a per-call override) once the signed rates arrive.
   */
  voucherGift: {
    flatFeeCents: 300,
    commissionBps: 0,
  },

  /**
   * Cash-out: flat fee to the customer, and what the payout rail charges us.
   *
   * Rail costs are quoted by suppliers EXCLUDING VAT (OTT Payout Annexure A,
   * agreement read 2026-08-25). WaPay is NOT VAT-registered, so that VAT is
   * an unrecoverable REAL cost — `cashoutRailCostCents` therefore grosses
   * every rail cost UP by VAT before margin is computed. Quoting ex-VAT
   * costs against inc-VAT revenue overstates margin by ~15%.
   *
   * Per-transaction supplier rates (excl VAT):
   *   Pay@                      R8.65  at Pick n Pay
   *   OTT PayShap               R2.50  instant, any bank  <- the margin rail
   *   OTT RTC                   R4.50
   *   OTT CashSend (ABSA/Nedbk) R9.96  + 0.3% switching on monthly value
   *
   * The 0.3% switching fee applies ONLY to OTT's "Cash Send & VAS Products"
   * (Annexure A clause 3.2) — PayShap and RTC are "Bank EFT Products" under
   * clause 3.3 and carry NO percentage component. That is why PayShap earns
   * a constant margin at every ticket size and CashSend does not.
   *
   * CUSTOMER FEES STAY FLAT (see FEE_STYLE) but are BANDED by amount, the
   * same shape the founder approved for deposits. A single flat R14 CashSend
   * fee went underwater above ~R738 face (cost rises with the 0.3%), so the
   * bands keep every ticket margin-positive without ever quoting a
   * percentage to a customer. Bands are [maxAmountCentsInclusive, feeCents].
   */
  cashout: {
    [RAIL.PAYAT]: { railCostExVatCents: 865, bands: [[Infinity, 1200]] },
    PAYSHAP: { railCostExVatCents: 250, bands: [[Infinity, 600]] },
    RTC: { railCostExVatCents: 450, bands: [[Infinity, 800]] },
    CASHSEND: {
      railCostExVatCents: 996,
      switchingBps: 30,
      bands: [
        [70000, 1600],
        [150000, 2100],
        [Infinity, 2800],
      ],
    },
  },

  /**
   * Spend commission we EARN from the supplier, in basis points of sale value.
   * These are the margin engine. Betting is highest, hence the flagship bet.
   *
   * NOTE: these are planning estimates until each supplier rate card is
   * confirmed in writing. Blu VAS and OTT VAS (1% + 0.3% switching) differ,
   * so rates are per-category here and overridable per call.
   */
  commissionBps: {
    AIRTIME: 400,
    DATA: 500,
    ELECTRICITY: 150,
    BILLPAY: 100,
    RETAIL: 300,
    LIFESTYLE: 500,
    BETTING: 1000,
  },
};

/**
 * Customer-facing fees are deliberately FLAT, never percentages.
 * A flat number is explainable in one WhatsApp line ("R6 to withdraw"),
 * which the mass market trusts far more than a percentage.
 */
export const FEE_STYLE = 'FLAT';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Basis points of an amount, rounded to the nearest cent. */
export function bps(amountCents, basisPoints) {
  assertMoney(amountCents, 'amountCents');
  return Math.round((amountCents * basisPoints) / 10000);
}

/**
 * South African VAT, in basis points. Supplier rate cards are quoted EXCLUDING
 * VAT; WaPay is not VAT-registered, so it cannot be reclaimed and is a real
 * cost of every payout. Never compare an ex-VAT cost to an inc-VAT fee.
 */
export const VAT_BPS = 1500;

/** Gross an ex-VAT cost up to what actually leaves the bank account. */
export function inclVatCents(exVatCents) {
  assertMoney(exVatCents, 'exVatCents');
  return Math.ceil((exVatCents * (10000 + VAT_BPS)) / 10000);
}

/**
 * The customer's FLAT cash-out fee for this rail and amount.
 *
 * Flat per band — a customer is always quoted one number ("R16 to withdraw"),
 * never a percentage (FEE_STYLE). Bands exist only so the number stays
 * margin-positive as the rail's own percentage component grows.
 *
 * @param {string} method - RAIL.PAYAT | 'PAYSHAP' | 'RTC' | 'CASHSEND'
 * @param {number} amountCents - the cash the customer receives
 * @returns {number} integer cents
 */
export function cashoutFeeCents(method, amountCents) {
  assertMoney(amountCents, 'amountCents');
  const cfg = FEES.cashout[method];
  if (!cfg) throw new Error(`No cashout config for method ${method}`);
  for (const [maxCents, feeCents] of cfg.bands) {
    if (amountCents <= maxCents) return feeCents;
  }
  // Bands must end with an Infinity catch-all; a config without one is a bug.
  throw new Error(`No fee band covers ${amountCents} for ${method}`);
}

/**
 * What the payout rail actually costs US for this transaction, INCLUDING the
 * VAT we cannot reclaim. This is the number margin is measured against.
 *
 * @returns {number} integer cents
 */
export function cashoutRailCostCents(method, amountCents) {
  assertMoney(amountCents, 'amountCents');
  const cfg = FEES.cashout[method];
  if (!cfg) throw new Error(`No cashout config for method ${method}`);
  const fixed = inclVatCents(cfg.railCostExVatCents);
  if (!cfg.switchingBps) return fixed;
  // The switching fee is levied on monthly aggregate value; per transaction
  // it is the same rate, so accrue it here to keep per-txn margin honest.
  const switching = Math.ceil((amountCents * cfg.switchingBps * (10000 + VAT_BPS)) / 100000000);
  return fixed + switching;
}

/**
 * Margin on one cash-out, in cents. Negative means the transaction loses
 * money — no band may ever return a negative number (locked by tests).
 */
export function cashoutMarginCents(method, amountCents) {
  return cashoutFeeCents(method, amountCents) - cashoutRailCostCents(method, amountCents);
}

function assertMoney(v, name) {
  if (!Number.isInteger(v)) {
    throw new Error(`${name} must be an integer number of cents, got ${v}`);
  }
  if (v < 0) {
    throw new Error(`${name} must not be negative, got ${v}`);
  }
}

/**
 * Validate that a set of postings is balanced and well-formed.
 * Throws on any violation. This is the invariant the whole ledger rests on.
 */
export function validateBalanced(postings) {
  if (!Array.isArray(postings) || postings.length < 2) {
    throw new Error('A journal entry needs at least two lines');
  }

  let debit = 0;
  let credit = 0;

  for (const p of postings) {
    if (!p.accountCode || typeof p.accountCode !== 'string') {
      throw new Error('Every posting needs an accountCode');
    }
    const d = p.debitCents ?? 0;
    const c = p.creditCents ?? 0;
    if (d && c) {
      throw new Error(`Posting on ${p.accountCode} cannot be both debit and credit`);
    }
    if (!d && !c) {
      throw new Error(`Posting on ${p.accountCode} has no amount`);
    }
    assertMoney(d, `debitCents on ${p.accountCode}`);
    assertMoney(c, `creditCents on ${p.accountCode}`);
    debit += d;
    credit += c;
  }

  if (debit !== credit) {
    throw new Error(`Journal not balanced: debit=${debit} credit=${credit}`);
  }
  return { debitCents: debit, creditCents: credit };
}

/**
 * Every entry this module builds passes through here, so no flow can
 * accidentally emit an unbalanced or unkeyed entry.
 */
function entry({ idemKey, source, postings, meta }) {
  if (!idemKey || typeof idemKey !== 'string') {
    throw new Error('idemKey is required and must be deterministic');
  }
  // Guards against the Date.now() keys that made retries mint new charges.
  // Matches epoch milliseconds (13 digits starting with 1) or epoch seconds
  // (10 digits starting with 1) as a standalone run, so base64-ish provider
  // ids such as a WhatsApp wamid are not falsely rejected.
  if (/(?<!\d)1\d{12}(?!\d)/.test(idemKey) || /(?<!\d)1[6-9]\d{8}(?!\d)/.test(idemKey)) {
    throw new Error(`idemKey "${idemKey}" looks timestamp-based; derive it from message/preview id instead`);
  }
  validateBalanced(postings);
  return { idemKey, source, postings, meta: meta ?? {} };
}

// ---------------------------------------------------------------------------
// Flow builders — one per money movement
// ---------------------------------------------------------------------------

/**
 * Cash-in from a voucher or card rail.
 *
 * faceCents is what the customer paid at retail. The rail keeps `discountBps`,
 * so WaPay receives `receivedCents`. Depending on creditPolicy we either credit
 * the customer what we received (NET) or top them up to face value (FACE),
 * booking the difference as a promo expense.
 */
export function buildLoad({
  accountId,
  rail,
  faceCents,
  idemKey,
  balanceType = BALANCE.SPEND,
  customerFeeCents = 0,
}) {
  assertMoney(faceCents, 'faceCents');
  if (faceCents === 0) throw new Error('faceCents must be greater than zero');
  assertMoney(customerFeeCents, 'customerFeeCents');

  const cfg = FEES.load[rail];
  if (!cfg) throw new Error(`No load config for rail ${rail}`);

  const discountCents = bps(faceCents, cfg.discountBps);
  const receivedCents = faceCents - discountCents;
  const creditCents = cfg.creditPolicy === 'FACE' ? faceCents : receivedCents;
  const promoCents = creditCents - receivedCents;

  const postings = [
    // We are owed / hold the cash the rail will settle to us — including any
    // payment fee the customer paid on top of the load (founder decision
    // 2026-08-20: card/EFT loads must cover the processor cost + margin).
    { accountCode: ACCT.clearing(rail), debitCents: receivedCents + customerFeeCents },
  ];
  if (promoCents > 0) {
    // We chose to gift the customer the difference — that is our cost.
    postings.push({ accountCode: ACCT.PROMO_EXPENSE, debitCents: promoCents });
  }
  postings.push({ accountCode: ACCT.wallet(accountId, balanceType), creditCents: creditCents });
  if (customerFeeCents > 0) {
    postings.push({ accountCode: ACCT.feeRevenue('DEPOSIT'), creditCents: customerFeeCents });
  }

  return entry({
    idemKey,
    source: `LOAD_${rail}`,
    postings,
    meta: { accountId, rail, faceCents, receivedCents, creditCents, promoCents, customerFeeCents, balanceType },
  });
}

/**
 * Buy a value-added service (airtime, data, electricity, betting deposit, retail).
 *
 * The customer pays `saleCents`. The supplier bills us `saleCents - commission`.
 * The commission is our revenue — this is where WaPay actually makes money.
 */
export function buildSpend({
  accountId,
  category,
  saleCents,
  idemKey,
  rail = RAIL.BLU,
  balanceType = BALANCE.SPEND,
  commissionBpsOverride,
}) {
  assertMoney(saleCents, 'saleCents');
  if (saleCents === 0) throw new Error('saleCents must be greater than zero');

  const rate = commissionBpsOverride ?? FEES.commissionBps[category];
  if (rate === undefined) throw new Error(`No commission rate for category ${category}`);

  const commissionCents = bps(saleCents, rate);
  const supplierCents = saleCents - commissionCents;

  // A journal line must carry an amount; when the sale is so small that the
  // commission rounds to zero cents, the revenue line is simply omitted.
  const postings = [
    { accountCode: ACCT.wallet(accountId, balanceType), debitCents: saleCents },
    { accountCode: ACCT.clearing(rail), creditCents: supplierCents },
  ];
  if (commissionCents > 0) {
    postings.push({ accountCode: ACCT.commissionRevenue(category), creditCents: commissionCents });
  }

  return entry({
    idemKey,
    source: `SPEND_${category}`,
    postings,
    meta: { accountId, category, saleCents, supplierCents, commissionCents, rail, balanceType },
  });
}

/**
 * Send money to another WaPay user.
 *
 * Spend->spend transfers are free (the value still can't leave our rails, and
 * free P2P is the growth loop). Anything touching CASH carries the flat fee.
 */
export function buildSend({ fromAccountId, toAccountId, amountCents, idemKey, balanceType = BALANCE.SPEND }) {
  assertMoney(amountCents, 'amountCents');
  if (amountCents === 0) throw new Error('amountCents must be greater than zero');
  if (fromAccountId === toAccountId) throw new Error('Cannot send to the same account');

  const isFree = FEES.send.freeForSpendBalance && balanceType === BALANCE.SPEND;
  const feeCents = isFree ? 0 : FEES.send.flatCents;

  const postings = [
    { accountCode: ACCT.wallet(fromAccountId, balanceType), debitCents: amountCents + feeCents },
    { accountCode: ACCT.wallet(toAccountId, balanceType), creditCents: amountCents },
  ];
  if (feeCents > 0) {
    postings.push({ accountCode: ACCT.feeRevenue('SEND'), creditCents: feeCents });
  }

  return entry({
    idemKey,
    source: 'P2P_SEND',
    postings,
    meta: { fromAccountId, toAccountId, amountCents, feeCents, balanceType },
  });
}

/**
 * Show only the last 3 digits of a number in stored metadata.
 *
 * Local on purpose: lib/gifting.js has the recipient-facing maskMsisdn, but
 * importing it here would create a cycle (gifting depends on this module's
 * consumers), and ledger-core must stay pure and dependency-free.
 */
function maskMsisdn(raw = '') {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length < 4) return '';
  return `${digits.slice(0, 3)}•••${digits.slice(-3)}`;
}

/**
 * Gift a voucher to a phone number ("Send R50 to 084...").
 *
 * Regulatory framing matters here: the sender BUYS a goods voucher from us,
 * which a provider rail (OTT today) issues for the recipient. So the sender
 * pays face + flat fee, the rail is owed the face value less any issuing
 * commission, and the fee is our revenue. Rail-agnostic by design — the rail
 * only decides which clearing account is owed.
 *
 * The full voucher PIN is a bearer secret and NEVER belongs in this entry:
 * meta carries only the masked recipient number.
 */
export function buildVoucherGift({
  senderAccountId,
  amountCents,
  idemKey,
  rail = RAIL.OTT,
  recipientMsisdn,
  flatFeeCentsOverride = null,
}) {
  assertMoney(amountCents, 'amountCents');
  if (amountCents === 0) throw new Error('amountCents must be greater than zero');

  const { flatFeeCents: defaultFeeCents, commissionBps } = FEES.voucherGift;
  // The preview is the quote of record: self-purchases are fee-free (founder
  // decision) while gifts carry the flat fee. Booking a different fee than
  // the one quoted is an overcharge (QA 2026-08-21).
  const flatFeeCents = Number.isInteger(flatFeeCentsOverride) && flatFeeCentsOverride >= 0
    ? flatFeeCentsOverride
    : defaultFeeCents;
  const commissionCents = bps(amountCents, commissionBps);
  const railCents = amountCents - commissionCents;

  // Gifts are bought from the no-KYC SPEND balance — buying a goods voucher
  // is a spend, not a withdrawal, so the KYC gate does not apply.
  const postings = [
    { accountCode: ACCT.wallet(senderAccountId, BALANCE.SPEND), debitCents: amountCents + flatFeeCents },
    { accountCode: ACCT.clearing(rail), creditCents: railCents },
  ];
  // A journal line must carry an amount; while commissionBps is 0 (unsigned
  // OTT rates) the revenue line is simply omitted — same guard as buildSpend.
  if (commissionCents > 0) {
    postings.push({ accountCode: ACCT.commissionRevenue('VOUCHER'), creditCents: commissionCents });
  }
  if (flatFeeCents > 0) {
    postings.push({ accountCode: ACCT.feeRevenue('SEND'), creditCents: flatFeeCents });
  }

  return entry({
    idemKey,
    source: `VOUCHER_GIFT_${rail}`,
    postings,
    meta: {
      senderAccountId,
      amountCents,
      flatFeeCents,
      commissionCents,
      railCents,
      rail,
      recipientMasked: maskMsisdn(recipientMsisdn),
      balanceType: BALANCE.SPEND,
    },
  });
}

/**
 * Withdraw cash. Only ever from a CASH balance — the KYC gate lives here.
 *
 * Two entries' worth of truth in one: the customer is debited amount + fee,
 * the payout rail is credited what it must pay out, and we separately book
 * what the rail charges us so the margin on withdrawals is visible.
 */
export function buildCashout({ accountId, amountCents, idemKey, method = RAIL.PAYAT }) {
  assertMoney(amountCents, 'amountCents');
  if (amountCents === 0) throw new Error('amountCents must be greater than zero');

  const feeCents = cashoutFeeCents(method, amountCents);
  const railCostCents = cashoutRailCostCents(method, amountCents);
  const rail = method === RAIL.PAYAT ? RAIL.PAYAT : RAIL.OTT;

  return entry({
    idemKey,
    source: `CASHOUT_${method}`,
    postings: [
      // Customer always pays from CASH — withdrawal is the KYC-gated path.
      { accountCode: ACCT.wallet(accountId, BALANCE.CASH), debitCents: amountCents + feeCents },
      { accountCode: ACCT.clearing(rail), creditCents: amountCents },
      { accountCode: ACCT.feeRevenue('CASHOUT'), creditCents: feeCents },
    ],
    meta: { accountId, amountCents, feeCents, railCostCents, method, rail },
  });
}

/** What the payout rail charges us, booked separately from the customer's fee. */
export function buildCashoutRailCost({ amountCents, idemKey, method = RAIL.PAYAT }) {
  const railCostCents = cashoutRailCostCents(method, amountCents);
  const rail = method === RAIL.PAYAT ? RAIL.PAYAT : RAIL.OTT;

  return entry({
    idemKey,
    source: `CASHOUT_COST_${method}`,
    postings: [
      { accountCode: ACCT.providerExpense(rail), debitCents: railCostCents },
      { accountCode: ACCT.clearing(rail), creditCents: railCostCents },
    ],
    meta: { railCostCents, method },
  });
}

/**
 * Upgrade a KYC'd customer's spend balance into withdrawable cash balance.
 * Moves value between two liability accounts the customer owns.
 */
export function buildBalanceUpgrade({ accountId, amountCents, idemKey }) {
  assertMoney(amountCents, 'amountCents');
  if (amountCents === 0) throw new Error('amountCents must be greater than zero');

  return entry({
    idemKey,
    source: 'BALANCE_UPGRADE',
    postings: [
      { accountCode: ACCT.wallet(accountId, BALANCE.SPEND), debitCents: amountCents },
      { accountCode: ACCT.wallet(accountId, BALANCE.CASH), creditCents: amountCents },
    ],
    meta: { accountId, amountCents },
  });
}

/**
 * Reverse a previously posted entry by mirroring its lines.
 *
 * This replaces the old "rename the source field" approach, which left the
 * original debits standing and made the journal unbalanceable.
 */
export function buildReversal({ original, idemKey, reason }) {
  if (!original?.postings?.length) throw new Error('Cannot reverse an entry with no postings');

  const mirrored = original.postings.map((p) => ({
    accountCode: p.accountCode,
    debitCents: p.creditCents ?? undefined,
    creditCents: p.debitCents ?? undefined,
  }));

  return entry({
    idemKey,
    source: `REVERSAL_${original.source}`,
    postings: mirrored,
    meta: { reversalOf: original.idemKey, reason: reason ?? 'unspecified' },
  });
}

// ---------------------------------------------------------------------------
// Reporting / reconciliation
// ---------------------------------------------------------------------------

/**
 * Net effect per account across entries.
 * Positive = net debit, negative = net credit.
 */
export function netByAccount(entries) {
  const totals = new Map();
  for (const e of entries) {
    for (const p of e.postings) {
      const delta = (p.debitCents ?? 0) - (p.creditCents ?? 0);
      totals.set(p.accountCode, (totals.get(p.accountCode) ?? 0) + delta);
    }
  }
  return totals;
}

/**
 * A customer's balance derived purely from journal lines.
 * Wallets are liabilities, so credits increase what the customer holds.
 */
export function deriveWalletBalance(entries, accountId, balanceType = BALANCE.SPEND) {
  const code = ACCT.wallet(accountId, balanceType);
  let balance = 0;
  for (const e of entries) {
    for (const p of e.postings) {
      if (p.accountCode === code) {
        balance += (p.creditCents ?? 0) - (p.debitCents ?? 0);
      }
    }
  }
  return balance;
}

/** Trial balance across every entry — must always be zero. */
export function trialBalance(entries) {
  let sum = 0;
  for (const total of netByAccount(entries).values()) sum += total;
  return sum;
}

/**
 * What WaPay actually earned across a set of entries: revenue minus expense.
 * This is the number that decides whether a flow is worth running.
 */
export function netMarginCents(entries) {
  let margin = 0;
  for (const [code, net] of netByAccount(entries)) {
    // Revenue accounts carry credit balances (negative net), expenses debit.
    if (code.startsWith('REVENUE:')) margin += -net;
    if (code.startsWith('EXPENSE:')) margin -= net;
  }
  return margin;
}
