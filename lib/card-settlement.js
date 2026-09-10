/**
 * Settle a card-rail payment against an intent, the way the PayFast ITN
 * does (pages/api/payfast/itn.js is the reference and stays untouched; this
 * is the same sequence for the other card rails, Adumo first, 2026-09-10):
 *
 *   ensureWallet → postEntry(buildLoad, idemKey = the intent's) → markDeposit
 *   → markRequestPaid (atomic PENDING→PAID) → overpayment scream on a replay
 *   with a different provider reference → notifications (idempotent).
 *
 * Call it ONLY after the rail's own verification (a signed response token,
 * a verified webhook). Idempotent by construction: the ledger dedupes on the
 * intent's idemKey, markRequestPaid is a check-and-set, and the notify
 * helper keeps its own flags.
 */

import { sendWhatsAppText } from '@wapay/whatsapp';
import prisma from './prisma.js';
import { markDeposit, centsToRandString } from './deposits.js';
import { markRequestPaid } from './payment-requests.js';
import { deliverRequestPaidNotifications } from './request-notify.js';
import { noteDepositMethod } from './user-profile.js';
import { postEntry, ensureWallet } from './ledger-post.js';
import { buildLoad, BALANCE } from './ledger-core.js';

const log = (type, data) => console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));

/**
 * @param {object} args
 * @param {object} args.intent - the providerRequest row (route payrequest|deposit)
 * @param {string} args.rail - ledger RAIL (e.g. 'ADUMO')
 * @param {string} args.providerRef - the rail's transaction reference
 * @param {string|null} [args.payerMsisdn] - 0-form number of the payer, if the rail told us
 * @returns {Promise<{ok: boolean, replayed?: boolean, wonRequestTransition?: boolean, error?: string}>}
 */
export async function settleCardPayment({ prisma: prismaClient = prisma, intent, rail, providerRef, payerMsisdn = null }) {
  const { accountId, waId, amountCents } = intent?.metadata ?? {};
  if (!intent?.idemKey || !accountId || !Number.isInteger(amountCents) || amountCents <= 0) {
    log('card_settlement_intent_corrupt', { paymentId: intent?.id, rail });
    return { ok: false, error: 'INTENT_CORRUPT' };
  }
  const feeCents = Number.isInteger(intent.metadata?.feeCents) ? intent.metadata.feeCents : 0;
  const requestCode = intent.metadata?.requestCode || null;

  let posted;
  try {
    await ensureWallet({ accountId });
    posted = await postEntry(buildLoad({ accountId, rail, faceCents: amountCents, customerFeeCents: feeCents, idemKey: intent.idemKey }));
    await markDeposit({ prisma: prismaClient, paymentId: intent.id, status: 'SUCCESS', providerRef });
    if (intent.route === 'deposit') noteDepositMethod({ accountId, method: 'CARD' }).catch(() => {});
  } catch (error) {
    log('card_settlement_credit_error', { paymentId: intent.id, rail, idemKey: intent.idemKey, error: error?.message });
    return { ok: false, error: 'CREDIT_FAILED' };
  }
  log('card_settlement_credited', { paymentId: intent.id, rail, idemKey: intent.idemKey, amountCents, feeCents, providerRef, replayed: posted.replayed });

  let wonRequestTransition = false;
  if (requestCode) {
    try {
      wonRequestTransition = await markRequestPaid({ prisma: prismaClient, code: requestCode, payerRef: `${rail}:${providerRef}` });
    } catch (error) {
      log('card_settlement_mark_paid_error', { paymentId: intent.id, requestCode, error: error?.message });
    }
    if (posted.replayed && intent.providerRef && intent.providerRef !== providerRef) {
      // The same request settled twice with two different provider references:
      // the credit stayed exactly-once, the second charge needs a refund.
      console.error(JSON.stringify({ type: 'card_overpayment_detected', severity: 'CRITICAL_REFUND_NEEDED', rail, paymentId: intent.id, requestCode, creditedRef: intent.providerRef, duplicateRef: providerRef }));
    }
  }

  if (waId && !requestCode && !posted.replayed) {
    try {
      const wallet = await prismaClient.wallet.findFirst({ where: { accountId, balanceType: BALANCE.SPEND } });
      const lines = [`✅ Deposit received: R${centsToRandString(amountCents)}`];
      if (wallet) lines.push(`New balance: R${centsToRandString(wallet.availableCents)}`);
      await sendWhatsAppText({ to: waId, text: lines.join('\n') }).catch(() => null);
    } catch {
      // cosmetic
    }
  }

  if (requestCode) {
    try {
      if (payerMsisdn && /^0\d{9}$/.test(payerMsisdn) && intent.metadata?.payerMsisdn !== payerMsisdn) {
        await prismaClient.providerRequest.update({ where: { idemKey: intent.idemKey }, data: { metadata: { ...intent.metadata, payerMsisdn } } }).catch(() => {});
      }
      const outcome = await deliverRequestPaidNotifications({ code: requestCode });
      log('card_settlement_request_notify', { paymentId: intent.id, requestCode, ...outcome });
    } catch (error) {
      log('card_settlement_request_notify_error', { paymentId: intent.id, error: error?.message });
    }
  }
  return { ok: true, replayed: posted.replayed, wonRequestTransition };
}
