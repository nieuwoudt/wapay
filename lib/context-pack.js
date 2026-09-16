/**
 * Context pack: the per-customer record read on every conversational turn
 * ("the moat"). One Promise.all batch over the source tables the admin CRM
 * already reads (pages/api/admin/customer.js), normalised into a single list
 * of movements the brain can quote from, plus balances, the pending pay-out
 * with its held amount, open pay links, vouchers waiting and saved people.
 *
 * Invariants:
 * - READ-ONLY. Nothing here writes; balances are read from the ledger's
 *   wallets, never computed.
 * - Every sub-query is best-effort: a failure yields an empty part and a
 *   pack.warnings entry, never a throw. The chat turn must not die because
 *   one table is slow.
 * - voucherPin is a BEARER SECRET and is NEVER selected (constitution #8).
 * - Amounts are integer cents. Counterparties are masked (083…4421).
 * - The AI still never states a balance or a status on its own authority:
 *   this pack is what the deterministic status answers quote from.
 *
 * Source facts (2026-09-16):
 * - Card deposits: providerRequest route 'deposit' (lib/deposits.js),
 *   status PENDING|SUCCESS|FAILED, metadata { amountCents, feeCents,
 *   grossCents }, providerRef = PayFast pf_payment_id.
 * - Pay-outs: route 'ott-payout' (lib/payouts.js), status
 *   INIT|PENDING|SUCCESS|FAILED, metadata { method, amountCents, feeCents,
 *   reference, recipient: { name, mobile, account } (already masked) }; the
 *   ledger hold's idemKey is `${row.idemKey}-hold`.
 * - Airtime/data/electricity/fuel/voucher vends: routes 'airtime-preview',
 *   'data-preview', 'fuel-preview', 'voucher-preview' (electricity previews
 *   carry metadata.meterNumber); PENDING = an unexecuted quote (not a
 *   movement), EXECUTING|RECONCILE = in flight, SUCCESS|FAILED terminal.
 * - OTT voucher loads: route 'ott-redeem' (message-processor), status
 *   PENDING|REMITTED|RECONCILE|SUCCESS|FAILED, metadata { valueCents, serial }.
 * - Pay links: paymentRequest PENDING|PAID|CANCELLED|EXPIRED, payerRef
 *   'WAPAY:<accountId>' | 'PAYFAST:<pf id>'.
 * - Sends: pendingGift ISSUED|DELIVERED|CANCELLED; a voucher send's gift row
 *   has idemKey `wapay-vgift-gift-<previewId>`, a fuel wiCode's
 *   `wapay-fuel-gift-<previewId>` (both are the customer's own purchase).
 */

import { normaliseMsisdn } from './msisdn.js';

export const RECORD_HEADER = 'KNOWN CUSTOMER FACTS (from the ledger, this turn; quote these numbers, never others):';
export const RECORD_MAX_CHARS = 1800;
export const MOVEMENT_KINDS = Object.freeze([
  'DEPOSIT', 'PAYOUT', 'AIRTIME', 'DATA', 'ELECTRICITY', 'FUEL', 'SEND', 'GIFT_RECEIVED', 'PAY_LINK', 'VOUCHER_LOAD',
]);
export const STATUS_KINDS = Object.freeze(['DEPOSIT', 'PAYOUT', 'SEND', 'PAY_LINK', 'VOUCHER_LOAD']);

const TZ = 'Africa/Johannesburg';
const DAY_MS = 24 * 3600 * 1000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Integer cents from anything the row might hold; never a float, never NaN. */
export function toCents(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** R12 or R12.50 (negative as -R12.50). */
export function formatRands(cents) {
  const c = toCents(cents);
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100);
  const minor = abs % 100;
  return minor === 0 ? `${sign}R${whole}` : `${sign}R${whole}.${String(minor).padStart(2, '0')}`;
}

export function tail9(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : null;
}

/** 083…4421 from any SA number shape; '' when there is nothing to mask. */
export function maskMsisdn(raw = '') {
  const m = normaliseMsisdn(raw);
  if (!m || m.length < 7) return '';
  return `${m.slice(0, 3)}…${m.slice(-4)}`;
}

function tail4(v) {
  const s = String(v || '');
  return s.length > 4 ? `…${s.slice(-4)}` : s;
}

function asDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (v == null) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function meta(row) {
  return row && row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
}

/** "16 Sep 09:12" in SAST; year appended when it is not the current one. */
export function formatSast(date, now = new Date()) {
  const d = asDate(date);
  if (!d) return '';
  // en-US for the month: newer ICU renders en-ZA/en-GB September as "Sept".
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  const nowYear = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric' }).format(now);
  const year = get('year');
  const hour = get('hour') === '24' ? '00' : get('hour');
  const day = `${get('day')} ${get('month')}${year !== nowYear ? ` ${year}` : ''}`;
  return `${day} ${hour}:${get('minute')}`;
}

// ---------------------------------------------------------------------------
// Status normalisation
// ---------------------------------------------------------------------------

/** providerRequest.status → SUCCESS|PENDING|FAILED. Unknown reads as PENDING: never claim success by accident. */
export function normaliseProviderStatus(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'SUCCESS') return 'SUCCESS';
  if (s === 'FAILED' || s === 'ERROR') return 'FAILED';
  if (s === 'CANCELLED') return 'CANCELLED';
  if (s === 'EXPIRED') return 'EXPIRED';
  return 'PENDING';
}

function normaliseRequestStatus(row, now) {
  const s = String(row.status || '').toUpperCase();
  if (s === 'PAID') return 'SUCCESS';
  if (s === 'CANCELLED') return 'CANCELLED';
  if (s === 'EXPIRED') return 'EXPIRED';
  const exp = asDate(row.expiresAt);
  if (s === 'PENDING' && exp && exp.getTime() < now.getTime()) return 'EXPIRED';
  return 'OPEN';
}

function maskPayerRef(payerRef) {
  const s = String(payerRef || '');
  if (!s) return null;
  if (s.startsWith('WAPAY:')) return 'a WaPay customer';
  if (s.startsWith('PAYFAST:')) return `card ${tail4(s.slice('PAYFAST:'.length))}`;
  if (s.startsWith('ADUMO:')) return `card ${tail4(s.slice('ADUMO:'.length))}`;
  return 'card';
}

const VAS_ROUTES = {
  'airtime-preview': 'AIRTIME',
  'airtime-execute': 'AIRTIME',
  'data-preview': 'DATA',
  'data-execute': 'DATA',
  'electricity-preview': 'ELECTRICITY',
  'electricity-execute': 'ELECTRICITY',
  'fuel-preview': 'FUEL',
  'voucher-preview': 'SEND',
};

function kindForRow(row) {
  const route = String(row.route || '');
  if (route === 'deposit') return 'DEPOSIT';
  if (route === 'ott-payout') return 'PAYOUT';
  if (route === 'ott-redeem') return 'VOUCHER_LOAD';
  if (VAS_ROUTES[route]) return VAS_ROUTES[route];
  if (meta(row).meterNumber != null) return 'ELECTRICITY';
  return null; // 'payrequest' rows are covered by paymentRequest; unknown routes are not invented
}

// ---------------------------------------------------------------------------
// Row → movement
// ---------------------------------------------------------------------------

function movementFromProviderRow(row, { ownTail, giftsByPreviewId }) {
  const kind = kindForRow(row);
  if (!kind) return null;
  const m = meta(row);
  const raw = String(row.status || '').toUpperCase();
  const at = asDate(row.requestTs) || asDate(row.createdAt) || new Date(0);
  const source = { table: 'providerRequest', id: row.id };
  const base = { kind, amountCents: 0, feeCents: 0, status: normaliseProviderStatus(raw), counterparty: null, reference: null, at, source, note: '' };

  if (kind === 'DEPOSIT') {
    return {
      ...base,
      amountCents: toCents(m.amountCents ?? m.grossCents),
      feeCents: toCents(m.feeCents),
      counterparty: 'PayFast',
      reference: row.providerRef || null,
      note: base.status === 'PENDING' ? 'card deposit, no confirmation from PayFast yet' : 'card deposit',
    };
  }
  if (kind === 'PAYOUT') {
    const r = m.recipient && typeof m.recipient === 'object' ? m.recipient : {};
    const method = m.method === 'PAYSHAP' ? 'PayShap' : (m.method || 'bank');
    const who = [r.name, r.account ? `acc ${r.account}` : null].filter(Boolean).join(' ');
    return {
      ...base,
      amountCents: toCents(m.amountCents),
      feeCents: toCents(m.feeCents),
      counterparty: who || null,
      reference: m.reference || null,
      note: base.status === 'PENDING'
        ? `${method} pay-out, waiting on the bank rail${m.reconcileRequired ? ' (being checked)' : ''}`
        : `${method} pay-out`,
      method: m.method || null,
      reconcileRequired: !!m.reconcileRequired,
      providerStatus: m.lastProviderStatus ?? m.providerStatus ?? null,
    };
  }
  if (kind === 'VOUCHER_LOAD') {
    return {
      ...base,
      amountCents: toCents(m.valueCents ?? m.amountCents),
      counterparty: 'OTT voucher',
      reference: m.serial ? tail4(m.serial) : (row.providerRef ? tail4(row.providerRef) : null),
      note: base.status === 'PENDING' ? 'voucher load being confirmed with OTT' : 'voucher loaded to balance',
    };
  }

  // VAS vends: a PENDING row is an unexecuted quote, not a movement.
  if (raw === 'PENDING' || raw === '') return null;
  const total = m.totalCents != null ? toCents(m.totalCents) : null;
  if (kind === 'AIRTIME' || kind === 'DATA') {
    const amount = kind === 'DATA' ? toCents(m.priceCents ?? m.amountCents) : toCents(m.amountCents);
    const target = m.msisdn ? (tail9(m.msisdn) === ownTail ? 'own number' : maskMsisdn(m.msisdn)) : null;
    return {
      ...base,
      amountCents: amount,
      feeCents: total != null ? Math.max(0, total - amount) : 0,
      counterparty: target,
      reference: row.providerRef || null,
      note: kind === 'DATA' ? String(m.productName || `${m.vendorName || ''} data`).trim() : `${m.vendorName || ''} airtime`.trim(),
    };
  }
  if (kind === 'ELECTRICITY') {
    const amount = toCents(m.amountCents);
    return {
      ...base,
      amountCents: amount,
      feeCents: m.serviceFee != null ? toCents(m.serviceFee) : (total != null ? Math.max(0, total - amount) : 0),
      counterparty: m.meterNumber ? `meter ${tail4(m.meterNumber)}` : null,
      reference: row.providerRef || m.reference || null,
      note: `${m.municipalityName || m.utility || 'prepaid'} electricity`.trim(),
    };
  }
  if (kind === 'FUEL') {
    return {
      ...base,
      amountCents: toCents(m.amountCents),
      feeCents: toCents(m.feeCents),
      counterparty: 'fuel voucher',
      reference: row.providerRef || null,
      note: base.status === 'PENDING' ? 'fuel voucher being confirmed' : 'fuel voucher',
    };
  }
  // SEND via the voucher route: merge the gift row's delivery state when we have it.
  const gift = giftsByPreviewId.get(row.id);
  const recipient = m.recipientMsisdn || gift?.recipientMsisdn;
  const self = recipient && tail9(recipient) === ownTail;
  let note = 'money sent as a voucher';
  if (base.status === 'SUCCESS' && gift) note = gift.status === 'DELIVERED' ? 'voucher sent and claimed' : gift.status === 'CANCELLED' ? 'voucher cancelled' : 'voucher sent, not yet claimed';
  return {
    ...base,
    amountCents: toCents(m.amountCents),
    feeCents: toCents(m.feeCents),
    counterparty: recipient ? (self ? 'yourself' : maskMsisdn(recipient)) : null,
    reference: gift?.voucherSerial ? tail4(gift.voucherSerial) : (row.providerRef ? tail4(row.providerRef) : null),
    note,
  };
}

function movementFromGift(g, { direction, ownTail }) {
  const s = String(g.status || '').toUpperCase();
  const at = asDate(g.createdAt) || new Date(0);
  const self = tail9(g.recipientMsisdn) === ownTail && direction === 'sent';
  if (direction === 'sent') {
    return {
      kind: 'SEND',
      amountCents: toCents(g.amountCents),
      feeCents: 0,
      status: s === 'CANCELLED' ? 'CANCELLED' : 'SUCCESS',
      counterparty: self ? 'yourself' : maskMsisdn(g.recipientMsisdn),
      reference: g.voucherSerial ? tail4(g.voucherSerial) : null,
      at,
      source: { table: 'pendingGift', id: g.id },
      note: s === 'DELIVERED' ? 'voucher sent and claimed' : s === 'CANCELLED' ? 'voucher cancelled' : 'voucher sent, not yet claimed',
    };
  }
  return {
    kind: 'GIFT_RECEIVED',
    amountCents: toCents(g.amountCents),
    feeCents: 0,
    status: s === 'DELIVERED' ? 'SUCCESS' : s === 'CANCELLED' ? 'CANCELLED' : 'PENDING',
    counterparty: null,
    reference: g.voucherSerial ? tail4(g.voucherSerial) : null,
    at,
    source: { table: 'pendingGift', id: g.id },
    note: s === 'DELIVERED' ? 'voucher received and loaded' : s === 'CANCELLED' ? 'voucher cancelled by sender' : 'voucher waiting to be claimed',
  };
}

function movementFromRequest(r, now) {
  const status = normaliseRequestStatus(r, now);
  const at = asDate(r.paidAt) || asDate(r.createdAt) || new Date(0);
  const noteText = String(r.note || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return {
    kind: 'PAY_LINK',
    amountCents: toCents(r.amountCents),
    feeCents: 0,
    status,
    counterparty: maskPayerRef(r.payerRef),
    reference: r.id || null,
    at,
    source: { table: 'paymentRequest', id: r.id },
    note: status === 'SUCCESS' ? `pay link paid${noteText ? ` (${noteText})` : ''}`
      : status === 'OPEN' ? `pay link open${noteText ? ` (${noteText})` : ''}`
        : `pay link ${status.toLowerCase()}`,
  };
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

const GIFT_SELECT = Object.freeze({
  id: true, senderAccountId: true, recipientMsisdn: true, amountCents: true, rail: true, status: true,
  voucherSerial: true, idemKey: true, createdAt: true, deliveredAt: true,
  // voucherPin DELIBERATELY not selected: bearer secret (constitution #8).
});

/**
 * Load the customer record. ONE Promise.all over every source table: each
 * query is started before any is awaited, and each is best-effort.
 */
export async function loadContextPack({ prisma, account, now = new Date(), movementLimit = 10, turns = [] }) {
  const warnings = [];
  const accountId = account?.id || null;
  const ownTail = tail9(account?.msisdn) || tail9(account?.waId) || null;
  const profile = account?.profile && typeof account.profile === 'object' ? account.profile : {};

  const part = (label, run, fallback) => {
    let p;
    try { p = Promise.resolve(run()); } catch (e) { p = Promise.reject(e); }
    return p.catch((e) => { warnings.push(`${label}: ${e?.message || String(e)}`); return fallback; });
  };

  const recipientShapes = ownTail ? [`0${ownTail}`, `27${ownTail}`, `+27${ownTail}`] : [];
  const [wallets, holds, providerRows, sentGifts, receivedGifts, requests, pendingRowDirect, beneficiaries] = await Promise.all([
    part('wallets', () => prisma.wallet.findMany({
      where: { accountId },
      select: { balanceType: true, availableCents: true, pendingCents: true, updatedAt: true },
    }), []),
    part('holds', () => prisma.hold.findMany({
      where: { wallet: { accountId }, status: 'ACTIVE' },
      select: { id: true, idemKey: true, amountCents: true, reason: true, createdAt: true, wallet: { select: { balanceType: true } } },
    }), []),
    part('providerRequests', () => prisma.providerRequest.findMany({
      where: { accountId },
      select: { id: true, provider: true, route: true, idemKey: true, status: true, providerRef: true, requestTs: true, metadata: true },
      orderBy: { requestTs: 'desc' },
      take: 40,
    }), []),
    part('giftsSent', () => prisma.pendingGift.findMany({
      where: { senderAccountId: accountId },
      select: GIFT_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 20,
    }), []),
    part('giftsReceived', () => (ownTail ? prisma.pendingGift.findMany({
      // The exact shapes the gift rows store, so the (recipientMsisdn, status)
      // index serves the query instead of a suffix scan.
      where: { recipientMsisdn: { in: recipientShapes } },
      select: GIFT_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 20,
    }) : []), []),
    part('paymentRequests', () => prisma.paymentRequest.findMany({
      where: { accountId },
      select: { id: true, amountCents: true, note: true, status: true, payerRef: true, createdAt: true, paidAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }), []),
    // The pending pay-out is looked up directly: it must surface even when
    // forty newer previews have pushed it out of the capped list above.
    part('pendingPayout', () => prisma.providerRequest.findFirst({
      where: { accountId, route: 'ott-payout', status: { in: ['PENDING', 'INIT'] } },
      select: { id: true, provider: true, route: true, idemKey: true, status: true, providerRef: true, requestTs: true, metadata: true },
      orderBy: { requestTs: 'desc' },
    }), null),
    part('beneficiaries', () => prisma.beneficiary.findMany({
      where: { accountId },
      select: { name: true, msisdn: true, lastUsedAt: true },
      orderBy: { lastUsedAt: 'desc' },
      take: 10,
    }), []),
  ]);

  // Balances: what the ledger says, plus what is locked in ACTIVE holds.
  const wallet = (t) => (Array.isArray(wallets) ? wallets : []).find((w) => w.balanceType === t);
  const heldBy = (t) => (Array.isArray(holds) ? holds : [])
    .filter((h) => (h.wallet?.balanceType || 'SPEND') === t)
    .reduce((sum, h) => sum + toCents(h.amountCents), 0);
  const balances = {
    spendCents: toCents(wallet('SPEND')?.availableCents),
    cashCents: toCents(wallet('CASH')?.availableCents),
    heldSpendCents: heldBy('SPEND'),
    heldCashCents: heldBy('CASH'),
  };

  // Gifts: index the customer's own purchases so they are not shown twice.
  const sent = Array.isArray(sentGifts) ? sentGifts : [];
  const received = Array.isArray(receivedGifts) ? receivedGifts : [];
  const giftsByPreviewId = new Map();
  for (const g of sent) {
    const m = /^wapay-vgift-gift-(.+)$/.exec(String(g.idemKey || ''));
    if (m) giftsByPreviewId.set(m[1], g);
  }
  const rows = Array.isArray(providerRows) ? providerRows : [];
  const providerIds = new Set(rows.map((r) => r.id));
  const ownPurchase = (g) => {
    const k = String(g.idemKey || '');
    if (k.startsWith('wapay-fuel-gift-')) return true;
    const m = /^wapay-vgift-gift-(.+)$/.exec(k);
    return !!(m && providerIds.has(m[1]));
  };

  const movements = [];
  for (const row of rows) {
    const mv = movementFromProviderRow(row, { ownTail, giftsByPreviewId });
    if (mv) movements.push(mv);
  }
  const seenGiftIds = new Set();
  for (const g of sent) {
    if (ownPurchase(g)) continue;
    seenGiftIds.add(g.id);
    movements.push(movementFromGift(g, { direction: 'sent', ownTail }));
  }
  for (const g of received) {
    if (seenGiftIds.has(g.id) || String(g.idemKey || '').startsWith('wapay-fuel-gift-')) continue;
    if (g.senderAccountId && g.senderAccountId === accountId) continue; // a self-send already shown as SEND
    movements.push(movementFromGift(g, { direction: 'received', ownTail }));
  }
  const reqRows = Array.isArray(requests) ? requests : [];
  for (const r of reqRows) movements.push(movementFromRequest(r, now));

  movements.sort((a, b) => b.at.getTime() - a.at.getTime());

  // The pending pay-out is found over ALL pay-out rows, not the capped list.
  const pendingRow = pendingRowDirect || rows.find((r) => r.route === 'ott-payout' && normaliseProviderStatus(r.status) === 'PENDING');
  let pendingPayout = null;
  if (pendingRow) {
    const mv = movementFromProviderRow(pendingRow, { ownTail, giftsByPreviewId });
    const hold = (Array.isArray(holds) ? holds : []).find((h) =>
      h.idemKey === `${pendingRow.idemKey}-hold` || (mv.reference && String(h.reason || '').includes(mv.reference)));
    pendingPayout = {
      reference: mv.reference,
      method: mv.method,
      amountCents: mv.amountCents,
      feeCents: mv.feeCents,
      heldCents: hold ? toCents(hold.amountCents) : mv.amountCents + mv.feeCents,
      holdFound: !!hold,
      counterparty: mv.counterparty,
      at: mv.at,
      reconcileRequired: mv.reconcileRequired,
      providerStatus: mv.providerStatus,
      source: mv.source,
    };
  }

  const openPayLinks = reqRows
    .filter((r) => normaliseRequestStatus(r, now) === 'OPEN')
    .map((r) => ({ code: r.id, amountCents: toCents(r.amountCents), note: r.note || null, createdAt: asDate(r.createdAt), expiresAt: asDate(r.expiresAt) }));

  const vouchersWaiting = received.filter((g) =>
    String(g.status || '').toUpperCase() === 'ISSUED' && !String(g.idemKey || '').startsWith('wapay-fuel-gift-')).length;

  const people = (Array.isArray(beneficiaries) ? beneficiaries : [])
    .map((b) => ({ name: b.name || null, msisdnTail: String(b.msisdn || '').slice(-4) || null }));

  return {
    accountId,
    waId: account?.waId || null,
    msisdn: account?.msisdn || null,
    displayName: account?.displayName || null,
    language: profile.language || 'en',
    kyc: profile.kyc?.status || 'NOT_VERIFIED',
    balances,
    movements: movements.slice(0, Math.max(0, Number(movementLimit) || 0)),
    movementsTotal: movements.length,
    pendingPayout,
    openPayLinks,
    vouchersWaiting,
    beneficiaries: people,
    turns: Array.isArray(turns) ? turns : [],
    warnings,
    loadedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Rendering for the prompt
// ---------------------------------------------------------------------------

function movementLine(mv, now) {
  const bits = [`- ${formatSast(mv.at, now)}`, mv.kind, formatRands(mv.amountCents), mv.status];
  if (mv.counterparty) bits.push(mv.counterparty);
  if (mv.reference) bits.push(`ref ${mv.reference}`);
  return bits.join(' ');
}

/**
 * Plain-text block for the system prompt. Under RECORD_MAX_CHARS: the
 * movement list is truncated first, everything else always fits.
 */
export function renderCustomerRecord(pack, { now = new Date() } = {}) {
  const p = pack || {};
  const b = p.balances || {};
  const held = toCents(b.heldSpendCents) + toCents(b.heldCashCents);

  const head = [RECORD_HEADER];
  const who = p.displayName ? p.displayName : 'Customer';
  const num = p.msisdn ? ` (${maskMsisdn(p.msisdn)})` : '';
  head.push(`Name: ${who}${num}. Language: ${p.language || 'en'}. KYC: ${p.kyc || 'NOT_VERIFIED'}.`);
  // The spend balance is the only one a purchase can use; cash exists only
  // for withdrawals, so the two are never summed (review 2026-09-16).
  head.push(`Balance to spend: ${formatRands(b.spendCents)}${toCents(b.cashCents) > 0 ? `; cash balance (withdrawals only): ${formatRands(b.cashCents)}` : ''}; ${formatRands(held)} held${held > 0 ? ' for pending transactions' : ''}.`);
  if (p.pendingPayout) {
    const pp = p.pendingPayout;
    const method = pp.method === 'PAYSHAP' ? 'PayShap' : (pp.method || 'bank');
    head.push(`PENDING PAY-OUT: ${formatRands(pp.amountCents)} by ${method}${pp.counterparty ? ` to ${pp.counterparty}` : ''}, ref ${pp.reference || 'unknown'}, started ${formatSast(pp.at, now)}, ${formatRands(pp.heldCents)} (amount plus fee) is held until the bank rail answers.`);
  } else {
    head.push('Pending pay-out: none.');
  }

  const tail = [];
  const links = Array.isArray(p.openPayLinks) ? p.openPayLinks : [];
  tail.push(links.length
    ? `Open pay links: ${links.map((l) => `${l.code} ${formatRands(l.amountCents)}${l.expiresAt ? ` (expires ${formatSast(l.expiresAt, now)})` : ''}`).join('; ')}.`
    : 'Open pay links: none.');
  tail.push(`Vouchers waiting to be claimed: ${toCents(p.vouchersWaiting)}.`);
  // First names only, at most five: enough for "send R50 to Philly" to be
  // understood, no more of a third party's data than that.
  const names = (Array.isArray(p.beneficiaries) ? p.beneficiaries : []).map((x) => String(x.name || '').trim().split(/\s+/)[0]).filter(Boolean);
  tail.push(names.length ? `Saved people: ${[...new Set(names)].slice(0, 5).join(', ')}.` : 'Saved people: none.');

  const movements = Array.isArray(p.movements) ? p.movements : [];
  const lines = movements.map((mv) => movementLine(mv, now));
  const build = (n) => {
    const shown = lines.slice(0, n);
    const hidden = movements.length - n + Math.max(0, toCents(p.movementsTotal) - movements.length);
    const body = shown.length ? ['Recent activity (newest first):', ...shown] : ['Recent activity: none yet.'];
    if (hidden > 0 && shown.length) body.push(`- (${hidden} older not shown)`);
    return [...head, ...body, ...tail].join('\n');
  };
  let n = lines.length;
  let text = build(n);
  while (text.length > RECORD_MAX_CHARS && n > 0) { n -= 1; text = build(n); }
  return text.length > RECORD_MAX_CHARS ? text.slice(0, RECORD_MAX_CHARS) : text;
}

// ---------------------------------------------------------------------------
// "Did my payment go through": candidates + ranking
// ---------------------------------------------------------------------------

/** Money-in/out movements inside the window, newest first. */
export function statusCandidates(pack, { now = new Date(), withinMs = DAY_MS } = {}) {
  const since = now.getTime() - withinMs;
  return (Array.isArray(pack?.movements) ? pack.movements : [])
    .filter((mv) => STATUS_KINDS.includes(mv.kind) && mv.at instanceof Date && mv.at.getTime() >= since && mv.at.getTime() <= now.getTime() + 60_000)
    .slice()
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}

const KIND_HINTS = [
  ['PAYOUT', /\b(?:payshap|bank|withdr\w*|fnb|absa|nedbank|capitec|standard\s*bank|tyme\w*|atm|e-?wallet|pay-?out)\b/i],
  ['DEPOSIT', /\b(?:deposit\w*|card|payfast|top\s*-?up|topped\s*up|loaded|eft)\b/i],
  ['PAY_LINK', /\b(?:links?|request\w*|paid\s+me)\b/i],
  ['SEND', /\b(?:send|sent|voucher\w*)\b/i],
];

/** Which movement kind the sentence points at, or null when it says nothing. */
export function preferredKind(text = '') {
  const s = String(text || '');
  for (const [kind, re] of KIND_HINTS) if (re.test(s)) return kind;
  return null;
}

/** Reorder candidates so the kind the sentence names comes first; stable otherwise. */
export function rankCandidates(candidates, text = '') {
  const list = Array.isArray(candidates) ? candidates : [];
  const kind = preferredKind(text);
  if (!kind) return list.slice();
  return [...list.filter((c) => c.kind === kind), ...list.filter((c) => c.kind !== kind)];
}
