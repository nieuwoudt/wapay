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
import { sendWhatsAppTemplate, sendWhatsAppUtilityDirect, directSendEnabled } from '@wapay/whatsapp';
import { sendWhatsAppText } from './say.js';
import { maskedRequesterLabel } from './payment-requests.js';
import { businessPaidLine } from './business.js';
import { centsToRandString } from './deposits.js';
import { payerPreregisterFor, receiptV2TemplateFor } from './onboarding-flags.js';
import { preRegisterPayer as realPreRegisterPayer, receiptV2TemplateMessage, receiptV2Name } from './payer-preregister.js';

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
/**
 * Is this person's 24-hour service window open? (2026-10-23) Meta's API ACCEPTS a plain text sent
 * outside the window and rejects it seconds later on the status webhook (131047), so "sent ok" never
 * meant delivered: the receipt text to a payer who had never written was accepted, then dropped, and
 * the approved template that would have reached them was never tried. The window is decided here,
 * before choosing the rail: the person's last message to WaPay, or the moment their account opened
 * from their first message (a pre-registered payer's account does not count). Unknown → true, so a
 * read failure keeps the old behaviour rather than silencing a notice.
 */
async function serviceWindowOpen(prisma, { accountId = null, waId = null, now = Date.now() } = {}) {
  try {
    if (!prisma?.account?.findFirst || !prisma?.conversationTurn?.findFirst) return true;
    const account = accountId
      ? await prisma.account.findFirst({ where: { id: accountId }, select: { id: true, createdAt: true, profile: true } })
      : waId ? await prisma.account.findFirst({ where: { waId }, select: { id: true, createdAt: true, profile: true } }) : null;
    if (!account) return false;
    const last = await prisma.conversationTurn.findFirst({ where: { accountId: account.id, role: 'user' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const opened = account.profile?.origin?.kind === 'PAYER' ? null : account.createdAt;
    const lastAt = Math.max(last ? new Date(last.createdAt).getTime() : 0, opened ? new Date(opened).getTime() : 0);
    return lastAt > 0 && now - lastAt < 24 * 60 * 60 * 1000;
  } catch {
    return true;
  }
}

export async function deliverRequestPaidNotifications({
  code,
  prisma = defaultPrisma,
  send = { text: sendWhatsAppText, template: sendWhatsAppTemplate, direct: sendWhatsAppUtilityDirect },
  preRegisterPayer = realPreRegisterPayer,
}) {
  const out = { requester: 'skipped', payer: 'skipped' };
  let intent;
  try {
    const request = await prisma.paymentRequest.findUnique({ where: { id: code.toUpperCase() } });
    if (!request || request.status !== 'PAID') return out;

    // Referrals (docs/REFERRALS.md, 2026-10-20): the requester's first paid link, on any rail, qualifies the
    // invite that brought them. Idempotent and never throws; a failure here never costs a notification.
    try {
      const { onLinkPaid } = await import('./referrals.js');
      await onLinkPaid({ prisma, accountId: request.accountId });
    } catch (error) {
      log('request_notify_referral_error', { code, error: error?.message });
    }

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
      let lines = [`💸 Your payment request was PAID: R${centsToRandString(creditCents)} received!`];
      // An ad arrival (docs/AD_CHAT_FLOW.md section 7) gets the short shape:
      // paid, in your balance, send me the next one. Best-effort lookup.
      try {
        const requester = await prisma.account.findUnique({ where: { id: meta.accountId }, select: { profile: true } });
        if (requester?.profile?.acquisitionSource === 'ad') {
          const { adPaidCopy } = await import('./ad-flow.js');
          lines = [adPaidCopy({ amountCents: creditCents })];
        }
      } catch {
        // The standard line stands.
      }
      // WaPay for Business (2026-09-04): tell the owner WHICH customer and
      // ticket paid, so the chat receipt reconciles itself. Cosmetic: never
      // blocks the notification.
      if (request.businessId) {
        const line = await businessPaidLine({ prisma, request });
        if (line) lines.push(line);
      }
      try {
        const wallet = await prisma.wallet.findFirst({
          where: { accountId: meta.accountId, balanceType: 'SPEND' },
        });
        if (wallet) lines.push(`New balance: R${centsToRandString(wallet.availableCents)}`);
      } catch {
        // Balance line is a nicety; the notification matters more.
      }
      const requesterOpen = await serviceWindowOpen(prisma, { accountId: meta.accountId });
      const sent = requesterOpen ? await send.text({ to: meta.waId, text: lines.join('\n') }) : { ok: false, error: 'WINDOW_CLOSED' };
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
      // C (WAPAY_PAYER_PREREGISTER, 2026-10-22): a payer whose number has no account gets an S0
      // record now (lib/payer-preregister.js), so their history exists when they ever write.
      // POPIA: the number was given for this receipt; it is used for nothing else until they
      // write to WaPay. No message beyond the receipt below. Never blocks or fails the receipt.
      if (payerPreregisterFor(payerWaId)) {
        await Promise.resolve(preRegisterPayer({ prisma, payerMsisdn, requestCode: code.toUpperCase(), paidAt: request.paidAt || null, referrerAccountId: meta.accountId || null }))
          .catch((error) => log('request_notify_preregister_error', { code, error: error?.message }));
      }
      let requesterLabel = 'the requester';
      let receiptName = 'a WaPay user';
      try {
        const requester = await prisma.account.findUnique({ where: { id: meta.accountId } });
        requesterLabel = maskedRequesterLabel(requester);
        receiptName = receiptV2Name({ requester });
        // A business ticket's receipt names the business, like the pay page.
        if (request.businessId) {
          const b = await prisma.business.findUnique({ where: { id: request.businessId } });
          if (b?.name) requesterLabel = b.name;
          if (b?.name) receiptName = receiptV2Name({ businessName: b.name });
        }
      } catch {
        // Cosmetic only.
      }
      const paidRands = centsToRandString(grossCents);
      const refLine = pfRef ? `Ref: PF ${pfRef} · ${code.toUpperCase()}` : `Ref: ${code.toUpperCase()}`;
      const payerOpen = await serviceWindowOpen(prisma, { waId: payerWaId });
      const sent = !payerOpen ? { ok: false, error: 'WINDOW_CLOSED' } : await send.text({
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
        // C: the v2 receipt (docs/templates/wapay_payment_receipt_v2.md) only when its approved name is
        // set in WAPAY_TEMPLATE_PAYMENT_RECEIPT_V2 and C covers this payer; its "My receipt" button
        // answers with the receipt and opens the account. If it fails, the current template follows.
        const v2Name = receiptV2TemplateFor(payerWaId);
        if (!delivered && v2Name) {
          const tpl = await send.template(receiptV2TemplateMessage({ to: payerWaId, templateName: v2Name, amount: `R${paidRands}`, requesterFirstName: receiptName, reference: String(pfRef || code.toUpperCase()), code: code.toUpperCase() }));
          if (tpl?.ok) delivered = true;
          else log('request_notify_payer_v2_template_failed', { code, error: tpl?.error });
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
