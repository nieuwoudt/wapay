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
 * EXACTLY ONCE WHEN TWO CALLS RACE (BUGLOG #145, 2026-11-07): Adumo finishes a
 * payment on two paths at once, the payer's browser return and the server
 * webhook, and both run this function. The flags were read at the start and
 * written after a slow send, so both calls passed the check, and the founder's
 * R5 test link PRAHSUHH sent the payer receipt twice. Now each leg is CLAIMED
 * before any send by a unique row in processed_messages
 * (`notify-claim:<leg>:<CODE>`), and the call that loses the claim sends
 * nothing. A failed send gives the claim back, so a later delivery or the
 * repair route still delivers. A delivered leg leaves a `notify-done:` row and
 * merges its flag in SQL, never from a stale copy of the metadata. A claim
 * older than any call can live (one that died mid-send) is taken over.
 * Paying your own link gets no payer receipt: the requester notice is the one
 * message.
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
import { businessInitiatedAllowed, numberForms } from './outbound-guard.js';

function log(type, data) {
  console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));
}

/** A claim older than this belongs to a call that died mid-send (Vercel's cap is 60 s); a later call may take it over. */
export const NOTIFY_CLAIM_STALE_MS = 5 * 60 * 1000;
export const notifyClaimKey = (leg, code) => `notify-claim:${leg}:${code}`;
export const notifyDoneKey = (leg, code) => `notify-done:${leg}:${code}`;

/**
 * Claim one notification leg ('requester' | 'payer') before any send (BUGLOG #145). Of any number of
 * concurrent calls exactly one wins: the unique processed_messages.waMessageId is the lock. Never throws.
 * @returns {Promise<{won: true, row: object} | {won: false, outcome: 'already'|'in_flight'|'failed'}>}
 */
export async function claimNotifyLeg({ prisma, leg, code, now = Date.now() }) {
  const key = notifyClaimKey(leg, code);
  const create = async () => {
    try {
      return await prisma.processedMessage.create({ data: { waMessageId: key, accountId: null } });
    } catch (error) {
      if (error?.code === 'P2002') return null;
      throw error;
    }
  };
  const done = async () => Boolean(await prisma.processedMessage.findUnique({ where: { waMessageId: notifyDoneKey(leg, code) } }));
  try {
    if (await done()) return { won: false, outcome: 'already' };
    let row = await create();
    if (row) return { won: true, row };
    if (await done()) return { won: false, outcome: 'already' };
    // Another call holds the leg. Take it over only when the claim is older than any call can live;
    // otherwise that call is still sending. If it failed and gave the claim back a moment ago, try once more.
    const { count } = await prisma.processedMessage.deleteMany({ where: { waMessageId: key, processedAt: { lt: new Date(now - NOTIFY_CLAIM_STALE_MS) } } });
    if (count === 0 && await prisma.processedMessage.findUnique({ where: { waMessageId: key } })) return { won: false, outcome: 'in_flight' };
    row = await create();
    return row ? { won: true, row } : { won: false, outcome: 'in_flight' };
  } catch (error) {
    // Unknown is not claimed. A notice skipped now is delivered by the next delivery or the repair
    // route; a second message for one payment counts against the number's quality (BUGLOG #144).
    log('request_notify_claim_error', { code, leg, error: error?.message });
    return { won: false, outcome: 'failed' };
  }
}

/** After the sends: a delivered leg is marked done for good; a failed one gives its claim back. Never throws. */
async function finishNotifyLeg({ prisma, claim, delivered, leg, code, idemKey, flag }) {
  if (delivered) {
    try {
      await prisma.processedMessage.create({ data: { waMessageId: notifyDoneKey(leg, code), accountId: null } });
    } catch (error) {
      // The claim row stays in place, so no other call sends this leg either way.
      if (error?.code !== 'P2002') log('request_notify_done_error', { code, leg, error: error?.message });
    }
    await persistFlag(prisma, idemKey, { [flag]: new Date().toISOString() });
    return;
  }
  try {
    await prisma.processedMessage.deleteMany({ where: { id: claim.row.id, waMessageId: notifyClaimKey(leg, code) } });
  } catch (error) {
    // The claim stays until it is stale; the first delivery after that takes it over.
    log('request_notify_release_error', { code, leg, error: error?.message });
  }
}

/** Is the payer's number the requester's own (someone paying their own link)? Both stored forms count. */
async function payerIsRequester({ prisma, meta, request, payerWaId }) {
  const mine = new Set(numberForms(meta.waId));
  if (!mine.size) {
    try {
      const account = await prisma.account.findUnique({ where: { id: meta.accountId || request.accountId }, select: { waId: true, msisdn: true } });
      for (const n of [account?.waId, account?.msisdn]) for (const f of numberForms(n)) mine.add(f);
    } catch {
      // Unknown: treated as someone else. The guard below still decides who may get a receipt.
    }
  }
  return mine.has(payerWaId);
}

/**
 * Deliver (or repair) both notifications for a PAID payment request.
 *
 * @param {object} args
 * @param {string} args.code - request code (PRXXXXXX)
 * @param {object} [args.prisma] - injectable for tests
 * @param {object} [args.send] - injectable send fns for tests
 * @returns {Promise<{requester: string, payer: string}>} outcome per leg:
 *   'sent' | 'already' | 'in_flight' (another call holds the leg) | 'failed' | 'skipped'
 *   | 'never_wrote' (payer) | 'own_number' (payer paid their own link)
 */
/**
 * Is this person's 24-hour service window open? (2026-10-23) Meta's API ACCEPTS a plain text sent
 * outside the window and rejects it seconds later on the status webhook (131047), so "sent ok" never
 * meant delivered: the receipt text to a payer who had never written was accepted, then dropped, and
 * the approved template that would have reached them was never tried. The window is decided here,
 * before choosing the rail: the person's last message to WaPay, or the moment their account opened
 * from their first message (a pre-registered payer's account does not count). Unknown → true, so a
 * read failure keeps the old behaviour rather than silencing a notice.
 * Also gates the member-to-member payment request note in the processor (2026-10-24).
 */
export async function serviceWindowOpen(prisma, { accountId = null, waId = null, now = Date.now() } = {}) {
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
  guard = businessInitiatedAllowed,
}) {
  const out = { requester: 'skipped', payer: 'skipped' };
  const CODE = String(code || '').toUpperCase();
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
      const claim = await claimNotifyLeg({ prisma, leg: 'requester', code: CODE });
      if (!claim.won) {
        out.requester = claim.outcome;
      } else {
        let delivered = false;
        try {
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
            // Outside a reply: only to a number that wrote to WaPay (BUGLOG #144).
            const requesterOk = (await guard({ prisma, to: meta.waId, purpose: 'requester-notice' })).ok;
            // Paid on day 6 = outside the requester's 24h window. Direct Send
            // (Meta beta, 2026-09) delivers the same text as a UTILITY message
            // with no template — try it before falling back to the template.
            if (requesterOk && directSendEnabled()) {
              const direct = await send.direct({ to: meta.waId, text: lines.join('\n') });
              if (direct?.ok) delivered = true;
              else log('request_notify_requester_direct_failed', { code, error: direct?.error });
            }
            // The approved template is the rail of last resort.
            const tplName = process.env.WAPAY_TEMPLATE_REQUEST_PAID || '';
            if (requesterOk && !delivered && tplName) {
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
        } finally {
          await finishNotifyLeg({ prisma, claim, delivered, leg: 'requester', code: CODE, idemKey: intent.idemKey, flag: 'requesterNotifiedAt' });
        }
        out.requester = delivered ? 'sent' : 'failed';
      }
    }

    // --- Payer leg (card payments with a captured number only) -------------
    const payerMsisdn = /^0\d{9}$/.test(String(meta.payerMsisdn || '')) ? meta.payerMsisdn : null;
    if (meta.payerNotifiedAt) {
      out.payer = 'already';
    } else if (payerMsisdn) {
      const payerWaId = `27${payerMsisdn.slice(1)}`;
      // BUGLOG #145 (2026-11-07): paying your own link is one payment and one message. The requester
      // notice above is that message; a receipt to the same number would be a second one for one event.
      if (await payerIsRequester({ prisma, meta, request, payerWaId })) {
        out.payer = 'own_number';
        log('request_notify_payer_own_number', { code });
        return out;
      }
      // C (WAPAY_PAYER_PREREGISTER, 2026-10-22): a payer whose number has no account gets an S0
      // record now (lib/payer-preregister.js), so their history exists when they ever write.
      // POPIA: the number was given for this receipt; it is used for nothing else until they
      // write to WaPay. No message beyond the receipt below. Never blocks or fails the receipt.
      if (payerPreregisterFor(payerWaId)) {
        await Promise.resolve(preRegisterPayer({ prisma, payerMsisdn, requestCode: code.toUpperCase(), paidAt: request.paidAt || null, referrerAccountId: meta.accountId || null }))
          .catch((error) => log('request_notify_preregister_error', { code, error: error?.message }));
      }
      // BUGLOG #144 (2026-10-27, Meta's second "Sending spam" notice): the number typed on the pay
      // page is not consent. Fraudsters typed made-up and other people's numbers, and a receipt from
      // WaPay to someone who never wrote to it is a message from a stranger. Nothing goes to a number
      // that never wrote to WaPay, on any rail (a pre-registered record does not count). The payer
      // gets the receipt by tapping "Get my receipt" on the pay page, which opens their own chat
      // with WaPay ("Receipt PRXXXXXX"); WaPay answers that message.
      const optIn = await guard({ prisma, to: payerWaId, purpose: 'payer-receipt' });
      if (!optIn.ok) {
        out.payer = 'never_wrote';
        return out;
      }
      const claim = await claimNotifyLeg({ prisma, leg: 'payer', code: CODE });
      if (!claim.won) {
        out.payer = claim.outcome;
        return out;
      }
      let delivered = false;
      try {
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
      } finally {
        await finishNotifyLeg({ prisma, claim, delivered, leg: 'payer', code: CODE, idemKey: intent.idemKey, flag: 'payerNotifiedAt' });
      }
      out.payer = delivered ? 'sent' : 'failed';
    }
  } catch (error) {
    log('request_notify_error', { code, error: error?.message });
  }
  return out;
}

/**
 * Merge a flag into the intent's metadata IN SQL (BUGLOG #145): `metadata || patch` on the row as it is
 * now. Spreading the copy this call read at its start (BUGLOG #24's merge) could be seconds old and drop
 * the flag a concurrent call had just written.
 */
async function persistFlag(prisma, idemKey, patch) {
  try {
    await prisma.$executeRaw`UPDATE "ProviderRequest" SET "metadata" = COALESCE("metadata", '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb WHERE "idemKey" = ${idemKey}`;
  } catch (error) {
    // The notify-done row already stops a second send; the flag is the fast path and the record.
    log('request_notify_flag_error', { idemKey, error: error?.message });
  }
}
