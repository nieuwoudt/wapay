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

const TERMINAL_STATUSES = new Set(['SUCCESS', 'FAILED']);

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

  const row = await prismaClient.providerRequest.create({
    data: {
      id,
      provider: DEPOSIT_PROVIDER,
      route: DEPOSIT_ROUTE,
      idemKey,
      status: 'PENDING',
      accountId,
      metadata: { accountId, waId, amountCents },
    },
  });

  console.log(
    JSON.stringify({
      type: 'deposit_intent_created',
      paymentId: row.id,
      accountId,
      amountCents,
      idemKey,
      timestamp: new Date().toISOString(),
    })
  );

  return { paymentId: row.id, idemKey };
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
