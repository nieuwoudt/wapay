/**
 * WaPay for Business — payment links (the POS side).
 *
 * GET  ?status=open|paid|closed|all&customerId=&limit=&offset=
 * POST {action:'quote', amountCents}                     → fee / net both ways
 * POST {action:'create', customerId?, items?, amountCents?, reference?, note?, ttlDays?}
 *      → { link, quote, message, waLink }  (waLink opens the OWNER's own
 *        WhatsApp with the message prefilled — the default send path)
 * POST {action:'sent', code, channel}                    → records how it went out
 * POST {action:'cancel', code}
 * POST {action:'nudge', code}   → WaPay-originated delivery; flag-gated
 *      (WAPAY_BUSINESS_NOTIFY) and allowed only for customers who have
 *      already PAID this business before. Informational-only text.
 *
 * Money never moves here: the link is an ordinary payment request that the
 * pay page + PayFast ITN / in-chat balance pay settle. Session-gated.
 */

import { sendWhatsAppText, sendWhatsAppTemplate, sendWhatsAppUtilityDirect, directSendEnabled } from '@wapay/whatsapp';
import prisma from '../../../lib/prisma.js';
import { requireBusinessContext } from '../../../lib/business-auth.js';
import {
  listBusinessLinks,
  createBusinessLink,
  markLinkSent,
  cancelBusinessLink,
  quoteLink,
  sendLinkViaWaPay,
  customerEligibleForNudge,
  nudgeEnabled,
} from '../../../lib/business.js';
import { MIN_REQUEST_CENTS, MAX_REQUEST_CENTS } from '../../../lib/payment-requests.js';

export const config = { maxDuration: 25 };

export default async function handler(req, res) {
  const ctx = await requireBusinessContext(req);
  if (!ctx.ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const business = ctx.business;

  if (req.method === 'GET') {
    try {
      const out = await listBusinessLinks({
        businessId: business.id,
        status: String(req.query.status || 'all'),
        customerId: req.query.customerId ? String(req.query.customerId) : null,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      return res.status(200).json(out);
    } catch (error) {
      console.error(JSON.stringify({ type: 'business_links_error', businessId: business.id, error: error?.message }));
      return res.status(500).json({ error: 'Could not load links.' });
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const body = req.body || {};
  try {
    if (body.action === 'quote') {
      const amountCents = Number(body.amountCents);
      if (!Number.isInteger(amountCents) || amountCents < MIN_REQUEST_CENTS || amountCents > MAX_REQUEST_CENTS) {
        return res.status(400).json({ ok: false, error: 'BAD_AMOUNT', minCents: MIN_REQUEST_CENTS, maxCents: MAX_REQUEST_CENTS });
      }
      return res.status(200).json({ ok: true, quote: quoteLink(amountCents) });
    }
    if (body.action === 'create') {
      const out = await createBusinessLink({
        business,
        customerId: body.customerId ? String(body.customerId) : null,
        items: body.items,
        amountCents: body.amountCents === undefined || body.amountCents === null || body.amountCents === '' ? undefined : Number(body.amountCents),
        reference: body.reference,
        note: body.note,
        ttlDays: body.ttlDays === undefined ? undefined : Number(body.ttlDays),
      });
      let nudge = { available: false };
      if (out.link.customerId && nudgeEnabled()) {
        nudge = { available: await customerEligibleForNudge({ businessId: business.id, customerId: out.link.customerId }) };
      }
      return res.status(200).json({ ok: true, ...out, nudge });
    }
    if (body.action === 'sent') {
      // Browser callers may record only the OWNER-side channels; 'WAPAY' is
      // claimed by the nudge itself and can never be forged from here.
      if (!['WHATSAPP_BUSINESS', 'COPY'].includes(body.channel)) return res.status(400).json({ ok: false, error: 'BAD_CHANNEL' });
      const ok = await markLinkSent({ businessId: business.id, code: body.code, channel: body.channel });
      return res.status(ok ? 200 : 404).json({ ok });
    }
    if (body.action === 'cancel') {
      const ok = await cancelBusinessLink({ business, code: body.code });
      return res.status(ok ? 200 : 409).json({ ok, error: ok ? undefined : 'NOT_OPEN' });
    }
    if (body.action === 'nudge') {
      const request = await prisma.paymentRequest.findUnique({ where: { id: String(body.code || '').toUpperCase() } });
      const customer = request?.customerId ? await prisma.businessCustomer.findUnique({ where: { id: request.customerId } }) : null;
      const out = await sendLinkViaWaPay({
        business,
        customer,
        code: body.code,
        send: { text: sendWhatsAppText, template: sendWhatsAppTemplate, direct: sendWhatsAppUtilityDirect, directEnabled: directSendEnabled },
      });
      return res.status(out.ok ? 200 : 409).json(out);
    }
    return res.status(400).json({ error: 'action' });
  } catch (error) {
    if (error?.code === 'REQUEST_LIMIT') return res.status(429).json({ ok: false, error: 'REQUEST_LIMIT', limit: error.limit });
    if (['BAD_AMOUNT', 'BAD_ITEM', 'TOO_MANY_ITEMS', 'AMOUNT_MISMATCH', 'BAD_CUSTOMER'].includes(error?.code)) {
      return res.status(400).json({ ok: false, error: error.code, message: error.message });
    }
    console.error(JSON.stringify({ type: 'business_links_write_error', businessId: business.id, action: body.action, error: error?.message }));
    return res.status(500).json({ ok: false, error: 'WRITE_FAILED' });
  }
}
