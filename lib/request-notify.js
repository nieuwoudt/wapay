/**
 * Durable, idempotent "request PAID" notifications.
 *
 * ROOT CAUSE (founder live test PRMDCUQA, 2026-08-25): both sends were gated
 * on winning the PENDING->PAID transition — which happens exactly once. When
 * the ITN invocation died mid-sends (no maxDuration on the route; PayFast's
 * server-verify POST-back + two WhatsApp sends can outrun the default cap),
 * the retry delivery could not win the transition again, so the requester
 * and the payer were never notified — with no repair path.
 *
 * THE FIX: notification state lives in the intent's metadata
 * (requesterNotifiedAt / payerNotifiedAt), set ONLY after a send succeeds.
 * This function runs on EVERY ITN delivery for a PAID request — replayed or
 * not — and on the admin repair route. Flags make it exactly-once-effective;
 * redeliveries and repairs make it eventually-delivered.
 *
 * Never throws. The ITN's 200 must never depend on messaging.
 */

import defaultPrisma from './prisma.js';
import { sendWhatsAppText, sendWhatsAppTemplate, sendWhatsAppUtilityDirect, directSendEnabled } from '@wapay/whatsapp';
import { maskedRequesterLabel } from './payment-requests.js';
import { centsToRandString } from './deposits.js';

function log(type, data) {
  console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));
}

/**
 * Deliver (or repair) both notifications for a PAID payment request.
 *
 * @param {object} args
 * @param {string} args.code - request code (PRXXXXXX)
 * @param {object} [args.prisma] - injectable for tests
 * @param {object} [args.send] - injectable send fns for tests
 * @returns {Promise<{requester: string, payer: string}>} outcome per leg:
 *   'sent' | 'already' | 'failed' | 'skipped'
 */
export async function deliverRequestPaidNotifications({
  code,
  prisma = defaultPrisma,
  send = { text: sendWhatsAppText, template: sendWhatsAppTemplate, direct: sendWhatsAppUtilityDirect },
}) {
  const out = { requester: 'skipped', payer: 'skipped' };
  let intent;
  try {
    const request = await prisma.paymentRequest.findUnique({ where: { id: code.toUpperCase() } });
    if (!request || request.status !== 'PAID') return out;

    intent = await prisma.providerRequest.findUnique({ where: { idemKey: `wapay-payreq-${code.toUpperCase()}` } });
    if (!intent?.metadata) return out;
    const meta = intent.metadata;

    const creditCents = Number.isInteger(meta.amountCents) ? meta.amountCents : request.amountCents;
    const grossCents = Number.isInteger(meta.grossCents) ? meta.grossCents : request.amountCents;
    const pfRef = intent.providerRef || null;

    // --- Requester leg -----------------------------------------------------
    if (meta.requesterNotifiedAt) {
      out.requester = 'already';
    } else if (meta.waId) {
      let delivered = false;
      const lines = [`💸 Your payment request was PAID: R${centsToRandString(creditCents)} received!`];
      // WaPay for Business (2026-09-04): tell the owner WHICH customer and
      // ticket paid, so the chat receipt reconciles itself. Cosmetic: never
      // blocks the notification.
      if (request.businessId) {
        try {
          const parts = [];
          if (request.customerId) {
            const c = await prisma.businessCustomer.findUnique({ where: { id: request.customerId } });
            if (c) parts.push(`from ${c.name || c.msisdn}`);
          }
          if (request.reference) parts.push(`ref ${request.reference}`);
          if (parts.length) lines.push(`🧾 ${parts.join(' · ')}`);
        } catch {
          // Owner still learns they were paid.
        }
      }
      try {
        const wallet = await prisma.wallet.findFirst({
          where: { accountId: meta.accountId, balanceType: 'SPEND' },
        });
        if (wallet) lines.push(`New balance: R${centsToRandString(wallet.availableCents)}`);
      } catch {
        // Balance line is a nicety; the notification matters more.
      }
      const sent = await send.text({ to: meta.waId, text: lines.join('\n') });
      if (sent?.ok) delivered = true;
      else {
        log('request_notify_requester_text_failed', { code, error: sent?.error });
        // Paid on day 6 = outside the requester's 24h window. Direct Send
        // (Meta beta, 2026-09) delivers the same text as a UTILITY message
        // with no template — try it before falling back to the template.
        if (directSendEnabled()) {
          const direct = await send.direct({ to: meta.waId, text: lines.join('\n') });
          if (direct?.ok) delivered = true;
          else log('request_notify_requester_direct_failed', { code, error: direct?.error });
        }
        // The approved template is the rail of last resort.
        const tplName = process.env.WAPAY_TEMPLATE_REQUEST_PAID || '';
        if (!delivered && tplName) {
          const tpl = await send.template({
            to: meta.waId,
            templateName: tplName,
            language: 'en',
            components: [{
              type: 'body',
              parameters: [
                { type: 'text', text: `R${centsToRandString(creditCents)}` },
                { type: 'text', text: code.toUpperCase() },
              ],
            }],
          });
          if (tpl?.ok) delivered = true;
          else log('request_notify_requester_template_failed', { code, error: tpl?.error });
        }
      }
      out.requester = delivered ? 'sent' : 'failed';
      if (delivered) {
        await persistFlag(prisma, intent, { requesterNotifiedAt: new Date().toISOString() });
        intent = { ...intent, metadata: { ...intent.metadata, requesterNotifiedAt: true } };
      }
    }

    // --- Payer leg (card payments with a captured number only) -------------
    const payerMsisdn = /^0\d{9}$/.test(String(meta.payerMsisdn || '')) ? meta.payerMsisdn : null;
    if (meta.payerNotifiedAt) {
      out.payer = 'already';
    } else if (payerMsisdn) {
      let delivered = false;
      const payerWaId = `27${payerMsisdn.slice(1)}`;
      let requesterLabel = 'the requester';
      try {
        const requester = await prisma.account.findUnique({ where: { id: meta.accountId } });
        requesterLabel = maskedRequesterLabel(requester);
      } catch {
        // Cosmetic only.
      }
      const paidRands = centsToRandString(grossCents);
      const refLine = pfRef ? `Ref: PF ${pfRef} · ${code.toUpperCase()}` : `Ref: ${code.toUpperCase()}`;
      const sent = await send.text({
        to: payerWaId,
        text:
          `🧾 Payment confirmed: R${paidRands} to ${requesterLabel} ✅\n` +
          `${refLine}\n` +
          `This message is your receipt.`,
      });
      if (sent?.ok) delivered = true;
      else {
        log('request_notify_payer_text_failed', { code, error: sent?.error });
        // A payer who never messaged us has no service window. Direct Send
        // (UTILITY category, receipt = squarely transactional) reaches them
        // without a template when the beta is enabled.
        if (directSendEnabled()) {
          const direct = await send.direct({
            to: payerWaId,
            text:
              `🧾 Payment confirmed: R${paidRands} to ${requesterLabel} ✅\n` +
              `${refLine}\n` +
              `This message is your receipt.`,
          });
          if (direct?.ok) delivered = true;
          else log('request_notify_payer_direct_failed', { code, error: direct?.error });
        }
        // The approved Utility receipt template is the rail of last resort.
        const tplName = process.env.WAPAY_TEMPLATE_PAYMENT_RECEIPT || '';
        if (!delivered && tplName) {
          const tpl = await send.template({
            to: payerWaId,
            templateName: tplName,
            language: 'en',
            components: [{
              type: 'body',
              parameters: [
                { type: 'text', text: `R${paidRands}` },
                { type: 'text', text: requesterLabel },
                { type: 'text', text: String(pfRef || code.toUpperCase()) },
              ],
            }],
          });
          if (tpl?.ok) delivered = true;
          else log('request_notify_payer_template_failed', { code, error: tpl?.error });
        }
      }
      out.payer = delivered ? 'sent' : 'failed';
      if (delivered) {
        await persistFlag(prisma, intent, { payerNotifiedAt: new Date().toISOString() });
      }
    }
  } catch (error) {
    log('request_notify_error', { code, error: error?.message });
  }
  return out;
}

/** Merge a flag into intent metadata — MERGE, never replace (BUGLOG #24). */
async function persistFlag(prisma, intent, patch) {
  try {
    await prisma.providerRequest.update({
      where: { idemKey: intent.idemKey },
      data: { metadata: { ...intent.metadata, ...patch } },
    });
  } catch (error) {
    // Worst case: a redelivery re-sends one message. Better than losing it.
    log('request_notify_flag_error', { idemKey: intent.idemKey, error: error?.message });
  }
}
