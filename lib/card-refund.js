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
 *
 * CHARGEBACKS (2026-11-17, POST /api/internal/card-chargeback).
 * When the cardholder's bank takes a card payment back, the processor reverses
 * it from the merchant account whether or not WaPay still holds the money. A
 * chargeback is booked like a refund, with three differences:
 *   - its own entry (`buildChargeback`, idemKey `card-chargeback-<original
 *     idemKey>`, source still REVERSAL_LOAD_<RAIL>): clearing gives back the
 *     gross and the fee revenue is reversed, but the credited wallet gives back
 *     at most its AVAILABLE balance (never below zero) and the rest is WaPay's
 *     loss on EXPENSE:CHARGEBACK:<RAIL>. Money set aside by a hold (a pay-out
 *     awaiting approval) is not reachable here: releasing a hold is the
 *     founder's decision, and a chargeback booked while a hold stands writes
 *     that part off. So SHORT never refuses a chargeback;
 *   - the wallet part is decided inside the money transaction from a fresh read,
 *     never taken from the request (the route cannot choose an amount or a
 *     wallet), and a balance that moves between that read and the debit refuses
 *     BALANCE_MOVED (call again), never a negative balance;
 *   - the intent's `metadata.refund` carries kind CHARGEBACK and the loss, so the
 *     readers that stop counting a refunded payment stop counting this one too;
 *     the audit event is CARD_CHARGEBACK.
 * A refund and a chargeback of the same card load refuse each other
 * (ALREADY_REVERSED, `reversedAs` names the one that exists): the processor
 * can only take the money back once.
 *
 * WITHHOLDS (2026-11-17, POST /api/internal/card-withhold).
 * When the founder will not let a customer keep the money a card payment
 * credited (the payment is disputed or unverified) but nothing has been
 * refunded and no bank has taken it back yet, the money leaves the balance
 * into a WaPay-held liability instead of staying spendable:
 *   - `buildCardWithhold` (idemKey `card-withhold-<original idemKey>`, source
 *     CARD_WITHHOLD_<RAIL>): the credited wallet gives at most its AVAILABLE
 *     balance, read inside the posting transaction and never more than that
 *     load credited, to LIABILITY:CARD_DISPUTE:<RAIL>. Never income, never
 *     money in or out; money under a hold is never reachable; never below zero.
 *     One withhold per card load (ALREADY_WITHHELD); nothing to take refuses
 *     NOTHING_TO_WITHHOLD. The link stays PAID; the intent gains
 *     `metadata.withhold`.
 *   - `release: true` posts the exact mirror (`buildCardWithholdRelease`,
 *     idemKey `card-release-<original idemKey>`, source CARD_RELEASE_<RAIL>):
 *     the money goes back to the same wallet, once.
 *   - A refund or chargeback of a withheld load first posts that release in
 *     the same transaction (meta.closedBy names the reversal), so the withheld
 *     money is used before the balance and the liability closes with it: the
 *     refund's SHORT check and the chargeback's wallet part count it, and the
 *     release key means a separate release can never use it a second time.
 * Audit events CARD_WITHHOLD and CARD_WITHHOLD_RELEASE, one masked ops alert
 * each, nothing to the customer.
 */
import prismaDefault from './prisma.js';
import { buildReversal, buildChargeback, buildCardWithhold, buildCardWithholdRelease, ACCT } from './ledger-core.js';
import { postEntry, walletDeltas } from './ledger-post.js';

export const CARD_LOAD_SOURCES = Object.freeze(['LOAD_PAYFAST', 'LOAD_ADUMO']);
const CARD_RAILS = ['PAYFAST', 'ADUMO'];
export const REFUND_IDEM_PREFIX = 'card-refund-';
export const CHARGEBACK_IDEM_PREFIX = 'card-chargeback-';
export const REFUNDED_STATUS = 'REFUNDED';
export const CARD_REFUND_EVENT = 'CARD_REFUND';
export const CARD_CHARGEBACK_EVENT = 'CARD_CHARGEBACK';
export const REFUNDED_MIGRATION = '20261109_payment_request_refunded';
export const WITHHOLD_IDEM_PREFIX = 'card-withhold-';
export const RELEASE_IDEM_PREFIX = 'card-release-';
export const CARD_WITHHOLD_EVENT = 'CARD_WITHHOLD';
export const CARD_RELEASE_EVENT = 'CARD_WITHHOLD_RELEASE';
/** What took a card payment back: the founder in the dashboard (REFUND) or the cardholder's bank (CHARGEBACK). */
export const REVERSAL_KIND = Object.freeze({ REFUND: 'REFUND', CHARGEBACK: 'CHARGEBACK' });

/** The reversal's idemKey: one refund per original card load, ever. */
export const refundIdemKeyFor = (originalIdemKey) => `${REFUND_IDEM_PREFIX}${originalIdemKey}`;
/** The chargeback's idemKey: one chargeback per original card load, ever. */
export const chargebackIdemKeyFor = (originalIdemKey) => `${CHARGEBACK_IDEM_PREFIX}${originalIdemKey}`;
/** The audit row's id: one row per reversal, so a repair can never write a second. */
export const refundAuditIdFor = (reversalJournalEntryId) => `audit_card_refund_${reversalJournalEntryId}`;
export const chargebackAuditIdFor = (reversalJournalEntryId) => `audit_card_chargeback_${reversalJournalEntryId}`;

/** The withhold's idemKey: one per original card load, ever. */
export const withholdIdemKeyFor = (originalIdemKey) => `${WITHHOLD_IDEM_PREFIX}${originalIdemKey}`;
/** The release's idemKey: one per original card load, ever, whether the founder released it or a reversal used it. */
export const releaseIdemKeyFor = (originalIdemKey) => `${RELEASE_IDEM_PREFIX}${originalIdemKey}`;
export const withholdAuditIdFor = (journalEntryId) => `audit_card_withhold_${journalEntryId}`;
export const releaseAuditIdFor = (journalEntryId) => `audit_card_release_${journalEntryId}`;

const isChargeback = (kind) => kind === REVERSAL_KIND.CHARGEBACK;
const keyFor = (kind, originalIdemKey) => (isChargeback(kind) ? chargebackIdemKeyFor(originalIdemKey) : refundIdemKeyFor(originalIdemKey));
const otherKind = (kind) => (isChargeback(kind) ? REVERSAL_KIND.REFUND : REVERSAL_KIND.CHARGEBACK);

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
async function prepare(db, { providerRef = null, idemKey = null, reason = null, kind = REVERSAL_KIND.REFUND } = {}) {
  const chargeback = isChargeback(kind);
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
  const reversalIdemKey = keyFor(kind, entry.idemKey);
  const originalForReversal = { idemKey: entry.idemKey, source: entry.source, postings };
  const reversalReason = reason || (chargeback ? "card payment taken back by the cardholder's bank (chargeback)" : 'card refunded in the processor dashboard');
  // The full mirror decides the shape check and, for a refund, is the entry; a chargeback rebuilds it below with the
  // wallet part it can take.
  const reversal = buildReversal({ original: originalForReversal, idemKey: reversalIdemKey, reason: reversalReason });
  const debits = walletDeltas(reversal.postings).filter((d) => d.deltaCents < 0);
  // A card load credits exactly one wallet; any other shape is not one this route knows how to undo.
  if (debits.length !== 1 || walletDeltas(reversal.postings).some((d) => d.deltaCents > 0)) {
    return { plan: { ok: false, refused: 'UNEXPECTED_SHAPE', original } };
  }
  const { accountId, balanceType } = debits[0];
  const debitCents = -debits[0].deltaCents;

  const [wallet, account, existing, existingOther] = await Promise.all([
    db.wallet.findFirst({ where: { accountId, balanceType }, select: { availableCents: true, pendingCents: true } }),
    db.account.findUnique({ where: { id: accountId }, select: { waId: true } }),
    db.journalEntry.findUnique({ where: { idemKey: reversalIdemKey } }),
    db.journalEntry.findUnique({ where: { idemKey: keyFor(otherKind(kind), entry.idemKey) } }),
  ]);
  const amounts = summariseLoad(postings);

  const plan = {
    ok: true,
    kind,
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
  const ctx = { kind, entry, intent, request, reversal, originalForReversal, reversalReason, accountId, balanceType, debitCents, walletCreditCents: debitCents, existing };

  if (existing) {
    return { plan: { ...plan, ok: false, refused: 'ALREADY_REVERSED', reversedAs: kind, existing: { journalEntryId: existing.id, createdAt: existing.createdAt } }, ctx };
  }
  // The processor takes a card payment back once: a refund and a chargeback of the same load refuse each other, and
  // nothing is repaired across kinds.
  if (existingOther) {
    return { plan: { ...plan, ok: false, refused: 'ALREADY_REVERSED', reversedAs: otherKind(kind), existing: { journalEntryId: existingOther.id, createdAt: existingOther.createdAt } } };
  }
  if (plan.paymentRequest?.becomes === REFUNDED_STATUS && (await refundedStatusAllowed(db)) === false) {
    return { plan: { ...plan, ok: false, refused: 'NEEDS_MIGRATION', migration: REFUNDED_MIGRATION } };
  }
  if (!wallet) return { plan: { ...plan, ok: false, refused: 'NO_WALLET' } };
  // Money withheld from this load (LIABILITY:CARD_DISPUTE) is used first: the reversal's transaction releases it into
  // the wallet before it debits, so it counts as balance here.
  const held = await withheldFor(db, entry.idemKey);
  ctx.held = held;
  if (held.withhold) {
    plan.withheld = { cents: held.cents, account: ACCT.cardDispute(plan.rail), state: held.cents > 0 ? 'HELD' : 'RELEASED' };
    if (held.cents > 0) plan.release = { idemKey: releaseIdemKeyFor(entry.idemKey), postings: held.releasePostings };
  }
  const available = Math.max(0, num(wallet.availableCents)) + held.cents;
  if (chargeback) {
    // The bank already took the money back: the wallet gives what it holds, WaPay absorbs the rest.
    const walletPart = Math.min(available, debitCents);
    const built = buildChargeback({ original: originalForReversal, idemKey: reversalIdemKey, walletDebitCents: walletPart, reason: reversalReason });
    ctx.reversal = built;
    ctx.debitCents = walletPart;
    plan.amounts = { ...plan.amounts, walletDebitCents: walletPart, lossCents: debitCents - walletPart, ...(held.cents ? { fromWithheldCents: held.cents } : {}) };
    plan.lossAccount = ACCT.chargebackLoss(plan.rail);
    plan.reversal = { idemKey: reversalIdemKey, source: built.source, postings: built.postings };
    plan.wallet = { ...plan.wallet, debitCents: walletPart, afterCents: available - walletPart };
    return { plan, ctx };
  }
  if (available < debitCents) {
    return { plan: { ...plan, ok: false, refused: 'SHORT', shortCents: debitCents - available } };
  }
  if (held.cents) plan.amounts = { ...plan.amounts, fromWithheldCents: held.cents };
  plan.wallet = { ...plan.wallet, debitCents, afterCents: available - debitCents };
  return { plan, ctx };
}

/**
 * What is withheld from one card load right now: the withhold entry, whether it has been released (or used by a
 * reversal), and the cents still in LIABILITY:CARD_DISPUTE for it. Reads only.
 */
async function withheldFor(db, originalIdemKey, { tx = null } = {}) {
  const q = tx || db;
  const [withhold, release] = await Promise.all([
    q.journalEntry.findUnique({ where: { idemKey: withholdIdemKeyFor(originalIdemKey) }, include: { lines: true } }),
    q.journalEntry.findUnique({ where: { idemKey: releaseIdemKeyFor(originalIdemKey) } }),
  ]);
  if (!withhold) return { withhold: null, release: null, cents: 0 };
  const postings = (withhold.lines || []).map((l) => ({ accountCode: l.accountCode, debitCents: l.debitCents ? num(l.debitCents) : undefined, creditCents: l.creditCents ? num(l.creditCents) : undefined }));
  const amount = postings.filter((p) => String(p.accountCode).startsWith('LIABILITY:CARD_DISPUTE:')).reduce((s, p) => s + num(p.creditCents) - num(p.debitCents), 0);
  const asEntry = { idemKey: withhold.idemKey, source: withhold.source, postings };
  const releasePostings = release ? [] : buildCardWithholdRelease({ withhold: asEntry, idemKey: releaseIdemKeyFor(originalIdemKey) }).postings;
  return { withhold, withholdEntry: asEntry, release, cents: release ? 0 : amount, amountCents: amount, releasePostings };
}

/**
 * Dry run: what POST would reverse, or why it would refuse. Writes nothing.
 * @returns {Promise<object>} the plan; `ok` is true when a POST would post
 */
export async function planCardRefund({ prisma: db = prismaDefault, providerRef = null, idemKey = null, kind = REVERSAL_KIND.REFUND } = {}) {
  return (await prepare(db, { providerRef, idemKey, kind })).plan;
}

/** Dry run of a chargeback: the wallet part, the loss part, the link it closes, or why a POST would refuse. */
export async function planCardChargeback({ prisma: db = prismaDefault, providerRef = null, idemKey = null } = {}) {
  return planCardRefund({ prisma: db, providerRef, idemKey, kind: REVERSAL_KIND.CHARGEBACK });
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
async function writeAudit(db, { reversalJournalEntryId, accountId, metadata, kind = REVERSAL_KIND.REFUND }) {
  const cb = isChargeback(kind);
  try {
    await db.auditLog.create({ data: { id: cb ? chargebackAuditIdFor(reversalJournalEntryId) : refundAuditIdFor(reversalJournalEntryId), accountId, event: cb ? CARD_CHARGEBACK_EVENT : CARD_REFUND_EVENT, metadata } });
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

/** The ops line for a chargeback: masks and references only. Pure. */
export function cardChargebackAlertText({ plan, reason, by, balanceAfterCents = null }) {
  const a = plan.amounts || {};
  const railName = plan.rail === 'ADUMO' ? 'Adumo' : 'PayFast';
  const when = plan.original?.createdAt ? `, ${sast(plan.original.createdAt)}` : '';
  const lines = [
    `⚠️ Chargeback booked: ${R(a.chargedCents)} charged by card (${railName} ${refTail(plan.original?.providerRef)}${when}) was taken back by the cardholder's bank and is reversed in the ledger.`,
    `Account ${String(plan.accountId || '').slice(0, 8)}…${plan.phone ? ` (${plan.phone})` : ''}: ${R(a.walletDebitCents)} off the balance${balanceAfterCents != null ? `, now ${R(balanceAfterCents)}` : ''}; fee revenue ${R(a.feeReversedCents)} reversed; ${R(a.lossCents)} written off as WaPay's chargeback loss.`,
  ];
  if (plan.paymentRequest) lines.push(`Link ${plan.paymentRequest.code} is now ${plan.paymentRequest.becomes === REFUNDED_STATUS ? 'closed as refunded' : String(plan.paymentRequest.status || '').toLowerCase()}.`);
  if (plan.referenceCheck === 'UNVERIFIED') lines.push('The books do not record which charge credited this payment; booked on the operator\'s word that it was the only one.');
  lines.push(`Reason: ${maskDigits(reason).slice(0, 200)}. By ${maskDigits(by || 'ops').slice(0, 40)}. No message went to the customer.`);
  return lines.join('\n');
}

async function raiseAlert({ db, deps, text, originalIdemKey, kind = REVERSAL_KIND.REFUND }) {
  try {
    const send = deps.opsPersonAlert || (await import('./ops-alerts.js')).opsPersonAlert;
    return await send({ text, key: `${isChargeback(kind) ? 'card-chargeback' : 'card-refund'}:${originalIdemKey}`, prisma: db });
  } catch (error) {
    return { error: error?.message };
  }
}

const alertTextFor = (kind, args) => (isChargeback(kind) ? cardChargebackAlertText(args) : cardRefundAlertText(args));

/** A second call for a reversal that exists: finish whatever the first one did not (mark, audit, alert). */
async function repair(db, ctx, plan, { deps }) {
  const kind = ctx.kind || REVERSAL_KIND.REFUND;
  const meta = ctx.existing?.metadata || {};
  const refund = {
    at: new Date(ctx.existing?.createdAt || Date.now()).toISOString(),
    by: meta.by || 'ops',
    reason: meta.reason || null,
    reversalIdemKey: ctx.existing?.idemKey || keyFor(kind, ctx.entry.idemKey),
    providerRef: plan.original.providerRef,
    ...(meta.onlyChargeConfirmed === true ? { onlyChargeConfirmed: true } : {}),
    ...(isChargeback(kind) ? { kind: REVERSAL_KIND.CHARGEBACK, lossCents: num(meta.lossCents) } : {}),
  };
  // A chargeback's own split is on its entry; the plan of a repair call shows what it would take today.
  const repairedPlan = isChargeback(kind) ? { ...plan, amounts: { ...plan.amounts, walletDebitCents: num(meta.walletDebitCents), lossCents: num(meta.lossCents) } } : plan;
  const marks = await db.$transaction((tx) => markRefunded(tx, ctx, refund));
  const audit = await writeAudit(db, { kind, reversalJournalEntryId: ctx.existing.id, accountId: ctx.accountId, metadata: auditMetadata(repairedPlan, refund, ctx.existing.id) });
  // Always asked: the alert's own key (opsPersonAlert, once per key) sends it only if the first call never did.
  const alert = await raiseAlert({ db, deps, kind, text: alertTextFor(kind, { plan: { ...repairedPlan, paymentRequest: plan.paymentRequest && { ...plan.paymentRequest, becomes: REFUNDED_STATUS } }, reason: refund.reason, by: refund.by }), originalIdemKey: ctx.entry.idemKey });
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
    ...(refund.kind === REVERSAL_KIND.CHARGEBACK ? { kind: REVERSAL_KIND.CHARGEBACK, lossCents: plan.amounts.lossCents, lossAccount: ACCT.chargebackLoss(plan.rail) } : {}),
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
export async function postCardRefund({ prisma: db = prismaDefault, providerRef = null, idemKey = null, reason, by = 'ops', onlyCharge = false, now = new Date(), deps = {}, kind = REVERSAL_KIND.REFUND } = {}) {
  const chargeback = isChargeback(kind);
  const why = maskDigits(String(reason ?? '').trim()).slice(0, 200);
  if (!why) return { ok: false, refused: 'NO_REASON' };
  const who = maskDigits(String(by ?? '').trim()).slice(0, 40) || 'ops';

  const { plan, ctx } = await prepare(db, { providerRef, idemKey, reason: why, kind });
  // Repair only the same kind's own reversal; a reversal of the other kind is reported, never touched.
  if (plan.refused === 'ALREADY_REVERSED') return ctx?.existing ? { ...plan, repaired: await repair(db, ctx, plan, { deps }) } : plan;
  if (!plan.ok) return plan;
  if (plan.referenceCheck === 'UNVERIFIED' && onlyCharge !== true) return { ...plan, ok: false, refused: 'CONFIRM_ONLY_CHARGE' };

  const refund = {
    at: now.toISOString(),
    by: who,
    reason: why,
    reversalIdemKey: ctx.reversal.idemKey,
    providerRef: plan.original.providerRef,
    ...(plan.referenceCheck === 'UNVERIFIED' ? { onlyChargeConfirmed: true } : {}),
    ...(chargeback ? { kind: REVERSAL_KIND.CHARGEBACK } : {}),
  };
  const entryFor = (reversal) => ({
    ...reversal,
    externalRef: plan.original.providerRef,
    meta: { ...reversal.meta, kind: chargeback ? CARD_CHARGEBACK_EVENT : CARD_REFUND_EVENT, by: who, accountId: ctx.accountId, providerRef: plan.original.providerRef, requestCode: plan.paymentRequest?.code || null, ...(refund.onlyChargeConfirmed ? { onlyChargeConfirmed: true } : {}) },
  });

  let posted;
  let marks = { requestMarked: false, intentFlagged: false };
  // What a chargeback actually took from the wallet: decided inside the transaction from a fresh read.
  let split = { walletDebitCents: ctx.debitCents, lossCents: chargeback ? ctx.walletCreditCents - ctx.debitCents : 0 };
  let postedPostings = plan.reversal.postings;
  try {
    posted = await db.$transaction(async (tx) => {
      let reversal = ctx.reversal;
      // Withheld money from this load goes back to the wallet first, in this transaction, so the reversal can use it
      // and the liability closes with it. The release key is the one a separate release would use: never twice.
      if (ctx.held?.cents > 0) {
        const rel = buildCardWithholdRelease({ withhold: ctx.held.withholdEntry, idemKey: releaseIdemKeyFor(ctx.entry.idemKey), reason: why, closedBy: ctx.reversal.idemKey });
        const r = await postEntry({ ...rel, externalRef: plan.original.providerRef, meta: { ...rel.meta, by: who, accountId: ctx.accountId } }, { tx });
        if (!r.replayed) await markWithhold(tx, ctx.intent, { releasedAt: now.toISOString(), releasedBy: who, releaseIdemKey: rel.idemKey, closedBy: ctx.reversal.idemKey });
      }
      if (chargeback) {
        const fresh = await tx.wallet.findFirst({ where: { accountId: ctx.accountId, balanceType: ctx.balanceType }, select: { availableCents: true } });
        const walletPart = Math.min(Math.max(0, num(fresh?.availableCents)), ctx.walletCreditCents);
        split = { walletDebitCents: walletPart, lossCents: ctx.walletCreditCents - walletPart };
        reversal = buildChargeback({ original: ctx.originalForReversal, idemKey: ctx.reversal.idemKey, walletDebitCents: walletPart, reason: why });
        postedPostings = reversal.postings;
      }
      // No allowNegative: the debit is the atomic check-and-decrement, so a balance spent since the read refuses here.
      const p = await postEntry(entryFor(reversal), { tx });
      if (!p.replayed) marks = await markRefunded(tx, ctx, chargeback ? { ...refund, lossCents: split.lossCents } : refund);
      return p;
    });
  } catch (error) {
    if (error?.code === 'INSUFFICIENT_FUNDS') {
      const available = num(error.availableCents);
      // A chargeback never refuses SHORT; the balance moved between its read and its debit, so nothing was written.
      if (chargeback) return { ...plan, ok: false, refused: 'BALANCE_MOVED', wallet: { ...plan.wallet, availableCents: available, debitCents: undefined, afterCents: undefined } };
      return { ...plan, ok: false, refused: 'SHORT', wallet: { ...plan.wallet, availableCents: available, debitCents: undefined, afterCents: undefined }, shortCents: ctx.debitCents - available };
    }
    // The status check could not be read up front and still predates REFUNDED: everything rolled back.
    if (/payment_requests_status_valid/.test(String(error?.message || ''))) return { ...plan, ok: false, refused: 'NEEDS_MIGRATION', migration: REFUNDED_MIGRATION };
    if (error?.code === 'P2002') {
      // A concurrent call posted the same reversal first: report it, and finish anything it left.
      const again = await prepare(db, { providerRef, idemKey, reason: why, kind });
      if (again.plan.refused === 'ALREADY_REVERSED') return again.ctx?.existing ? { ...again.plan, repaired: await repair(db, again.ctx, again.plan, { deps }) } : again.plan;
      // A separate release of this load's withheld money won the race: nothing was written here; call again.
      return { ...plan, ok: false, refused: 'BALANCE_MOVED' };
    }
    throw error;
  }
  if (posted.replayed) {
    return { ...plan, ok: false, refused: 'ALREADY_REVERSED', reversedAs: kind, existing: { journalEntryId: posted.journalEntryId } };
  }

  const amounts = chargeback ? { ...plan.amounts, ...split } : plan.amounts;
  const after = await db.wallet.findFirst({ where: { accountId: ctx.accountId, balanceType: ctx.balanceType }, select: { availableCents: true, pendingCents: true } }).catch(() => null);
  const done = {
    ...plan,
    amounts,
    reversed: true,
    reversal: { ...plan.reversal, journalEntryId: posted.journalEntryId, postings: postedPostings },
    wallet: { ...plan.wallet, ...(chargeback ? { debitCents: split.walletDebitCents } : {}), afterCents: after ? num(after.availableCents) : plan.wallet.afterCents },
    paymentRequest: plan.paymentRequest && { ...plan.paymentRequest, status: marks.requestMarked ? REFUNDED_STATUS : plan.paymentRequest.status },
    intent: plan.intent && { ...plan.intent, refundFlagged: plan.intent.refundFlagged || marks.intentFlagged },
  };
  const audit = await writeAudit(db, { kind, reversalJournalEntryId: posted.journalEntryId, accountId: ctx.accountId, metadata: auditMetadata(done, refund, posted.journalEntryId) });
  const alert = await raiseAlert({ db, deps, kind, text: alertTextFor(kind, { plan: done, reason: why, by: who, balanceAfterCents: done.wallet.afterCents }), originalIdemKey: ctx.entry.idemKey });
  log(chargeback ? 'card_chargeback_reversed' : 'card_refund_reversed', {
    accountId: ctx.accountId,
    original: plan.original.idemKey,
    reversal: posted.journalEntryId,
    chargedCents: plan.amounts.chargedCents,
    walletDebitCents: amounts.walletDebitCents,
    ...(chargeback ? { lossCents: amounts.lossCents } : {}),
    requestMarked: marks.requestMarked,
    by: who,
  });
  return { ...done, audit: { written: audit.written }, alert: { sent: alert?.sent ?? 0, skipped: alert?.skipped || null, error: alert?.error || null } };
}

/**
 * Book a chargeback: the cardholder's bank took a card payment back and the processor reversed it from the merchant
 * account. Same arguments and answers as postCardRefund; never SHORT (the part the wallet no longer holds is WaPay's
 * loss on EXPENSE:CHARGEBACK:<rail>), BALANCE_MOVED when the balance changed during the call (call again).
 */
export async function postCardChargeback(args = {}) {
  return postCardRefund({ ...args, kind: REVERSAL_KIND.CHARGEBACK });
}

// ---------------------------------------------------------------------------
// Withholds (2026-11-17): disputed card money leaves the balance into LIABILITY:CARD_DISPUTE:<RAIL>, and back.
// ---------------------------------------------------------------------------

/** The intent's `metadata.withhold`, merged (inside the money transaction). */
async function markWithhold(tx, intent, patch) {
  if (!intent?.idemKey) return false;
  const fresh = await tx.providerRequest.findUnique({ where: { idemKey: intent.idemKey } });
  if (!fresh) return false;
  const meta = fresh.metadata || {};
  await tx.providerRequest.update({ where: { idemKey: intent.idemKey }, data: { metadata: { ...meta, withhold: { ...(meta.withhold || {}), ...patch } } } });
  return true;
}

/** Everything a withhold (or release) dry run shows and a post needs. Reads only. */
async function prepareWithhold(db, { providerRef = null, idemKey = null, release = false } = {}) {
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
  if (found.ref && credit && credit.ref !== found.ref) {
    return { plan: { ok: false, refused: 'NOT_THE_CREDITED_PAYMENT', original, requestCode: request?.id || null, creditedBy: `card ${refTail(credit.ref)}` } };
  }
  const referenceCheck = credit ? credit.from : 'UNVERIFIED';
  const postings = (entry.lines || []).map((l) => ({ accountCode: l.accountCode, debitCents: l.debitCents ? num(l.debitCents) : undefined, creditCents: l.creditCents ? num(l.creditCents) : undefined }));
  const credits = walletDeltas(postings).filter((d) => d.deltaCents > 0);
  if (credits.length !== 1 || walletDeltas(postings).some((d) => d.deltaCents < 0)) return { plan: { ok: false, refused: 'UNEXPECTED_SHAPE', original } };
  const { accountId, balanceType } = credits[0];
  const walletCreditCents = credits[0].deltaCents;
  const rail = entry.source.slice('LOAD_'.length);

  const [wallet, account, refund, chargeback, held] = await Promise.all([
    db.wallet.findFirst({ where: { accountId, balanceType }, select: { availableCents: true, pendingCents: true } }),
    db.account.findUnique({ where: { id: accountId }, select: { waId: true } }),
    db.journalEntry.findUnique({ where: { idemKey: refundIdemKeyFor(entry.idemKey) } }),
    db.journalEntry.findUnique({ where: { idemKey: chargebackIdemKeyFor(entry.idemKey) } }),
    withheldFor(db, entry.idemKey),
  ]);
  const plan = {
    ok: true,
    mode: release ? 'RELEASE' : 'WITHHOLD',
    original,
    rail,
    accountId,
    phone: tail4(account?.waId),
    payer: tail4(intent?.metadata?.payerMsisdn),
    account: ACCT.cardDispute(rail),
    amounts: { ...summariseLoad(postings), walletCreditCents },
    wallet: { balanceType, availableCents: num(wallet?.availableCents), pendingCents: num(wallet?.pendingCents) },
    paymentRequest: request ? { code: request.id, status: request.status } : null,
    referenceCheck,
  };
  const ctx = { entry, intent, request, original: { idemKey: entry.idemKey, source: entry.source, postings }, accountId, balanceType, walletCreditCents, held, release };
  const reversed = refund || chargeback;
  if (reversed) {
    return { plan: { ...plan, ok: false, refused: 'ALREADY_REVERSED', reversedAs: chargeback ? REVERSAL_KIND.CHARGEBACK : REVERSAL_KIND.REFUND, existing: { journalEntryId: reversed.id, createdAt: reversed.createdAt } } };
  }
  if (!wallet) return { plan: { ...plan, ok: false, refused: 'NO_WALLET' } };

  if (release) {
    if (!held.withhold) return { plan: { ...plan, ok: false, refused: 'NOT_WITHHELD' } };
    if (held.release) return { plan: { ...plan, ok: false, refused: 'ALREADY_RELEASED', existing: { journalEntryId: held.release.id, createdAt: held.release.createdAt, closedBy: held.release.metadata?.closedBy || null } }, ctx: { ...ctx, existing: held.release } };
    const rel = buildCardWithholdRelease({ withhold: held.withholdEntry, idemKey: releaseIdemKeyFor(entry.idemKey) });
    plan.amounts = { ...plan.amounts, releaseCents: held.cents };
    plan.entry = { idemKey: rel.idemKey, source: rel.source, postings: rel.postings };
    plan.wallet = { ...plan.wallet, creditCents: held.cents, afterCents: plan.wallet.availableCents + held.cents };
    return { plan, ctx };
  }

  if (held.withhold) {
    const state = held.release ? 'RELEASED' : 'HELD';
    return { plan: { ...plan, ok: false, refused: 'ALREADY_WITHHELD', state, existing: { journalEntryId: held.withhold.id, createdAt: held.withhold.createdAt, cents: held.amountCents } }, ctx: { ...ctx, existing: held.withhold } };
  }
  if (referenceCheck === 'UNVERIFIED') {
    plan.confirm = { field: 'onlyCharge', check: `the ${rail === 'ADUMO' ? 'Adumo' : 'PayFast'} dashboard shows exactly one successful payment for ${intent ? `m_payment_id ${intent.id}` : `this entry (${entry.idemKey})`}` };
  }
  // Available balance only (a hold is the founder's to release), never more than this load credited.
  const take = Math.min(Math.max(0, plan.wallet.availableCents), walletCreditCents);
  if (take < 1) return { plan: { ...plan, ok: false, refused: 'NOTHING_TO_WITHHOLD' } };
  const w = buildCardWithhold({ original: ctx.original, idemKey: withholdIdemKeyFor(entry.idemKey), amountCents: take });
  plan.amounts = { ...plan.amounts, withholdCents: take };
  plan.entry = { idemKey: w.idemKey, source: w.source, postings: w.postings };
  plan.wallet = { ...plan.wallet, debitCents: take, afterCents: plan.wallet.availableCents - take };
  return { plan, ctx };
}

/** The ops line for a withhold or a release: masks and references only. Pure. */
export function cardWithholdAlertText({ plan, reason, by, balanceAfterCents = null }) {
  const a = plan.amounts || {};
  const railName = plan.rail === 'ADUMO' ? 'Adumo' : 'PayFast';
  const when = plan.original?.createdAt ? `, ${sast(plan.original.createdAt)}` : '';
  const who = `account ${String(plan.accountId || '').slice(0, 8)}…${plan.phone ? ` (${plan.phone})` : ''}`;
  const now = balanceAfterCents != null ? `; balance now ${R(balanceAfterCents)}` : '';
  const lines = plan.mode === 'RELEASE'
    ? [`🔓 Withheld card money released: ${R(a.releaseCents)} from ${plan.account} back to ${who}${now}.`, `It came from a ${R(a.chargedCents)} card payment (${railName} ${refTail(plan.original?.providerRef)}${when}).`]
    : [
      `🔒 Card money withheld: ${R(a.withholdCents)} of the ${R(a.walletCreditCents)} a ${R(a.chargedCents)} card payment credited (${railName} ${refTail(plan.original?.providerRef)}${when}) moved from ${who} to ${plan.account}${now}.`,
      'Nothing was refunded; the link stays paid. It goes back with release, or to the card with a refund or chargeback of this payment.',
    ];
  if (plan.referenceCheck === 'UNVERIFIED' && plan.mode !== 'RELEASE') lines.push('The books do not record which charge credited this payment; withheld on the operator\'s word that it was the only one.');
  lines.push(`Reason: ${maskDigits(reason).slice(0, 200)}. By ${maskDigits(by || 'ops').slice(0, 40)}. No message went to the customer.`);
  return lines.join('\n');
}

/** Dry run of a withhold (or, with release: true, of its release). Writes nothing. */
export async function planCardWithhold({ prisma: db = prismaDefault, providerRef = null, idemKey = null, release = false } = {}) {
  return (await prepareWithhold(db, { providerRef, idemKey, release })).plan;
}

/**
 * Withhold the money one card load credited (or release it back with `release: true`). The amount is never taken from
 * the request: the wallet's available balance is read inside the posting transaction.
 * @returns {Promise<object>} `{ ok: true, withheld|released: true, ... }` or `{ ok: false, refused, ... }`
 */
export async function postCardWithhold({ prisma: db = prismaDefault, providerRef = null, idemKey = null, release = false, reason, by = 'ops', onlyCharge = false, now = new Date(), deps = {} } = {}) {
  const why = maskDigits(String(reason ?? '').trim()).slice(0, 200);
  if (!why) return { ok: false, refused: 'NO_REASON' };
  const who = maskDigits(String(by ?? '').trim()).slice(0, 40) || 'ops';
  const { plan, ctx } = await prepareWithhold(db, { providerRef, idemKey, release });
  if (!plan.ok) return plan;
  if (!release && plan.referenceCheck === 'UNVERIFIED' && onlyCharge !== true) return { ...plan, ok: false, refused: 'CONFIRM_ONLY_CHARGE' };

  const key = release ? releaseIdemKeyFor(ctx.entry.idemKey) : withholdIdemKeyFor(ctx.entry.idemKey);
  let posted;
  let built;
  try {
    posted = await db.$transaction(async (tx) => {
      // A reversal booked since the read owns this load's money now.
      const [refund, chargeback] = await Promise.all([
        tx.journalEntry.findUnique({ where: { idemKey: refundIdemKeyFor(ctx.entry.idemKey) } }),
        tx.journalEntry.findUnique({ where: { idemKey: chargebackIdemKeyFor(ctx.entry.idemKey) } }),
      ]);
      if (refund || chargeback) throw Object.assign(new Error('reversed'), { code: 'ALREADY_REVERSED', reversedAs: chargeback ? REVERSAL_KIND.CHARGEBACK : REVERSAL_KIND.REFUND });
      if (release) {
        built = buildCardWithholdRelease({ withhold: ctx.held.withholdEntry, idemKey: key, reason: why });
      } else {
        const fresh = await tx.wallet.findFirst({ where: { accountId: ctx.accountId, balanceType: ctx.balanceType }, select: { availableCents: true } });
        const take = Math.min(Math.max(0, num(fresh?.availableCents)), ctx.walletCreditCents);
        if (take < 1) throw Object.assign(new Error('nothing'), { code: 'NOTHING_TO_WITHHOLD' });
        built = buildCardWithhold({ original: ctx.original, idemKey: key, amountCents: take, reason: why });
      }
      // No allowNegative: the debit is the atomic check-and-decrement.
      const p = await postEntry({ ...built, externalRef: plan.original.providerRef, meta: { ...built.meta, by: who, accountId: ctx.accountId, providerRef: plan.original.providerRef, requestCode: plan.paymentRequest?.code || null } }, { tx });
      if (!p.replayed) {
        const amount = built.meta.amountCents;
        await markWithhold(tx, ctx.intent, release
          ? { releasedAt: now.toISOString(), releasedBy: who, releaseIdemKey: key, releaseReason: why }
          : { at: now.toISOString(), by: who, reason: why, cents: amount, idemKey: key, providerRef: plan.original.providerRef });
      }
      return p;
    });
  } catch (error) {
    if (error?.code === 'ALREADY_REVERSED') return { ...plan, ok: false, refused: 'ALREADY_REVERSED', reversedAs: error.reversedAs };
    if (error?.code === 'NOTHING_TO_WITHHOLD') return { ...plan, ok: false, refused: 'NOTHING_TO_WITHHOLD' };
    if (error?.code === 'INSUFFICIENT_FUNDS') return { ...plan, ok: false, refused: 'BALANCE_MOVED' };
    if (error?.code === 'P2002') return { ...plan, ok: false, refused: release ? 'ALREADY_RELEASED' : 'ALREADY_WITHHELD' };
    throw error;
  }
  if (posted.replayed) return { ...plan, ok: false, refused: release ? 'ALREADY_RELEASED' : 'ALREADY_WITHHELD', existing: { journalEntryId: posted.journalEntryId } };

  const amount = built.meta.amountCents;
  const after = await db.wallet.findFirst({ where: { accountId: ctx.accountId, balanceType: ctx.balanceType }, select: { availableCents: true } }).catch(() => null);
  const done = {
    ...plan,
    amounts: { ...plan.amounts, ...(release ? { releaseCents: amount } : { withholdCents: amount }) },
    ...(release ? { released: true } : { withheld: true }),
    entry: { idemKey: built.idemKey, source: built.source, postings: built.postings, journalEntryId: posted.journalEntryId },
    wallet: { ...plan.wallet, ...(release ? { creditCents: amount } : { debitCents: amount }), afterCents: after ? num(after.availableCents) : plan.wallet.afterCents },
  };
  const metadata = { withholdOf: ctx.entry.idemKey, idemKey: key, journalEntryId: posted.journalEntryId, source: built.source, providerRef: plan.original.providerRef, requestCode: plan.paymentRequest?.code || null, amountCents: amount, account: plan.account, referenceCheck: plan.referenceCheck, onlyChargeConfirmed: !release && plan.referenceCheck === 'UNVERIFIED', reason: why, by: who };
  let auditWritten = false;
  try {
    await db.auditLog.create({ data: { id: release ? releaseAuditIdFor(posted.journalEntryId) : withholdAuditIdFor(posted.journalEntryId), accountId: ctx.accountId, event: release ? CARD_RELEASE_EVENT : CARD_WITHHOLD_EVENT, metadata } });
    auditWritten = true;
  } catch (error) {
    if (error?.code !== 'P2002') log('card_withhold_audit_error', { journalEntryId: posted.journalEntryId, error: error?.message });
  }
  let alert = null;
  try {
    const send = deps.opsPersonAlert || (await import('./ops-alerts.js')).opsPersonAlert;
    alert = await send({ text: cardWithholdAlertText({ plan: done, reason: why, by: who, balanceAfterCents: done.wallet.afterCents }), key: `${release ? 'card-release' : 'card-withhold'}:${ctx.entry.idemKey}`, prisma: db });
  } catch (error) {
    alert = { error: error?.message };
  }
  log(release ? 'card_withhold_released' : 'card_withhold_booked', { accountId: ctx.accountId, original: ctx.entry.idemKey, entry: posted.journalEntryId, amountCents: amount, by: who });
  return { ...done, audit: { written: auditWritten }, alert: { sent: alert?.sent ?? 0, skipped: alert?.skipped || null, error: alert?.error || null } };
}

/**
 * The withheld-money books (Mission Control's reconciliation): what LIABILITY:CARD_DISPUTE holds, and whether it equals
 * the withholds that are still open. Pure; the route reads every CARD_WITHHOLD_ / CARD_RELEASE_ entry with its lines.
 * @param {{ entries: Array<{ idemKey: string, source: string, lines: Array }> }} args
 */
export function cardDisputeBooks({ entries = [] } = {}) {
  const released = new Set(entries.filter((e) => String(e.source || '').startsWith('CARD_RELEASE_')).map((e) => String(e.idemKey).slice(RELEASE_IDEM_PREFIX.length)));
  let liabilityCents = 0;
  let openCents = 0;
  let open = 0;
  let closed = 0;
  for (const e of entries) {
    const disputeNet = (e.lines || []).filter((l) => String(l.accountCode).startsWith('LIABILITY:CARD_DISPUTE:')).reduce((s, l) => s + num(l.creditCents) - num(l.debitCents), 0);
    liabilityCents += disputeNet;
    if (String(e.source || '').startsWith('CARD_WITHHOLD_')) {
      if (released.has(String(e.idemKey).slice(WITHHOLD_IDEM_PREFIX.length))) closed += 1;
      else { open += 1; openCents += disputeNet; }
    }
  }
  const checks = [{ id: 'withheld_matches_open', label: 'Withheld card money equals the withholds still open', ok: liabilityCents === openCents, count: liabilityCents - openCents }];
  return { withheldCents: liabilityCents, open, openCents, closed, checks, allOk: checks.every((c) => c.ok) };
}
