/**
 * POST /api/webhooks/unifuel — redemption events on WaPay-originated
 * wiCode vouchers, forwarded by UniFuel's Yoyo-callback handler
 * (design: docs/UNIFUEL_INTEGRATION.md).
 *
 * Body: { reference, event: 'redemption'|'partial_redemption',
 *         amountUsedCents, balanceCents, newWicode?, expiryDate? }
 *
 * A PARTIAL redemption kills the old wiCode; Yoyo regenerates one and it
 * arrives here as newWicode. Delivery of the fresh code reuses the atomic
 * pending-gift claim machinery: the gift row gets the new code and flips
 * back to ISSUED, then an immediate claim+send is attempted — if the send
 * fails (e.g. the 24h WhatsApp window is closed), the row simply stays
 * claimable and the customer's next inbound message delivers it (BUGLOG
 * #22 discipline). NOTE for production: an approved template for this
 * proactive notify is on the founder-action list (free-form outside the
 * window is accepted-then-dropped — BUGLOG #33).
 *
 * Auth: Bearer UNIFUEL_PARTNER_SECRET, constant-time, fail-closed (503
 * when unset). Redemption events only occur in production redemption;
 * until then this route is exercised synthetically.
 */

import { createHash, timingSafeEqual } from 'crypto';
import prisma from '../../../lib/prisma.js';
import { revertGiftDelivery } from '../../../lib/pending-gifts.js';
import { buildWicodeClaimMessage } from '../../../lib/gifting.js';
import { redemptionGuide } from '../../../lib/spend-catalogue.js';
import { sendWhatsAppText } from '@wapay/whatsapp';
import { localizeOutbound } from '../../../lib/localize.js';
import { sendOpsAlert } from '../../../lib/email.js';

function logStructured(type, data) {
  console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));
}

function verifyPartnerBearer(req) {
  // A dedicated webhook secret can rotate independently of the outbound
  // partner secret; the shared one remains the default.
  const secret = process.env.UNIFUEL_WEBHOOK_SECRET || process.env.UNIFUEL_PARTNER_SECRET;
  if (!secret) return { ok: false, status: 503, error: 'NOT_CONFIGURED' };
  const auth = String(req.headers.authorization || '');
  const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(secret).digest();
  if (presented && timingSafeEqual(a, b)) return { ok: true };
  return { ok: false, status: 401, error: 'UNAUTHORIZED' };
}

const rands = (cents) => `R${(Number(cents || 0) / 100).toFixed(2)}`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const auth = verifyPartnerBearer(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { reference, event, amountUsedCents, balanceCents, newWicode } = req.body || {};
  if (!reference || !/^wapay-fuel-/.test(String(reference))) {
    return res.status(400).json({ error: 'BAD_REFERENCE' });
  }
  if (!['redemption', 'partial_redemption'].includes(event)) {
    return res.status(400).json({ error: 'BAD_EVENT' });
  }

  // The compact reference maps back to its purchase via the preview row
  // (execute stamps providerRef = reference on SUCCESS/RECONCILE).
  const previewRow = await prisma.providerRequest.findFirst({
    where: { providerRef: String(reference), route: 'fuel-preview' },
  });
  const previewId = previewRow?.id || null;
  const gift = previewId
    ? await prisma.pendingGift.findUnique({
        where: { idemKey: `wapay-fuel-gift-${previewId}` },
      })
    : null;
  if (!gift) {
    logStructured('unifuel_webhook_no_gift', { reference, event });
    return res.status(404).json({ error: 'NOT_FOUND' });
  }

  const account = await prisma.account.findFirst({ where: { msisdn: gift.recipientMsisdn } });
  const to = gift.recipientMsisdn;
  const lang = account?.profile?.language || 'en';

  logStructured('unifuel_webhook_redemption', {
    reference,
    event,
    amountUsedCents,
    balanceCents,
    hasNewCode: !!newWicode,
  });

  // Replay / out-of-order guard: a redemption can only shrink the balance.
  // An event claiming a balance at or above what we already hold is stale
  // or replayed — acknowledge it without touching the stored bearer code.
  if (
    event === 'partial_redemption' &&
    Number.isInteger(balanceCents) &&
    balanceCents >= gift.amountCents
  ) {
    logStructured('unifuel_webhook_stale_ignored', { reference, balanceCents, held: gift.amountCents });
    return res.status(200).json({ ok: true, stale: true });
  }

  if (event === 'redemption' || !newWicode) {
    // Fully used, or a partial whose fresh code is still being minted.
    // Informational only, localized, no bearer content — a dropped
    // free-form send loses nothing critical.
    const doneMsg = await localizeOutbound(
      event === 'redemption'
        ? `⛽ Your fuel voucher was used for ${rands(amountUsedCents)}. Fully redeemed, enjoy the road! 🎉`
        : `⛽ Your fuel voucher was used for ${rands(amountUsedCents)}. A fresh code for your remaining ${rands(balanceCents)} is being prepared and will arrive here shortly.`,
      lang
    );
    await sendWhatsAppText({ to, text: doneMsg });
    if (event === 'partial_redemption') {
      // The old code is dead and the regenerated one has not arrived —
      // ops must chase it (UniFuel audits wicode_regen_failed on its side).
      sendOpsAlert({
        subject: 'Partial redemption without a regenerated wiCode',
        detailsHtml: `Reference <b>${reference}</b>: partial redemption forwarded with no fresh code. The customer's remaining ${rands(balanceCents)} needs a regenerated wiCode (check UniFuel audit_logs for voucher.wicode_regen_failed).`,
      }).catch(() => {});
    }
    return res.status(200).json({ ok: true });
  }

  // PARTIAL with a regenerated code: swap the bearer secret into the gift
  // row and flip it claimable, then attempt immediate delivery through the
  // atomic claim flow (failure leaves it claimable for the next inbound).
  await prisma.pendingGift.update({
    where: { id: gift.id },
    data: {
      voucherPin: String(newWicode),
      amountCents: Number.isInteger(balanceCents) && balanceCents > 0 ? balanceCents : gift.amountCents,
      status: 'ISSUED',
      deliveredAt: null,
    },
  });

  const headsUp = await localizeOutbound(
    `⛽ You used ${rands(amountUsedCents)} of your fuel voucher. The old code is now used up, and a fresh code for your remaining ${rands(balanceCents)} is coming right up. 👇`,
    lang
  );
  await sendWhatsAppText({ to, text: headsUp });

  try {
    // Claim ONLY this voucher's row (atomic ISSUED→DELIVERED), never the
    // account's whole queue — sweeping unrelated gifts through this webhook
    // risks stranding a foreign bearer PIN (review 2026-08-29).
    const won = await prisma.pendingGift.updateMany({
      where: { id: gift.id, status: 'ISSUED' },
      data: { status: 'DELIVERED', deliveredAt: new Date() },
    });
    if (won.count === 1) {
      const fresh = await prisma.pendingGift.findUnique({ where: { id: gift.id } });
      const text = buildWicodeClaimMessage({
        amountCents: fresh.amountCents,
        wicode: fresh.voucherPin,
        guide: redemptionGuide('FUEL_WICODE'),
      });
      const sent = await sendWhatsAppText({ to, text });
      if (sent?.ok === false) {
        await revertGiftDelivery({ giftId: gift.id }).catch(() => {});
        logStructured('unifuel_webhook_recode_send_failed_reverted', { giftId: gift.id });
      }
    }
  } catch (claimError) {
    logStructured('unifuel_webhook_recode_claim_deferred', { reference, error: claimError?.message });
  }

  return res.status(200).json({ ok: true });
}
