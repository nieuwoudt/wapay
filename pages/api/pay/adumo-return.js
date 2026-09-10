/**
 * Adumo Online — the payer's browser comes back here after the hosted page
 * (RedirectSuccessfulURL and RedirectFailedURL both point at this route).
 * The decision comes from the SIGNED _RESPONSE_TOKEN only: signature, cuid,
 * auid, merchant reference and GROSS amount must all match the intent we
 * created; then the same settlement as the PayFast ITN, idempotent on the
 * intent's idemKey. Unsigned fields are stored for forensics, never trusted.
 */
import prisma from '../../../lib/prisma.js';
import { verifyAdumoResponse, codeFromMerchantReference } from '../../../lib/adumo.js';
import { settleCardPayment } from '../../../lib/card-settlement.js';
import { recordItnDebug } from '../../../lib/deposits.js';

export const config = { maxDuration: 25 };

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).send('method not allowed');
  const fields = req.method === 'POST' ? (req.body && typeof req.body === 'object' ? req.body : {}) : {};
  const mref = String(fields._MERCHANTREFERENCE || fields.mref || req.query.mref || '');
  const code = codeFromMerchantReference(mref) || String(req.query.code || '').toUpperCase();
  if (!/^[A-Z]{6,12}$/.test(code)) return res.status(400).send('bad reference');
  const sourceIp = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

  const intent = await prisma.providerRequest.findUnique({ where: { idemKey: `wapay-payreq-${code}` } });
  if (!intent) return res.redirect(302, `/pay/${code}`);
  const grossCents = Number.isInteger(intent.metadata?.grossCents) ? intent.metadata.grossCents : Number(intent.metadata?.amountCents || 0) + Number(intent.metadata?.feeCents || 0);
  const expectedMref = mref || intent.metadata?.adumoRef || null;

  const v = verifyAdumoResponse({ fields: { ...req.query, ...fields }, expected: { mref: expectedMref, amountCents: grossCents } });
  if (!v.ok) {
    console.error(JSON.stringify({ type: 'adumo_return_rejected', reason: v.error, detail: v.detail, requestCode: code, sourceIp }));
    await recordItnDebug({ paymentId: intent.id, rawItn: { ...fields, _RESPONSE_TOKEN: fields._RESPONSE_TOKEN ? '[present]' : undefined }, reason: `ADUMO_${v.error}`, sourceIp }).catch(() => {});
    // The payer sees the page again; nothing was credited. If Adumo did
    // approve, its webhook (verified independently) still settles it.
    return res.redirect(302, `/pay/${code}?e=unverified`);
  }
  if (!v.approved) {
    console.log(JSON.stringify({ type: 'adumo_return_not_approved', requestCode: code, status: v.status, errorCode: v.errorCode }));
    return res.redirect(302, `/pay/${code}?e=${encodeURIComponent(v.status || 'declined')}`);
  }
  const out = await settleCardPayment({ intent, rail: 'ADUMO', providerRef: v.transactionIndex || expectedMref || code, payerMsisdn: intent.metadata?.payerMsisdn || null });
  console.log(JSON.stringify({ type: 'adumo_return_settled', requestCode: code, ok: out.ok, replayed: out.replayed, transactionIndex: v.transactionIndex }));
  return res.redirect(302, `/pay/${code}?r=1`);
}
