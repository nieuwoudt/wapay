/**
 * Adumo Online webhook (async methods such as Instant EFT settle here; Adumo
 * retries up to three times until it sees 200). The payload carries a JWT
 * signed with our secret; nothing else is trusted. Settlement is the shared,
 * idempotent card settlement, so a webhook after a return (or vice versa)
 * credits exactly once. Enable webhooks with support@adumoonline.com.
 */
import prisma from '../../../lib/prisma.js';
import { verifyAdumoResponse, codeFromMerchantReference } from '../../../lib/adumo.js';
import { settleCardPayment } from '../../../lib/card-settlement.js';

export const config = { maxDuration: 25 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // Claims first (signed), fields second (unsigned) — only to FIND the intent.
  const token = body._RESPONSE_TOKEN || body.token || body.Token || null;
  let mref = String(body._MERCHANTREFERENCE || body.merchantReference || body.mref || '');
  if (!mref && token) {
    try { mref = String(JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString('utf8')).mref || ''); } catch { /* verified below */ }
  }
  const code = codeFromMerchantReference(mref);
  if (!code) return res.status(400).json({ ok: false, error: 'BAD_REFERENCE' });
  const intent = await prisma.providerRequest.findUnique({ where: { idemKey: `wapay-payreq-${code}` } });
  if (!intent) return res.status(404).json({ ok: false, error: 'UNKNOWN' });
  const grossCents = Number.isInteger(intent.metadata?.grossCents) ? intent.metadata.grossCents : Number(intent.metadata?.amountCents || 0) + Number(intent.metadata?.feeCents || 0);
  const v = verifyAdumoResponse({ fields: { ...body, _RESPONSE_TOKEN: token }, expected: { mref, amountCents: grossCents } });
  if (!v.ok) {
    console.error(JSON.stringify({ type: 'adumo_webhook_rejected', reason: v.error, detail: v.detail, requestCode: code }));
    return res.status(401).json({ ok: false, error: v.error });
  }
  if (!v.approved) {
    console.log(JSON.stringify({ type: 'adumo_webhook_not_approved', requestCode: code, status: v.status }));
    return res.status(200).json({ ok: true, ignored: true });
  }
  const out = await settleCardPayment({ intent, rail: 'ADUMO', providerRef: v.transactionIndex || mref, payerMsisdn: intent.metadata?.payerMsisdn || null });
  console.log(JSON.stringify({ type: 'adumo_webhook_settled', requestCode: code, ok: out.ok, replayed: out.replayed }));
  return res.status(out.ok ? 200 : 500).json({ ok: out.ok });
}
