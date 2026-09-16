/**
 * Read tools for the pay agent: facts only, never a write, never an
 * execution. Every tool is best-effort and answers { ok: true, result } or
 * { ok: false, error }; nothing here throws into the agent loop.
 *
 * Rules kept (do not weaken):
 * - Totals are summed HERE, server-side, so the model never does arithmetic
 *   over rows (docs/AGENT_ARCHITECTURE_V2.md §5).
 * - Counterparties come from the context pack already masked; a voucher PIN
 *   is never selected anywhere on this path (constitution #8).
 * - get_payout_status asks the rail with GetPaymentStatus only, through
 *   lib/payouts.js reconcilePayout; it can never perform a pay-out.
 * - where_accepted never echoes an unknown merchant name back (a betting
 *   operator typed by the customer must not reach the reply).
 * - No model client and no localizer is imported here (tests lock that).
 */
import { loadContextPack, toCents, MOVEMENT_KINDS } from '../../context-pack.js';
import { rankProducts, searchProducts } from '../../vas-search.js';
import { feeAnswer, feeSchedule } from '../../fee-facts.js';
import { lookupOttMerchant, ottAcceptedFacts, OTT_SOLD_AT } from '../../ott-acceptance.js';
import { TOPICS, howItWorksAnswer } from '../../how-it-works.js';
import { getLatestPayout, reconcilePayout, payoutAllowedFor } from '../../payouts.js';
import { OttPayoutClient } from '../../ott-payout.js';
import { fuelLiveFor } from '../../capabilities.js';
import { advertisedFuelPartners } from '../../spend-catalogue.js';
import { FEE_KINDS, PRODUCT_CATEGORIES, TRANSACTION_RANGES } from './schemas.js';

const SAST_OFFSET_MS = 2 * 3600 * 1000; // Africa/Johannesburg, no daylight saving
const DAY_MS = 24 * 3600 * 1000;
const MAX_ROWS = 20;
const MAX_PRODUCTS = 8;
const PAYOUT_PROBE_TIMEOUT_MS = 3000;

const iso = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : (d ? new Date(d).toISOString() : null));

// ---------------------------------------------------------------------------
// get_transactions
// ---------------------------------------------------------------------------

const KIND_ALIASES = {
  WITHDRAW: 'PAYOUT', WITHDRAWAL: 'PAYOUT', CASHOUT: 'PAYOUT', PAYOUTS: 'PAYOUT',
  DEPOSITS: 'DEPOSIT', TOPUP: 'DEPOSIT', SENT: 'SEND', SENDS: 'SEND', GIFT: 'SEND',
  RECEIVED: 'GIFT_RECEIVED', LINK: 'PAY_LINK', PAYLINK: 'PAY_LINK', REQUEST: 'PAY_LINK',
  VOUCHER: 'VOUCHER_LOAD', ELEC: 'ELECTRICITY', POWER: 'ELECTRICITY', PETROL: 'FUEL',
};

/** The movement kind a free string names, or null (unknown kinds mean "all", never an invented one). */
export function normaliseKind(kind) {
  const k = String(kind || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!k) return null;
  if (MOVEMENT_KINDS.includes(k)) return k;
  if (KIND_ALIASES[k]) return KIND_ALIASES[k];
  const singular = k.replace(/S$/, '');
  return MOVEMENT_KINDS.includes(singular) ? singular : (KIND_ALIASES[singular] || null);
}

/** The inclusive start of the range in SAST, or null for 'all'. */
export function rangeStart(range, now = new Date()) {
  const r = String(range || 'all').toLowerCase();
  if (r === 'today') {
    const local = now.getTime() + SAST_OFFSET_MS;
    return new Date(Math.floor(local / DAY_MS) * DAY_MS - SAST_OFFSET_MS);
  }
  if (r === 'week') return new Date(now.getTime() - 7 * DAY_MS);
  if (r === 'month') return new Date(now.getTime() - 30 * DAY_MS);
  return null;
}

/** Pure: filter and total a movement list. Exported for tests. */
export function summariseMovements(movements, { range = 'all', kind = null, now = new Date() } = {}) {
  const start = rangeStart(range, now);
  const wanted = normaliseKind(kind);
  const list = (Array.isArray(movements) ? movements : [])
    .filter((mv) => mv && (!start || (mv.at instanceof Date && mv.at.getTime() >= start.getTime())))
    .filter((mv) => !wanted || mv.kind === wanted)
    .slice()
    .sort((a, b) => (b.at?.getTime?.() || 0) - (a.at?.getTime?.() || 0));

  const totals = { count: 0, sumCents: 0, feeCents: 0, byKind: {} };
  let pendingCount = 0;
  let failedCount = 0;
  for (const mv of list) {
    if (mv.status === 'SUCCESS') {
      totals.count += 1;
      totals.sumCents += toCents(mv.amountCents);
      totals.feeCents += toCents(mv.feeCents);
      const k = totals.byKind[mv.kind] || (totals.byKind[mv.kind] = { count: 0, sumCents: 0 });
      k.count += 1;
      k.sumCents += toCents(mv.amountCents);
    } else if (mv.status === 'PENDING' || mv.status === 'OPEN') pendingCount += 1;
    else failedCount += 1;
  }

  const rows = list.slice(0, MAX_ROWS).map((mv) => ({
    kind: mv.kind,
    amountCents: toCents(mv.amountCents),
    feeCents: toCents(mv.feeCents),
    status: mv.status,
    counterparty: mv.counterparty || null,
    reference: mv.reference || null,
    note: mv.note || null,
    at: iso(mv.at),
  }));

  return {
    range: TRANSACTION_RANGES.includes(String(range)) ? String(range) : 'all',
    kind: wanted,
    since: start ? start.toISOString() : null,
    rows,
    matched: list.length,
    shown: rows.length,
    totals,
    pendingCount,
    failedCount,
    note: 'totals cover completed (SUCCESS) movements only; pending and failed ones are counted separately.',
  };
}

async function getTransactions(args, ctx) {
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  let pack = ctx.pack || null;
  const complete = pack && Array.isArray(pack.movements) && toCents(pack.movementsTotal) <= pack.movements.length;
  if (!complete && ctx.prisma && ctx.account) {
    pack = await loadContextPack({ prisma: ctx.prisma, account: ctx.account, now, movementLimit: 50 });
  }
  if (!pack) return { ok: false, error: 'NO_RECORD' };
  const result = summariseMovements(pack.movements, { range: args.range, kind: args.kind, now });
  result.truncated = toCents(pack.movementsTotal) > (pack.movements || []).length;
  return { ok: true, result };
}

// ---------------------------------------------------------------------------
// get_products
// ---------------------------------------------------------------------------

const NETWORKS = [
  ['VODACOM', /voda/i], ['MTN', /\bmtn\b/i], ['CELLC', /cell\s*c/i], ['TELKOM', /telkom/i],
];

export function networkCodeFor(network) {
  const s = String(network || '');
  if (!s.trim()) return null;
  for (const [code, re] of NETWORKS) if (re.test(s)) return code;
  return null;
}

const priceOf = (p) => toCents(p.fixedPriceCents || p.priceCents);

function productView(p) {
  return {
    id: p.id,
    name: p.label || p.name || '',
    priceCents: priceOf(p),
    minCents: p.minCents != null ? toCents(p.minCents) : null,
    maxCents: p.maxCents != null ? toCents(p.maxCents) : null,
    network: p.networkCode || null,
    category: p.category || null,
    validityDays: p.validityDays ?? null,
  };
}

async function getProducts(args, ctx) {
  const category = String(args.category || '').toUpperCase();
  if (!PRODUCT_CATEGORIES.includes(category)) return { ok: false, error: 'BAD_CATEGORY' };
  const networkCode = networkCodeFor(args.network);
  const queryText = args.query ? String(args.query).slice(0, 120) : undefined;

  let products;
  if (ctx.prisma && ctx.prisma.vasProduct) {
    // The same query and ranking as lib/vas-search.js searchProducts, on the
    // injected client so the turn (and the tests) never reach for a global.
    const rows = await ctx.prisma.vasProduct.findMany({
      where: { active: true, category, ...(networkCode ? { networkCode } : {}) },
      take: 200,
    });
    const fixed = rankProducts(rows, { queryText }).map((r) => r.product);
    // Variable-amount products (airtime, electricity) have no price to rank by; keep them after the fixed ones.
    const variable = rows.filter((p) => priceOf(p) <= 0 && p.minCents != null);
    products = [...fixed, ...variable];
  } else {
    products = await searchProducts({ category, networkCode: networkCode || undefined, queryText, limit: MAX_PRODUCTS });
  }
  return {
    ok: true,
    result: {
      category,
      network: networkCode,
      query: queryText || null,
      products: products.slice(0, MAX_PRODUCTS).map(productView),
    },
  };
}

// ---------------------------------------------------------------------------
// get_fee_quote
// ---------------------------------------------------------------------------

function getFeeQuote(args, ctx) {
  const kind = FEE_KINDS.includes(String(args.kind)) ? String(args.kind) : 'general';
  const amountCents = Number.isInteger(args.amountCents) && args.amountCents > 0 ? args.amountCents : null;
  const withdrawLive = payoutAllowedFor(ctx.waId);
  const schedule = JSON.parse(JSON.stringify(feeSchedule({ withdrawLive }), (_k, v) => (v === Infinity ? null : v)));
  return { ok: true, result: { kind, amountCents, text: feeAnswer(kind, amountCents, { withdrawLive }), schedule } };
}

// ---------------------------------------------------------------------------
// where_accepted
// ---------------------------------------------------------------------------

function whereAccepted(args) {
  const facts = ottAcceptedFacts();
  const merchant = args.merchant ? String(args.merchant).slice(0, 80) : '';
  if (!merchant.trim()) {
    return { ok: true, result: { accepted: null, name: null, note: `OTT vouchers are sold at ${OTT_SOLD_AT}.`, facts } };
  }
  const hit = lookupOttMerchant(merchant);
  if (!hit) {
    // Unknown names are never claimed and never echoed: the customer's own
    // wording could be a name the reply may not carry.
    return { ok: true, result: { accepted: null, name: null, note: 'Not a partner WaPay lists; the live list is on ottvoucher.com.', facts } };
  }
  const note = hit.accepted
    ? `${hit.name} takes OTT vouchers for ${hit.what}${hit.how ? ` (${hit.how})` : ''}.`
    : `${hit.name} does not take OTT vouchers as payment${hit.sells ? ', although it sells them at the till' : ''}.${hit.note ? ` ${hit.note.charAt(0).toUpperCase()}${hit.note.slice(1)}.` : ''}`;
  return { ok: true, result: { accepted: !!hit.accepted, name: hit.name, note, facts } };
}

// ---------------------------------------------------------------------------
// get_payout_status
// ---------------------------------------------------------------------------

const STATUS_MAP = { SUCCESS: 'SUCCESS', SETTLED: 'SUCCESS', FAILED: 'FAILED', RELEASED: 'FAILED', PENDING: 'PENDING', INIT: 'PENDING' };
const normaliseStatus = (s) => STATUS_MAP[String(s || '').toUpperCase()] || 'PENDING';

function payoutClient(ctx) {
  if (ctx.payoutClient) return ctx.payoutClient;
  try { return new OttPayoutClient({ timeoutMs: PAYOUT_PROBE_TIMEOUT_MS }); } catch { return null; }
}

async function getPayoutStatus(args, ctx) {
  const wanted = args.reference ? String(args.reference).trim() : null;
  const accountId = ctx.account?.id || ctx.pack?.accountId || null;
  const pending = ctx.pack?.pendingPayout || null;

  let row = null;
  if (pending && (!wanted || pending.reference === wanted)) {
    row = { reference: pending.reference, method: pending.method, amountCents: pending.amountCents, feeCents: pending.feeCents, status: 'PENDING', createdAt: pending.at };
  } else if (ctx.prisma && accountId) {
    if (wanted) {
      const found = await ctx.prisma.providerRequest.findFirst({
        where: { accountId, route: 'ott-payout', metadata: { path: ['reference'], equals: wanted } },
        orderBy: { requestTs: 'desc' },
      });
      if (found) {
        const m = found.metadata && typeof found.metadata === 'object' ? found.metadata : {};
        row = { reference: m.reference || wanted, method: m.method || null, amountCents: m.amountCents ?? null, feeCents: m.feeCents ?? null, status: found.status, createdAt: found.requestTs };
      }
    } else {
      row = await getLatestPayout({ prisma: ctx.prisma, accountId });
    }
  }
  if (!row) return { ok: true, result: { status: 'NONE', reference: wanted, amountCents: null, feeCents: null, method: null, checked: false, note: wanted ? 'no withdrawal with that reference on this account' : 'no withdrawal on this account yet' } };

  const base = {
    status: normaliseStatus(row.status),
    reference: row.reference || null,
    amountCents: row.amountCents != null ? toCents(row.amountCents) : null,
    feeCents: row.feeCents != null ? toCents(row.feeCents) : null,
    method: row.method || null,
    startedAt: iso(row.createdAt),
    checked: false,
  };
  if (base.status !== 'PENDING' || !base.reference || !ctx.prisma) return { ok: true, result: base };

  // Still pending: ask the rail what became of it. GetPaymentStatus only.
  const client = payoutClient(ctx);
  if (!client) return { ok: true, result: { ...base, note: 'the bank rail could not be asked right now' } };
  const out = await reconcilePayout({ prisma: ctx.prisma, client, reference: base.reference });
  return {
    ok: true,
    result: {
      ...base,
      status: out?.ok ? normaliseStatus(out.status) : base.status,
      checked: !!out?.checked,
      providerStatus: out?.providerStatus ?? null,
      outcome: out?.outcome || null,
    },
  };
}

// ---------------------------------------------------------------------------
// get_pay_links
// ---------------------------------------------------------------------------

function getPayLinks(_args, ctx) {
  const pack = ctx.pack || {};
  const open = (Array.isArray(pack.openPayLinks) ? pack.openPayLinks : []).map((l) => ({
    code: l.code, amountCents: toCents(l.amountCents), note: l.note || null, createdAt: iso(l.createdAt), expiresAt: iso(l.expiresAt),
  }));
  const recent = (Array.isArray(pack.movements) ? pack.movements : [])
    .filter((mv) => mv.kind === 'PAY_LINK' && mv.status !== 'OPEN')
    .slice(0, 10)
    .map((mv) => ({ code: mv.reference, amountCents: toCents(mv.amountCents), status: mv.status, payer: mv.counterparty || null, at: iso(mv.at), note: mv.note || null }));
  return { ok: true, result: { open, recent } };
}

// ---------------------------------------------------------------------------
// how_it_works
// ---------------------------------------------------------------------------

function howItWorks(args, ctx) {
  const topic = String(args.topic || '');
  if (!TOPICS[topic]) return { ok: false, error: 'UNKNOWN_TOPIC' };
  const text = howItWorksAnswer(topic, {
    wicodeLive: fuelLiveFor(ctx.waId),
    withdrawLive: payoutAllowedFor(ctx.waId),
    fuelPartners: advertisedFuelPartners().map((p) => p.name),
    ottFacts: ottAcceptedFacts(),
  });
  return { ok: true, result: { topic, text } };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const HANDLERS = {
  get_transactions: getTransactions,
  get_products: getProducts,
  get_fee_quote: getFeeQuote,
  where_accepted: whereAccepted,
  get_payout_status: getPayoutStatus,
  get_pay_links: getPayLinks,
  how_it_works: howItWorks,
};

export const READ_TOOL_NAMES = Object.freeze(Object.keys(HANDLERS));

/** Run one read tool. Never throws. */
export async function executeReadTool(name, args = {}, ctx = {}) {
  const fn = HANDLERS[name];
  if (!fn) return { ok: false, error: 'UNKNOWN_TOOL' };
  try {
    const out = await fn(args && typeof args === 'object' ? args : {}, ctx || {});
    return out && typeof out === 'object' ? out : { ok: false, error: 'EMPTY' };
  } catch (e) {
    return { ok: false, error: String(e?.code || e?.message || e).slice(0, 160) };
  }
}
