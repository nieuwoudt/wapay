/**
 * Card refunds into the books (2026-11-09, BUGLOG #146).
 *
 * When the founder refunds a card payment by hand in the PayFast or Adumo
 * merchant dashboard, the money goes back to the payer's card, but WaPay's
 * ledger was never told: the wallet kept the credit of the original
 * LOAD_PAYFAST / LOAD_ADUMO entry. This module books such a refund AFTER the
 * dashboard refund, never instead of it. It calls no processor API.
 *
 * One refund, in one database transaction:
 *   1. the exact mirror of the original card load (`buildReversal`, idemKey
 *      `card-refund-<original idemKey>`): the wallet gives back what it was
 *      credited, the deposit fee revenue is reversed, and the rail's clearing
 *      account gives back the gross the payer was charged (the payer gets the
 *      whole amount back, so WaPay keeps no fee). The processor's own cost was
 *      never booked per payment (FEES.load: the card fee is settled
 *      separately, in clearing), so there is no cost line to mirror; whatever
 *      PayFast or Adumo keeps on a refund appears when CLEARING:<rail> is
 *      reconciled to the settlement statement, exactly as their fees do today;
 *   2. the paid link the payment settled (payerRef `<RAIL>:<reference>`)
 *      becomes REFUNDED, so the link map, the metrics, business totals and
 *      the agent stop counting it as paid;
 *   3. the card intent keeps status SUCCESS (the processor did take the
 *      money) and gains `metadata.refund`, which the watchlist and the
 *      context pack read.
 * Then one audit row (event CARD_REFUND, its id derived from the reversal)
 * and one masked ops alert. The customer is sent nothing.
 *
 * Refused, with nothing written:
 *   NOT_A_CARD_LOAD           the entry is not LOAD_PAYFAST / LOAD_ADUMO
 *   ALREADY_REVERSED          the reversal exists (a second call only repairs
 *                             a missing mark, audit row or alert)
 *   SHORT                     the wallet's available balance cannot cover the
 *                             debit; the wallet is never driven negative
 *   NOT_THE_CREDITED_PAYMENT  the reference is a second charge for a link or
 *                             a top-up that was credited by another charge:
 *                             that charge never reached a balance, so its
 *                             refund needs no ledger move
 *   CONFIRM_ONLY_CHARGE       the books cannot prove which charge credited
 *                             (a payment from before the load carried its
 *                             reference, 2026-11-09): the operator confirms
 *                             with `onlyCharge: true` that the dashboard shows
 *                             one payment for that m_payment_id
 *   NEEDS_MIGRATION           the database still refuses REFUNDED on a link
 *                             (migration 20261109_payment_request_refunded)
 *   AMBIGUOUS / NOT_FOUND / REFERENCE_MISMATCH and bad input
 *
 * Which charge credited a load: the entry's externalRef (the ITN and
 * settleCardPayment write it on the first post since 2026-11-09; a replay never
 * changes it), else the paid link's payerRef `<RAIL>:<ref>`. The intent's own
 * providerRef is only a fallback for finding the entry: every delivery
 * overwrites it, so it never proves anything.
 *
 * Operator only (POST /api/internal/card-refund, internal key), never the
 * model, never a freeze or an approval: docs/GOLDEN_THREAD.md 2.15.
 */
import prismaDefault from './prisma.js';
import { buildReversal } from './ledger-core.js';
import { postEntry, walletDeltas } from './ledger-post.js';

export const CARD_LOAD_SOURCES = Object.freeze(['LOAD_PAYFAST', 'LOAD_ADUMO']);
const CARD_RAILS = ['PAYFAST', 'ADUMO'];
export const REFUND_IDEM_PREFIX = 'card-refund-';
export const REFUNDED_STATUS = 'REFUNDED';
export const CARD_REFUND_EVENT = 'CARD_REFUND';
export const REFUNDED_MIGRATION = '20261109_payment_request_refunded';

/** The reversal's idemKey: one refund per original card load, ever. */
export const refundIdemKeyFor = (originalIdemKey) => `${REFUND_IDEM_PREFIX}${originalIdemKey}`;
/** The audit row's id: one row per reversal, so a repair can never write a second. */
export const refundAuditIdFor = (reversalJournalEntryId) => `audit_card_refund_${reversalJournalEntryId}`;

// The shared pay-link idemKey (pages/api/pay/checkout.js): one per request code, on every rail.
const payreqKey = (code) => `wapay-payreq-${code}`;
const PAYREQ_KEY_RE = /^wapay-payreq-([A-Z]{6,12})$/;
const IDEM_RE = /^[A-Za-z0-9._:-]{3,160}$/;
// A link's payerRef that names the card charge which credited it. WAPAY:<id> is a balance payment; anything else
// (REPAIR:replayed from the balance leg's status repair, or null) names no charge.
const RAIL_REF_RE = /^(PAYFAST|ADUMO):(.+)$/;

const num = (v) => (v == null ? 0 : Number(v));
const R = (c) => `R${(Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tail4 = (n) => {
  const d = String(n || '').replace(/\D/g, '');
  return d.length >= 4 ? `•••${d.slice(-4)}` : null;
};
const refTail = (ref) => (ref ? `…${String(ref).slice(-4)}` : '');
/** Operator free text keeps no number whole: any run of 7 or more digits (spaces or dashes between) shows its last four. */
export const maskDigits = (s) => String(s ?? '').replace(/\+?\d(?:[\s-]?\d){6,}/g, (m) => `•••${m.replace(/\D/g, '').slice(-4)}`);
const sast = (d) => {
  try {
    return new Date(d).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '';
  }
};
const log = (type, data) => console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));

/** "PAYFAST:1234", " 1234 " → "1234"; null when it is not a plausible processor reference. */
export function normaliseProviderRef(raw) {
  const s = String(raw ?? '').trim().replace(/^(PAYFAST|ADUMO):/i, '');
  return /^[A-Za-z0-9._-]{1,100}$/.test(s) ? s : null;
}

/** The HTTP status for a refusal (pages/api/internal/card-refund.js). */
export function refusalStatus(refused) {
  if (['NO_REFERENCE', 'BAD_REFERENCE', 'BAD_IDEMKEY', 'NO_REASON'].includes(refused)) return 400;
  if (refused === 'NOT_FOUND') return 404;
  if (refused === 'NOT_A_CARD_LOAD' || refused === 'UNEXPECTED_SHAPE') return 422;
  if (refused === 'NEEDS_MIGRATION') return 503;
  return 409;
}

/**
 * Whether the database accepts REFUNDED on a payment request: true when its status check includes it (migration
 * 20261109_payment_request_refunded) or there is no check, false when the check predates it, null when unreadable.
 */
export async function refundedStatusAllowed(db) {
  if (typeof db?.$queryRaw !== 'function') return null;
  try {
    const rows = await db.$queryRaw`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'payment_requests_status_valid'`;
    if (!Array.isArray(rows) || !rows.length) return true;
    return rows.every((r) => String(r?.def || '').includes("'REFUNDED'"));
  } catch {
    return null;
  }
}

/** The charge that credited a card load, when the books can prove it; null when they cannot. Pure. */
export function creditingRef(entry, request) {
  if (entry?.externalRef) return { ref: normaliseProviderRef(entry.externalRef) || String(entry.externalRef), from: 'ENTRY' };
  const m = RAIL_REF_RE.exec(String(request?.payerRef || ''));
  return m ? { ref: m[2], from: 'LINK' } : null;
}

/** What the original card load moved: the gross charged, the wallet credit, the fee revenue. Pure. */
export function summariseLoad(postings = []) {
  let chargedCents = 0;
  let walletCreditCents = 0;
  let feeRevenueCents = 0;
  for (const p of postings) {
    const code = String(p.accountCode || '');
    if (code.startsWith('CLEARING:')) chargedCents += num(p.debitCents) - num(p.creditCents);
    else if (code.startsWith('WALLET:')) walletCreditCents += num(p.creditCents) - num(p.debitCents);
    else if (code.startsWith('REVENUE:FEE:')) feeRevenueCents += num(p.creditCents) - num(p.debitCents);
  }
  return { chargedCents, walletCreditCents, feeRevenueCents };
}

/**
 * Find the card load a reference or idemKey points at. A reference is matched
 * to the load that recorded it as its crediting charge, then to the paid link
 * it settled (payerRef), and only then to the intent, whose providerRef a
 * later charge for the same intent overwrites.
 */
async function locate(db, { providerRef, idemKey }) {
  const hasRef = providerRef != null && String(providerRef).trim() !== '';
  const hasKey = idemKey != null && String(idemKey).trim() !== '';
  if (!hasRef && !hasKey) return { refused: 'NO_REFERENCE' };
  const ref = hasRef ? normaliseProviderRef(providerRef) : null;
  if (hasRef && !ref) return { refused: 'BAD_REFERENCE' };
  const key = hasKey ? String(idemKey).trim() : null;
  if (hasKey && !IDEM_RE.test(key)) return { refused: 'BAD_IDEMKEY' };

  let originalKey = key;
  let intent = null;
  if (ref) {
    // 1. The card load that recorded this charge as the one that credited it (every card load since 2026-11-09).
    const stamped = await db.journalEntry.findMany({ where: { externalRef: ref, source: { in: [...CARD_LOAD_SOURCES] } }, select: { idemKey: true } });
    if (stamped.length > 1) return { refused: 'AMBIGUOUS', matches: stamped.length };
    if (stamped.length === 1) {
      originalKey = stamped[0].idemKey;
    } else {
      // 2. The paid link this charge settled.
      const paid = await db.paymentRequest.findMany({ where: { payerRef: { in: CARD_RAILS.map((r) => `${r}:${ref}`) } }, select: { id: true } });
      if (paid.length > 1) return { refused: 'AMBIGUOUS', matches: paid.length };
      if (paid.length === 1) {
        originalKey = payreqKey(paid[0].id);
      } else {
        // 3. The intent that last carried this reference: a finder only, every delivery overwrites it.
        const intents = await db.providerRequest.findMany({ where: { providerRef: ref, route: { in: ['deposit', 'payrequest'] } } });
        if (intents.length > 1) return { refused: 'AMBIGUOUS', matches: intents.length };
        if (!intents.length) return { refused: 'NOT_FOUND' };
        intent = intents[0];
        if (intent.route === 'payrequest') {
          const code = intent.metadata?.requestCode || PAYREQ_KEY_RE.exec(intent.idemKey || '')?.[1] || null;
          const request = code ? await db.paymentRequest.findUnique({ where: { id: code } }) : null;
          const payerRef = String(request?.payerRef || '');
          // The link was paid by another charge or from a balance (its payerRef names it): this charge was a second one.
          if (RAIL_REF_RE.test(payerRef) || payerRef.startsWith('WAPAY:')) {
            return {
              refused: 'NOT_THE_CREDITED_PAYMENT',
              requestCode: code,
              creditedBy: payerRef.startsWith('WAPAY:') ? 'a WaPay balance' : `card ${refTail(RAIL_REF_RE.exec(payerRef)[2])}`,
            };
          }
        }
        originalKey = intent.idemKey;
      }
    }
    if (key && key !== originalKey) return { refused: 'REFERENCE_MISMATCH' };
  }

  const entry = await db.journalEntry.findUnique({ where: { idemKey: originalKey }, include: { lines: true } });
  if (!entry) return { refused: 'NOT_FOUND' };
  if (!intent) intent = await db.providerRequest.findUnique({ where: { idemKey: originalKey } });
  return { entry, intent, ref };
}

/** Everything a dry run shows and a post needs. Reads only. */
async function prepare(db, { providerRef = null, idemKey = null, reason = null } = {}) {
  const found = await locate(db, { providerRef, idemKey });
  if (found.refused) {
    const { refused, ...detail } = found;
    return { plan: { ok: false, refused, ...detail } };
  }
  const { entry, intent } = found;

  const code = intent?.metadata?.requestCode || PAYREQ_KEY_RE.exec(entry.idemKey)?.[1] || null;
  const request = code ? await db.paymentRequest.findUnique({ where: { id: code } }) : null;
  const credit = creditingRef(entry, request);
  const providerRefOut = found.ref || credit?.ref || intent?.providerRef || null;
  const original = { journalEntryId: entry.id, idemKey: entry.idemKey, source: entry.source, createdAt: entry.createdAt, providerRef: providerRefOut };

  if (!CARD_LOAD_SOURCES.includes(entry.source)) return { plan: { ok: false, refused: 'NOT_A_CARD_LOAD', original } };
  // The books name another charge as the one that credited: the charge named here never reached a balance.
  if (found.ref && credit && credit.ref !== found.ref) {
    return { plan: { ok: false, refused: 'NOT_THE_CREDITED_PAYMENT', original, requestCode: request?.id || null, creditedBy: `card ${refTail(credit.ref)}` } };
  }
  const referenceCheck = credit ? credit.from : 'UNVERIFIED';

  const postings = (entry.lines || []).map((l) => ({
    accountCode: l.accountCode,
    debitCents: l.debitCents ? num(l.debitCents) : undefined,
    creditCents: l.creditCents ? num(l.creditCents) : undefined,
  }));
  const reversalIdemKey = refundIdemKeyFor(entry.idemKey);
  const reversal = buildReversal({
    original: { idemKey: entry.idemKey, source: entry.source, postings },
    idemKey: reversalIdemKey,
    reason: reason || 'card refunded in the processor dashboard',
  });
  const debits = walletDeltas(reversal.postings).filter((d) => d.deltaCents < 0);
  // A card load credits exactly one wallet; any other shape is not one this route knows how to undo.
  if (debits.length !== 1 || walletDeltas(reversal.postings).some((d) => d.deltaCents > 0)) {
    return { plan: { ok: false, refused: 'UNEXPECTED_SHAPE', original } };
  }
  const { accountId, balanceType } = debits[0];
  const debitCents = -debits[0].deltaCents;

  const [wallet, account, existing] = await Promise.all([
    db.wallet.findFirst({ where: { accountId, balanceType }, select: { availableCents: true, pendingCents: true } }),
    db.account.findUnique({ where: { id: accountId }, select: { waId: true } }),
    db.journalEntry.findUnique({ where: { idemKey: reversalIdemKey } }),
  ]);
  const amounts = summariseLoad(postings);

  const plan = {
    ok: true,
    original,
    rail: entry.source.slice('LOAD_'.length),
    accountId,
    phone: tail4(account?.waId),
    payer: tail4(intent?.metadata?.payerMsisdn),
    amounts: { ...amounts, walletDebitCents: debitCents, feeReversedCents: amounts.feeRevenueCents },
    wallet: { balanceType, availableCents: num(wallet?.availableCents), pendingCents: num(wallet?.pendingCents) },
    reversal: { idemKey: reversalIdemKey, source: reversal.source, postings: reversal.postings },
    paymentRequest: request ? { code: request.id, status: request.status, becomes: ['PAID', 'PENDING'].includes(request.status) ? REFUNDED_STATUS : request.status } : null,
    intent: intent ? { id: intent.id, route: intent.route, status: intent.status, refundFlagged: !!intent.metadata?.refund } : null,
    // ENTRY or LINK: the books name the charge that credited. UNVERIFIED: they cannot (older payments), so a POST
    // needs onlyCharge: true, the operator's word that the dashboard shows one payment for this intent.
    referenceCheck,
  };
  if (referenceCheck === 'UNVERIFIED') {
    plan.confirm = {
      field: 'onlyCharge',
      check: `the ${plan.rail === 'ADUMO' ? 'Adumo' : 'PayFast'} dashboard shows exactly one successful payment for ${intent ? `m_payment_id ${intent.id}` : `this entry (${entry.idemKey})`}, and it is the one you refunded`,
    };
  }
  const ctx = { entry, intent, request, reversal, accountId, balanceType, debitCents, existing };

  if (existing) {
    return { plan: { ...plan, ok: false, refused: 'ALREADY_REVERSED', existing: { journalEntryId: existing.id, createdAt: existing.createdAt } }, ctx };
  }
  if (plan.paymentRequest?.becomes === REFUNDED_STATUS && (await refundedStatusAllowed(db)) === false) {
    return { plan: { ...plan, ok: false, refused: 'NEEDS_MIGRATION', migration: REFUNDED_MIGRATION } };
  }
  if (!wallet) return { plan: { ...plan, ok: false, refused: 'NO_WALLET' } };
  if (num(wallet.availableCents) < debitCents) {
    return { plan: { ...plan, ok: false, refused: 'SHORT', shortCents: debitCents - num(wallet.availableCents) } };
  }
  plan.wallet = { ...plan.wallet, debitCents, afterCents: num(wallet.availableCents) - debitCents };
  return { plan, ctx };
}

/**
 * Dry run: what POST would reverse, or why it would refuse. Writes nothing.
 * @returns {Promise<object>} the plan; `ok` is true when a POST would post
 */
export async function planCardRefund({ prisma: db = prismaDefault, providerRef = null, idemKey = null } = {}) {
  return (await prepare(db, { providerRef, idemKey })).plan;
}

/** Inside the money transaction (or a repair): the link becomes REFUNDED, the intent gains its refund record. */
async function markRefunded(tx, ctx, refund) {
  const out = { requestMarked: false, intentFlagged: false };
  if (ctx.request) {
    // PENDING too: a credit whose PAID mark failed must not leave the link payable once its money is gone.
    const { count } = await tx.paymentRequest.updateMany({ where: { id: ctx.request.id, status: { in: ['PAID', 'PENDING'] } }, data: { status: REFUNDED_STATUS } });
    out.requestMarked = count === 1;
  }
  if (ctx.intent) {
    const fresh = await tx.providerRequest.findUnique({ where: { idemKey: ctx.intent.idemKey } });
    if (fresh && !fresh.metadata?.refund) {
      await tx.providerRequest.update({ where: { idemKey: ctx.intent.idemKey }, data: { metadata: { ...(fresh.metadata || {}), refund } } });
      out.intentFlagged = true;
    }
  }
  return out;
}

/** One audit row per reversal (deterministic id); `written` is false when it was already there. */
async function writeAudit(db, { reversalJournalEntryId, accountId, metadata }) {
  try {
    await db.auditLog.create({ data: { id: refundAuditIdFor(reversalJournalEntryId), accountId, event: CARD_REFUND_EVENT, metadata } });
    return { written: true };
  } catch (error) {
    if (error?.code === 'P2002') return { written: false, already: true };
    log('card_refund_audit_error', { reversalJournalEntryId, error: error?.message });
    return { written: false, error: error?.message };
  }
}

/** The ops line: masks and references only, never a full number (docs/GOLDEN_THREAD.md 1.7). Pure. */
export function cardRefundAlertText({ plan, reason, by, balanceAfterCents = null }) {
  const a = plan.amounts || {};
  const railName = plan.rail === 'ADUMO' ? 'Adumo' : 'PayFast';
  const when = plan.original?.createdAt ? `, ${sast(plan.original.createdAt)}` : '';
  const lines = [
    `↩️ Card refund booked: ${R(a.chargedCents)} charged by card (${railName} ${refTail(plan.original?.providerRef)}${when}) is reversed in the ledger.`,
    `Account ${String(plan.accountId || '').slice(0, 8)}…${plan.phone ? ` (${plan.phone})` : ''}: ${R(a.walletDebitCents)} off the balance${balanceAfterCents != null ? `, now ${R(balanceAfterCents)}` : ''}; fee revenue ${R(a.feeReversedCents)} reversed.`,
  ];
  if (plan.paymentRequest) lines.push(`Link ${plan.paymentRequest.code} is now ${plan.paymentRequest.becomes === REFUNDED_STATUS ? 'refunded' : String(plan.paymentRequest.status || '').toLowerCase()}.`);
  if (plan.referenceCheck === 'UNVERIFIED') lines.push('The books do not record which charge credited this payment; booked on the operator\'s word that it was the only one.');
  lines.push(`Reason: ${maskDigits(reason).slice(0, 200)}. By ${maskDigits(by || 'ops').slice(0, 40)}. No message went to the customer.`);
  return lines.join('\n');
}

async function raiseAlert({ db, deps, text, originalIdemKey }) {
  try {
    const send = deps.opsPersonAlert || (await import('./ops-alerts.js')).opsPersonAlert;
    return await send({ text, key: `card-refund:${originalIdemKey}`, prisma: db });
  } catch (error) {
    return { error: error?.message };
  }
}

/** A second call for a reversal that exists: finish whatever the first one did not (mark, audit, alert). */
async function repair(db, ctx, plan, { deps }) {
  const meta = ctx.existing?.metadata || {};
  const refund = {
    at: new Date(ctx.existing?.createdAt || Date.now()).toISOString(),
    by: meta.by || 'ops',
    reason: meta.reason || null,
    reversalIdemKey: ctx.existing?.idemKey || refundIdemKeyFor(ctx.entry.idemKey),
    providerRef: plan.original.providerRef,
    ...(meta.onlyChargeConfirmed === true ? { onlyChargeConfirmed: true } : {}),
  };
  const marks = await db.$transaction((tx) => markRefunded(tx, ctx, refund));
  const audit = await writeAudit(db, { reversalJournalEntryId: ctx.existing.id, accountId: ctx.accountId, metadata: auditMetadata(plan, refund, ctx.existing.id) });
  // Always asked: the alert's own key (opsPersonAlert, once per key) sends it only if the first call never did.
  const alert = await raiseAlert({ db, deps, text: cardRefundAlertText({ plan: { ...plan, paymentRequest: plan.paymentRequest && { ...plan.paymentRequest, becomes: REFUNDED_STATUS } }, reason: refund.reason, by: refund.by }), originalIdemKey: ctx.entry.idemKey });
  return { ...marks, auditWritten: audit.written, alert: { sent: alert?.sent ?? 0, skipped: alert?.skipped || null } };
}

function auditMetadata(plan, refund, reversalJournalEntryId) {
  return {
    reversalOf: plan.original.idemKey,
    reversalIdemKey: refund.reversalIdemKey,
    reversalJournalEntryId,
    source: plan.original.source,
    providerRef: plan.original.providerRef,
    requestCode: plan.paymentRequest?.code || null,
    chargedCents: plan.amounts.chargedCents,
    walletDebitCents: plan.amounts.walletDebitCents,
    feeReversedCents: plan.amounts.feeReversedCents,
    referenceCheck: plan.referenceCheck || null,
    onlyChargeConfirmed: refund.onlyChargeConfirmed === true,
    reason: refund.reason,
    by: refund.by,
  };
}

/**
 * Book a refund the founder already made in the processor dashboard.
 *
 * @param {object} args
 * @param {string} [args.providerRef] - the processor's payment reference (PayFast pf_payment_id, Adumo transaction id)
 * @param {string} [args.idemKey] - or the original LOAD entry's idemKey
 * @param {string} args.reason - required operator note, kept on the entry, the intent and the audit row (digit runs masked)
 * @param {string} [args.by] - operator label
 * @param {boolean} [args.onlyCharge] - the operator's word, needed only when the books cannot name the crediting
 *   charge (referenceCheck UNVERIFIED): the dashboard shows exactly one payment for this intent
 * @returns {Promise<object>} `{ ok: true, reversed: true, ... }` or `{ ok: false, refused, ... }`
 */
export async function postCardRefund({ prisma: db = prismaDefault, providerRef = null, idemKey = null, reason, by = 'ops', onlyCharge = false, now = new Date(), deps = {} } = {}) {
  const why = maskDigits(String(reason ?? '').trim()).slice(0, 200);
  if (!why) return { ok: false, refused: 'NO_REASON' };
  const who = maskDigits(String(by ?? '').trim()).slice(0, 40) || 'ops';

  const { plan, ctx } = await prepare(db, { providerRef, idemKey, reason: why });
  if (plan.refused === 'ALREADY_REVERSED') return { ...plan, repaired: await repair(db, ctx, plan, { deps }) };
  if (!plan.ok) return plan;
  if (plan.referenceCheck === 'UNVERIFIED' && onlyCharge !== true) return { ...plan, ok: false, refused: 'CONFIRM_ONLY_CHARGE' };

  const refund = { at: now.toISOString(), by: who, reason: why, reversalIdemKey: ctx.reversal.idemKey, providerRef: plan.original.providerRef, ...(plan.referenceCheck === 'UNVERIFIED' ? { onlyChargeConfirmed: true } : {}) };
  const entry = {
    ...ctx.reversal,
    externalRef: plan.original.providerRef,
    meta: { ...ctx.reversal.meta, kind: CARD_REFUND_EVENT, by: who, accountId: ctx.accountId, providerRef: plan.original.providerRef, requestCode: plan.paymentRequest?.code || null, ...(refund.onlyChargeConfirmed ? { onlyChargeConfirmed: true } : {}) },
  };

  let posted;
  let marks = { requestMarked: false, intentFlagged: false };
  try {
    posted = await db.$transaction(async (tx) => {
      // No allowNegative: the debit is the atomic check-and-decrement, so a balance spent since the dry run refuses here.
      const p = await postEntry(entry, { tx });
      if (!p.replayed) marks = await markRefunded(tx, ctx, refund);
      return p;
    });
  } catch (error) {
    if (error?.code === 'INSUFFICIENT_FUNDS') {
      const available = num(error.availableCents);
      return { ...plan, ok: false, refused: 'SHORT', wallet: { ...plan.wallet, availableCents: available, debitCents: undefined, afterCents: undefined }, shortCents: ctx.debitCents - available };
    }
    // The status check could not be read up front and still predates REFUNDED: everything rolled back.
    if (/payment_requests_status_valid/.test(String(error?.message || ''))) return { ...plan, ok: false, refused: 'NEEDS_MIGRATION', migration: REFUNDED_MIGRATION };
    if (error?.code === 'P2002') {
      // A concurrent call posted the same reversal first: report it, and finish anything it left.
      const again = await prepare(db, { providerRef, idemKey, reason: why });
      if (again.plan.refused === 'ALREADY_REVERSED') return { ...again.plan, repaired: await repair(db, again.ctx, again.plan, { deps }) };
    }
    throw error;
  }
  if (posted.replayed) {
    return { ...plan, ok: false, refused: 'ALREADY_REVERSED', existing: { journalEntryId: posted.journalEntryId } };
  }

  const after = await db.wallet.findFirst({ where: { accountId: ctx.accountId, balanceType: ctx.balanceType }, select: { availableCents: true, pendingCents: true } }).catch(() => null);
  const done = {
    ...plan,
    reversed: true,
    reversal: { ...plan.reversal, journalEntryId: posted.journalEntryId },
    wallet: { ...plan.wallet, afterCents: after ? num(after.availableCents) : plan.wallet.afterCents },
    paymentRequest: plan.paymentRequest && { ...plan.paymentRequest, status: marks.requestMarked ? REFUNDED_STATUS : plan.paymentRequest.status },
    intent: plan.intent && { ...plan.intent, refundFlagged: plan.intent.refundFlagged || marks.intentFlagged },
  };
  const audit = await writeAudit(db, { reversalJournalEntryId: posted.journalEntryId, accountId: ctx.accountId, metadata: auditMetadata(plan, refund, posted.journalEntryId) });
  const alert = await raiseAlert({ db, deps, text: cardRefundAlertText({ plan: done, reason: why, by: who, balanceAfterCents: done.wallet.afterCents }), originalIdemKey: ctx.entry.idemKey });
  log('card_refund_reversed', {
    accountId: ctx.accountId,
    original: plan.original.idemKey,
    reversal: posted.journalEntryId,
    chargedCents: plan.amounts.chargedCents,
    walletDebitCents: plan.amounts.walletDebitCents,
    requestMarked: marks.requestMarked,
    by: who,
  });
  return { ...done, audit: { written: audit.written }, alert: { sent: alert?.sent ?? 0, skipped: alert?.skipped || null, error: alert?.error || null } };
}
