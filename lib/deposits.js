/**
 * PayFast deposit intents — the card on-ramp's state store.
 *
 * A deposit intent is a ProviderRequest row created BEFORE the customer is
 * sent to PayFast. Its row id becomes PayFast's m_payment_id, and its idemKey
 * ('wapay-pfdep-' + id) is the ledger idempotency key the ITN webhook posts
 * with — so however many times PayFast redelivers the ITN, postEntry replays
 * the same journal entry and the wallet is credited exactly once.
 *
 * This module never moves money. It only answers:
 *   * createDepositIntent - remember what the customer is about to pay
 *   * getDepositIntent    - the ITN arrived; what did we expect?
 *   * markDeposit         - record the terminal outcome (SUCCESS | FAILED)
 *   * recordItnDebug      - stash a raw ITN on the intent for forensics
 *
 * Money is integer cents, ZAR, everywhere. PayFast's wire format is rand
 * strings ('50.00') — centsToRandString converts with integer math only.
 */

import crypto from 'crypto';
import prisma from './prisma.js';

export const DEPOSIT_PROVIDER = 'PAYFAST';
export const DEPOSIT_ROUTE = 'deposit';
export const DEPOSIT_IDEM_PREFIX = 'wapay-pfdep-';

/** R10 floor: below this, card fees eat the load. */
export const MIN_DEPOSIT_CENTS = 1000;
/** R3000 ceiling: no-KYC exposure cap per deposit. */
export const MAX_DEPOSIT_CENTS = 300000;

/**
 * The card/EFT payment fee the customer pays ON TOP of the amount credited
 * (founder decision 2026-08-20: loads must cover the PayFast processing cost
 * plus ~0.5% margin — never loss-making). Computed as rate + fixed, rounded
 * UP to a whole rand so the chat shows one flat number ("R30 + R4 fee").
 *
 * Defaults assume worst-case card pricing (~3.68% incl VAT + ~R2.30 fixed)
 * plus 0.5% margin ≈ 4.2% + R2.30. Tune via env once the real PayFast rate
 * card is confirmed from the merchant dashboard:
 *   WAPAY_DEPOSIT_FEE_BPS         (default 420 = 4.20%)
 *   WAPAY_DEPOSIT_FEE_FIXED_CENTS (default 230)
 *
 * @param {number} amountCents - the amount to be CREDITED, integer cents
 * @returns {number} fee in integer cents, whole rands
 */
export function depositFeeCents(amountCents) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`depositFeeCents requires positive integer cents, got ${amountCents}`);
  }
  const bps = Number(process.env.WAPAY_DEPOSIT_FEE_BPS ?? 420);
  const fixedCents = Number(process.env.WAPAY_DEPOSIT_FEE_FIXED_CENTS ?? 230);
  const rawCents = Math.ceil((amountCents * bps) / 10000) + fixedCents;
  // Round UP to a whole rand for one-number explainability.
  return Math.ceil(rawCents / 100) * 100;
}

/**
 * Fee for a payment request paid by CARD — deducted from the REQUESTER's
 * credit (they don't choose it, the payer does), so it is rounded UP only to
 * the nearest 10 cents rather than a whole rand. Same rate as a deposit
 * (cost-plus over PayFast), but the gentler rounding removes the up-to-99c
 * whole-rand jump that made small requests read as punitive to the person
 * getting paid (founder feedback 2026-08-26). Still provably ≥ our PayFast
 * cost at every amount, and never MORE than the whole-rand fee.
 *
 * @param {number} amountCents - the request amount (what the payer pays)
 * @returns {number} fee in integer cents, rounded up to 10c
 */
export function paymentRequestFeeCents(amountCents) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`paymentRequestFeeCents requires positive integer cents, got ${amountCents}`);
  }
  const bps = Number(process.env.WAPAY_DEPOSIT_FEE_BPS ?? 420);
  const fixedCents = Number(process.env.WAPAY_DEPOSIT_FEE_FIXED_CENTS ?? 230);
  const rawCents = Math.ceil((amountCents * bps) / 10000) + fixedCents;
  return Math.ceil(rawCents / 10) * 10;
}

const TERMINAL_STATUSES = new Set(['SUCCESS', 'FAILED']);

/**
 * Deposit-status questions ("did my payment go through", "where is my
 * money", "payment status") — matched deterministically so the answer is
 * read from the intent table + ledger. The AI must NEVER invent transaction
 * status (founder review, 2026-08-18: it once improvised "your balance will
 * update shortly", which no code path could honour).
 *
 * Kept deliberately narrower than the deposit-link pattern: a phrase that
 * asks to MAKE a deposit ("I want to deposit money") must not read as a
 * status question.
 */
const DEPOSIT_STATUS_PATTERNS = [
  // "did/has/is/was … payment|deposit|money … go through/arrive/clear/…"
  /\b(?:did|has|have|is|was|when\s+(?:will|does|is))\b.{0,30}\b(?:payments?|paymnets?|deposits?|depsits?|deposites?|money|cash)\b.{0,40}\b(?:go(?:ne)?\s+through|went\s+through|arriv\w*|clear\w*|land\w*|receiv\w*|reflect\w*|show\w*|success\w*|credited|done|work\w*|in\s+yet)\b/i,
  // "where is my money / where's my deposit / wheres my payment"
  /\bwh?ere(?:'?s|\s+is|\s+are)\s+(?:my|the)\s+(?:money|payments?|deposits?|cash|funds?)\b/i,
  // "payment status" / "deposit status" / "status of my payment/deposit"
  /\b(?:payments?|deposits?|depsits?|deposites?)\s+status\b|\bstatus\s+of\s+my\s+(?:payments?|deposits?)\b/i,
];

/**
 * True when the text is a question about a deposit's status rather than a
 * request to make one. Pure — safe to unit-test without a database.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function matchDepositStatusRequest(text = '') {
  const s = String(text || '');
  return DEPOSIT_STATUS_PATTERNS.some((re) => re.test(s));
}

/**
 * lib/ledger-core.js rejects idemKeys containing digit runs that look like
 * epoch timestamps (13 digits, or 10 digits starting 16-19). A random UUID
 * contains such a run roughly once in a thousand draws — rare enough to pass
 * review, common enough to fail a real deposit — so ids are redrawn until
 * clean. Kept in sync with the guard inside ledger-core's entry().
 */
const TIMESTAMP_LOOKALIKE = /(?<!\d)1\d{12}(?!\d)|(?<!\d)1[6-9]\d{8}(?!\d)/;

/** A UUID that is guaranteed to survive ledger-core's idemKey guard. */
function newIntentId() {
  for (;;) {
    const id = crypto.randomUUID();
    if (!TIMESTAMP_LOOKALIKE.test(id)) return id;
  }
}

function requireString(v, name) {
  if (!v || typeof v !== 'string') throw new Error(`${name} is required`);
  return v;
}

/**
 * Integer cents -> rand string ('12345' -> '123.45'), pure integer math.
 * PayFast wire amounts are strings; float division/multiplication is banned
 * on the money path, so this is the ONLY cents->rand conversion to use.
 *
 * @param {number} cents - non-negative integer cents
 * @returns {string} e.g. '50.00'
 */
export function centsToRandString(cents) {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`centsToRandString requires a non-negative integer, got ${cents}`);
  }
  const rands = Math.trunc(cents / 100);
  const remainder = String(cents % 100).padStart(2, '0');
  return `${rands}.${remainder}`;
}

/**
 * Create a PENDING deposit intent before redirecting the customer to PayFast.
 *
 * The row id doubles as PayFast's m_payment_id; the derived idemKey is what
 * the ITN webhook later posts the ledger entry with.
 *
 * @param {object} args
 * @param {object} [args.prisma] - injectable for tests; defaults to the shared client
 * @param {string} args.accountId - WaPay account to credit on success
 * @param {string} args.waId - payer's WhatsApp id, for the confirmation message
 * @param {number} args.amountCents - integer cents, R10..R3000 inclusive
 * @returns {Promise<{paymentId: string, idemKey: string}>}
 */
export async function createDepositIntent({ prisma: prismaClient = prisma, accountId, waId, amountCents }) {
  requireString(accountId, 'accountId');
  requireString(waId, 'waId');
  if (!Number.isInteger(amountCents)) {
    throw new Error(`amountCents must be an integer number of cents, got ${amountCents}`);
  }
  if (amountCents < MIN_DEPOSIT_CENTS || amountCents > MAX_DEPOSIT_CENTS) {
    throw new Error(
      `Deposit must be between R${centsToRandString(MIN_DEPOSIT_CENTS)} and ` +
        `R${centsToRandString(MAX_DEPOSIT_CENTS)}, got R${centsToRandString(Math.max(amountCents, 0))}`
    );
  }

  const id = newIntentId();
  const idemKey = DEPOSIT_IDEM_PREFIX + id;

  // The customer pays gross (credit + payment fee); the wallet is credited
  // amountCents; the fee is WaPay revenue. All three are pinned on the
  // intent so the ITN webhook verifies and posts exactly what was quoted.
  const feeCents = depositFeeCents(amountCents);
  const grossCents = amountCents + feeCents;

  const row = await prismaClient.providerRequest.create({
    data: {
      id,
      provider: DEPOSIT_PROVIDER,
      route: DEPOSIT_ROUTE,
      idemKey,
      status: 'PENDING',
      accountId,
      metadata: { accountId, waId, amountCents, feeCents, grossCents },
    },
  });

  console.log(
    JSON.stringify({
      type: 'deposit_intent_created',
      paymentId: row.id,
      accountId,
      amountCents,
      feeCents,
      grossCents,
      idemKey,
      timestamp: new Date().toISOString(),
    })
  );

  return { paymentId: row.id, idemKey, feeCents, grossCents };
}

/**
 * Fetch a deposit intent by its id (= PayFast's m_payment_id).
 *
 * @param {object} args
 * @param {object} [args.prisma] - injectable for tests
 * @param {string} args.paymentId
 * @returns {Promise<object|null>} the ProviderRequest row, or null
 */
export async function getDepositIntent({ prisma: prismaClient = prisma, paymentId }) {
  requireString(paymentId, 'paymentId');
  return prismaClient.providerRequest.findUnique({ where: { id: paymentId } });
}

/**
 * The account's most recent deposit intent, any status — what "did my
 * payment go through" is answered from.
 *
 * @param {object} args
 * @param {object} [args.prisma] - injectable for tests
 * @param {string} args.accountId
 * @returns {Promise<object|null>} the newest ProviderRequest row, or null
 */
export async function getLatestDepositIntent({ prisma: prismaClient = prisma, accountId }) {
  requireString(accountId, 'accountId');
  return prismaClient.providerRequest.findFirst({
    where: { accountId, provider: DEPOSIT_PROVIDER, route: DEPOSIT_ROUTE },
    orderBy: { requestTs: 'desc' },
  });
}

/**
 * Record a deposit's terminal outcome.
 *
 * SUCCESS always wins: once a deposit is SUCCESS a late or duplicate failure
 * ITN must not flip it back, so the FAILED write is status-guarded (an atomic
 * conditional update, same pattern as the ledger's check-and-decrement).
 *
 * @param {object} args
 * @param {object} [args.prisma] - injectable for tests
 * @param {string} args.paymentId
 * @param {'SUCCESS'|'FAILED'} args.status
 * @param {string} [args.providerRef] - PayFast's pf_payment_id
 * @returns {Promise<object>} the row after the write
 */
export async function markDeposit({ prisma: prismaClient = prisma, paymentId, status, providerRef }) {
  requireString(paymentId, 'paymentId');
  if (!TERMINAL_STATUSES.has(status)) {
    throw new Error(`markDeposit status must be SUCCESS or FAILED, got ${status}`);
  }

  let row;
  if (status === 'FAILED') {
    const updated = await prismaClient.providerRequest.updateMany({
      where: { id: paymentId, status: { not: 'SUCCESS' } },
      data: { status, providerRef: providerRef ?? undefined },
    });
    row = await prismaClient.providerRequest.findUnique({ where: { id: paymentId } });
    if (!row) throw new Error(`No deposit intent ${paymentId}`);
    if (updated.count === 0) {
      // Already SUCCESS — keep it, and say so in the logs.
      console.log(
        JSON.stringify({
          type: 'deposit_mark_ignored',
          paymentId,
          attempted: status,
          kept: row.status,
          timestamp: new Date().toISOString(),
        })
      );
      return row;
    }
  } else {
    row = await prismaClient.providerRequest.update({
      where: { id: paymentId },
      data: { status, providerRef: providerRef ?? undefined },
    });
  }

  console.log(
    JSON.stringify({
      type: 'deposit_marked',
      paymentId,
      status: row.status,
      providerRef: providerRef ?? null,
      timestamp: new Date().toISOString(),
    })
  );

  return row;
}

/**
 * Attach a raw ITN payload to the intent's metadata for forensics — the
 * UniFuel lesson: storing raw_itn on every payment is what made the March
 * 2026 signature outage diagnosable. Never changes status.
 *
 * Read-modify-write on a Json column (not atomic); acceptable for debug data.
 *
 * @param {object} args
 * @param {object} [args.prisma] - injectable for tests
 * @param {string} args.paymentId
 * @param {object} args.rawItn - parsed ITN fields as sent by PayFast
 * @param {string} [args.reason] - why it was rejected, if it was
 * @param {string} [args.sourceIp]
 * @returns {Promise<object|null>} the updated row, or null if no such intent
 */
export async function recordItnDebug({ prisma: prismaClient = prisma, paymentId, rawItn, reason, sourceIp }) {
  requireString(paymentId, 'paymentId');
  const row = await prismaClient.providerRequest.findUnique({ where: { id: paymentId } });
  if (!row) return null;

  const metadata = {
    ...(row.metadata ?? {}),
    lastItn: rawItn ?? null,
    lastItnReason: reason ?? null,
    lastItnSourceIp: sourceIp ?? null,
    lastItnAt: new Date().toISOString(),
  };

  return prismaClient.providerRequest.update({ where: { id: paymentId }, data: { metadata } });
}
