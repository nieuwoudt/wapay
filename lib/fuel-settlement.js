/**
 * Fuel purchase settlement + reconciliation — the ONE place an issued
 * wiCode becomes ledger truth, shared by /api/vas/fuel/execute.js and the
 * opportunistic reconciler (adversarial review 2026-08-29: a RECONCILE
 * preview must always have a reachable path back to settled-or-released,
 * or the customer's hold leaks by construction).
 *
 * Everything here is idempotent by previewId-derived keys, so execute,
 * a retry, and the reconciler can all run over the same purchase safely.
 * The wiCode remains a bearer secret: its only sink is createPendingGift.
 */

import prisma from './prisma.js';
import { BALANCE, RAIL, buildSpend } from './ledger-core.js';
import { settleHold, releaseHold } from './ledger-post.js';
import { createPendingGift } from './pending-gifts.js';
import { orderStatus } from './unifuel-client.js';
import { sendOpsAlert } from './email.js';

function logStructured(type, data) {
  console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));
}

/**
 * The compact service reference for a fuel preview. Yoyo's userRef
 * ("wapay:"+reference) hard-fails above ~45 chars (probed 2026-08-29),
 * so 27 hex chars of the preview UUID, 38 chars total.
 */
export function fuelReference(previewId) {
  return `wapay-fuel-${String(previewId).replace(/^preview-fuel-/, '').replace(/-/g, '')}`.slice(0, 38);
}

/** Commission on fuel spend: 0 until a rate is signed (env overrides). */
export function fuelCommissionBps() {
  const bpsVal = Number(process.env.WAPAY_WICODE_COMMISSION_BPS);
  return Number.isInteger(bpsVal) && bpsVal >= 0 ? bpsVal : 0;
}

/**
 * Turn an ISSUED outcome into settled ledger truth + a claimable gift.
 * Idempotent end to end; safe to call again after any partial failure.
 */
export async function settleIssuedFuelPurchase({ previewId, accountId, msisdn, amountCents, feeCents, wicode, giftcardId, reference }) {
  const spendEntry = buildSpend({
    accountId,
    category: 'FUEL',
    saleCents: amountCents,
    idemKey: `wapay-fuel-spend-${previewId}`,
    rail: RAIL.YOYO,
    commissionBpsOverride: fuelCommissionBps(),
    // The preview's quote is the quote of record (0 at launch).
    flatFeeCents: Number.isInteger(feeCents) && feeCents > 0 ? feeCents : 0,
  });
  await settleHold({ idemKey: `wapay-fuel-exec-${previewId}`, entry: spendEntry });

  await createPendingGift({
    senderAccountId: accountId,
    recipientMsisdn: msisdn,
    amountCents,
    voucherPin: wicode,
    voucherSerial: giftcardId != null ? String(giftcardId) : null,
    rail: RAIL.YOYO,
    idemKey: `wapay-fuel-gift-${previewId}`,
  });

  await prisma.providerRequest.update({
    where: { id: previewId },
    data: { status: 'SUCCESS', providerRef: reference },
  });
}

/**
 * Opportunistic reconciler: resolve this account's indeterminate fuel
 * purchases (RECONCILE rows, plus EXECUTING rows whose invocation died).
 * UniFuel's order endpoint settles the truth against Yoyo, so every row
 * eventually lands on settled-and-claimable or released-with-apology.
 *
 * Returns { settled, failed, pending } counts so the caller (the message
 * processor) can speak to the customer honestly.
 */
export async function reconcileFuelPurchases({ account, limit = 3 }) {
  const out = { settled: 0, failed: 0, pending: 0, failedAmounts: [] };
  let rows = [];
  try {
    rows = await prisma.providerRequest.findMany({
      where: {
        accountId: account.id,
        route: 'fuel-preview',
        status: { in: ['RECONCILE', 'EXECUTING'] },
      },
      orderBy: { requestTs: 'asc' },
      take: limit,
    });
  } catch {
    return out;
  }

  for (const row of rows) {
    const meta = row.metadata || {};
    // A live EXECUTING row belongs to a running invocation — only take it
    // over once it is definitively stale (its owner stamps executingAt).
    if (row.status === 'EXECUTING') {
      const startedAt = Date.parse(meta.executingAt || '') || 0;
      if (Date.now() - startedAt < 120_000) {
        out.pending += 1;
        continue;
      }
    }
    const reference = row.providerRef || fuelReference(row.id);
    try {
      const outcome = await orderStatus(reference);
      if (outcome.outcome === 'ISSUED' && outcome.wicode) {
        await settleIssuedFuelPurchase({
          previewId: row.id,
          accountId: account.id,
          msisdn: account.msisdn,
          amountCents: meta.amountCents,
          feeCents: meta.feeCents,
          wicode: outcome.wicode,
          giftcardId: outcome.giftcardId,
          reference,
        });
        out.settled += 1;
        logStructured('fuel_reconcile_settled', { previewId: row.id, reference });
      } else if (outcome.outcome === 'FAILED') {
        await releaseHold({
          idemKey: `wapay-fuel-exec-${row.id}`,
          reason: `fuel_reconcile_failed:${outcome.code || 'FAILED'}`,
        });
        await prisma.providerRequest.update({ where: { id: row.id }, data: { status: 'FAILED' } });
        out.failed += 1;
        out.failedAmounts.push(meta.amountCents || 0);
        logStructured('fuel_reconcile_released', { previewId: row.id, reference, code: outcome.code });
      } else {
        out.pending += 1;
        logStructured('fuel_reconcile_still_pending', { previewId: row.id, reference, code: outcome.code });
      }
    } catch (error) {
      out.pending += 1;
      logStructured('fuel_reconcile_error', { previewId: row.id, error: error?.message });
    }
  }

  if (out.pending > 0) {
    sendOpsAlert({
      subject: 'Fuel purchases still awaiting reconciliation',
      detailsHtml: `${out.pending} fuel purchase(s) for account ${account.id} remain indeterminate. Holds are kept; the next customer message retries.`,
    }).catch(() => {});
  }
  return out;
}
