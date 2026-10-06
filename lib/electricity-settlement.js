/**
 * Electricity settlement + reconciliation: the ONE place a vended token
 * becomes ledger truth, shared by /api/vas/electricity/execute.js and the
 * reconciler for sales that ran out of time at our end.
 *
 * Why this exists (2026-10-06): Blu answers electricity slowly (QA took more
 * than 30 s on a meter lookup; the sale is documented at up to ~90 s) and the
 * Vercel function waiting for it is capped. A sale that times out is
 * INDETERMINATE: Blu may have vended. So the execute route keeps the hold,
 * marks the row RECONCILE, and this module later sends the SAME requestId
 * again. Blu caches by requestId, so a vended sale replays its original
 * result (token delivered, hold settled) and an unvended one vends now; a
 * definitive refusal releases the money. Every path is idempotent by
 * previewId-derived keys, so execute, a retry and the reconciler can all run
 * over the same purchase safely.
 *
 * The token is a bearer secret: it is kept only on the ProviderRequest row
 * (responseJson, as the execute route always did, for receipt recovery) and
 * handed back to the caller for delivery; it is never logged.
 */

import prisma from './prisma.js';
import { BALANCE, RAIL, buildSpend } from './ledger-core.js';
import { settleHold, releaseHold } from './ledger-post.js';
import { buildElectricitySalePayload } from './electricity-utils.js';
import { sendOpsAlert } from './email.js';

function logStructured(type, data) {
  console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));
}

export const electricityExecKey = (previewId) => `wapay-elec-exec-${previewId}`;
export const electricitySpendKey = (previewId) => `wapay-elec-spend-${previewId}`;

/** A RECONCILE row is taken over at once; an EXECUTING row only once its invocation is surely dead. */
export const EXECUTING_STALE_MS = 120_000;

/**
 * Turn a vended token into settled ledger truth. settleHold clears the hold
 * and posts the spend in one transaction, so the customer is debited exactly
 * once even if this runs twice (postEntry replays on the spend idemKey).
 */
export async function settleVendedElectricity({ previewId, accountId, metadata, bluResult, deps = {} }) {
  const db = deps.prisma || prisma;
  const settle = deps.settleHold || settleHold;
  const totalCents = metadata.totalCents;
  // buildSpend books: Dr WALLET:{acct}:SPEND, Cr CLEARING:BLU (supplier cost),
  // Cr REVENUE:COMMISSION:ELECTRICITY (our margin).
  const spendEntry = buildSpend({
    accountId,
    category: 'ELECTRICITY',
    saleCents: totalCents,
    idemKey: electricitySpendKey(previewId),
    rail: RAIL.BLU,
    balanceType: BALANCE.SPEND,
  });
  await settle({ idemKey: electricityExecKey(previewId), entry: spendEntry });
  await db.providerRequest.update({
    where: { id: previewId },
    data: {
      status: 'SUCCESS',
      providerRef: bluResult.providerRef,
      responseJson: JSON.stringify(bluResult),
      metadata: { ...metadata, providerRef: bluResult.providerRef, settledAt: new Date().toISOString() },
    },
  });
  const wallet = await db.wallet.findFirst({ where: { accountId, balanceType: BALANCE.SPEND } });
  return { newBalanceCents: wallet?.availableCents ?? null };
}

/**
 * Resolve this account's indeterminate electricity purchases: RECONCILE rows
 * (the sale timed out at our end) and EXECUTING rows whose invocation died
 * before it could say either way. Re-sends the same requestId and reference;
 * Blu's requestId idempotency makes that safe.
 *
 * Returns { settled, failed, pending, delivered: [...], failedAmounts: [...] }
 * so the caller (the message processor or the cron) can deliver the token or
 * speak to the customer honestly. Nothing here sends a WhatsApp message.
 */
/** Opportunistic re-sends (on a customer's turn) wait this long for Blu and are spaced at least this far apart per row. */
export const OPPORTUNISTIC_SALE_TIMEOUT_MS = 15_000;
export const OPPORTUNISTIC_MIN_GAP_MS = 2 * 60_000;

/**
 * @param {object} args
 * @param {object} args.account
 * @param {number} [args.limit]
 * @param {boolean} [args.opportunistic] true on the customer's own turn: one
 *   short-bounded attempt per row, at most every two minutes, so the webhook
 *   turn never blows Meta's window. The cron runs without it (full wait).
 */
export async function reconcileElectricityPurchases({ account, limit = 3, opportunistic = false, deps = {} }) {
  const db = deps.prisma || prisma;
  const release = deps.releaseHold || releaseHold;
  const alert = deps.sendOpsAlert || sendOpsAlert;
  const now = deps.now ? deps.now() : Date.now();
  const saleTimeoutMs = opportunistic ? (deps.saleTimeoutMs || OPPORTUNISTIC_SALE_TIMEOUT_MS) : deps.saleTimeoutMs;
  const out = { settled: 0, failed: 0, pending: 0, delivered: [], failedAmounts: [] };
  let rows = [];
  try {
    rows = await db.providerRequest.findMany({
      where: { accountId: account.id, route: 'electricity-preview', status: { in: ['RECONCILE', 'EXECUTING'] } },
      orderBy: { requestTs: 'asc' },
      take: limit,
    });
  } catch {
    return out;
  }
  if (!rows.length) return out;

  let client = deps.client || null;
  if (!client) {
    try {
      const { BluVasExtendedClient } = await import('@wapay/providers-blu');
      client = new BluVasExtendedClient();
    } catch (error) {
      logStructured('electricity_reconcile_no_client', { error: error?.message });
      out.pending += rows.length;
      return out;
    }
  }

  for (const row of rows) {
    const meta = row.metadata || {};
    if (row.status === 'EXECUTING') {
      const startedAt = Date.parse(meta.executingAt || '') || 0;
      if (now - startedAt < EXECUTING_STALE_MS) {
        out.pending += 1;
        continue;
      }
    }
    const idemKey = electricityExecKey(row.id);
    const previewId = row.id;
    if (opportunistic) {
      const last = Date.parse(meta.lastReconcileAt || '') || 0;
      if (now - last < OPPORTUNISTIC_MIN_GAP_MS) {
        out.pending += 1;
        continue;
      }
    }
    try {
      // Only a row whose money is still held may be re-sent. A released hold
      // means a crash path already gave the money back (the row is closed
      // here so it is never looked at again); a settled hold means the sale
      // completed and only the row update was lost (left for an operator,
      // nothing is re-sent).
      const hold = await db.hold.findUnique({ where: { idemKey } });
      if (!hold || hold.status === 'RELEASED') {
        await db.providerRequest.update({ where: { id: previewId }, data: { status: 'FAILED' } });
        out.failed += 1;
        logStructured('electricity_reconcile_closed_no_active_hold', { previewId, holdStatus: hold?.status || 'NONE' });
        continue;
      }
      if (hold.status !== 'ACTIVE') {
        out.pending += 1;
        logStructured('electricity_reconcile_hold_not_active', { previewId, holdStatus: hold.status });
        continue;
      }
      if (!meta.reference) {
        // Without the quote reference no sale can ever have been sent: safe to release.
        await release({ idemKey, reason: 'electricity_reconcile_no_reference' });
        await db.providerRequest.update({ where: { id: previewId }, data: { status: 'FAILED' } });
        out.failed += 1;
        out.failedAmounts.push(meta.totalCents || meta.amountCents || 0);
        continue;
      }
      const payload = buildElectricitySalePayload({
        draft: {
          meterNumber: meta.meterNumber,
          amountCents: meta.amountCents,
          reference: meta.reference,
          transactionTypeId: meta.transactionTypeId,
          utility: meta.utility,
          consumer: meta.consumer,
        },
        accountId: account.id,
        idemKey,
      });
      await db.providerRequest.update({
        where: { id: previewId },
        data: { metadata: { ...meta, lastReconcileAt: new Date(now).toISOString() } },
      }).catch(() => {});
      const bluResult = await client.purchaseElectricity(payload, saleTimeoutMs ? { timeoutMs: saleTimeoutMs } : {});
      const { newBalanceCents } = await settleVendedElectricity({ previewId, accountId: account.id, metadata: meta, bluResult, deps });
      out.settled += 1;
      out.delivered.push({
        previewId,
        meterNumber: meta.meterNumber,
        amountCents: meta.amountCents,
        providerRef: bluResult.providerRef,
        token: bluResult.token,
        units: bluResult.units,
        dateTime: bluResult.dateTime,
        newBalanceCents,
      });
      logStructured('electricity_reconcile_settled', { previewId, providerRef: bluResult.providerRef });
    } catch (error) {
      const kind = error?.message;
      if (kind === 'USER_INPUT' || kind === 'AUTH' || kind === 'UPSTREAM_FAILURE') {
        // Definitive: Blu refused the sale, so nothing was vended. Give the money back.
        await release({ idemKey, reason: `electricity_reconcile_refused:${String(error?.reason || kind).slice(0, 60)}` });
        await db.providerRequest.update({ where: { id: previewId }, data: { status: 'FAILED' } });
        out.failed += 1;
        out.failedAmounts.push(meta.totalCents || meta.amountCents || 0);
        logStructured('electricity_reconcile_released', { previewId, kind, reason: error?.reason });
      } else {
        // TIMEOUT or RETRYABLE: still indeterminate; keep the hold, try again later.
        out.pending += 1;
        logStructured('electricity_reconcile_still_pending', { previewId, kind, reason: error?.reason });
      }
    }
  }

  if (out.pending > 0) {
    alert({
      subject: 'Electricity purchases still awaiting reconciliation',
      detailsHtml: `${out.pending} electricity purchase(s) for account ${account.id} remain indeterminate. Holds are kept; the next customer message and the nightly cron retry.`,
    }).catch(() => {});
  }
  return out;
}
