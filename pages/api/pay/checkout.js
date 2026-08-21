/**
 * GET /api/pay/checkout?code=PRXXXXXX — card leg of a payment request.
 *
 * Creates the PayFast intent for the request and 302-redirects the payer to
 * checkout. The payer pays GROSS (request amount + banded payment fee); the
 * ITN webhook credits the REQUESTER face value with the intent's idemKey
 * (redeliveries credit once) and marks the request PAID.
 *
 * Public by design — the code IS the capability (unguessable, letters-only,
 * 7-day expiry, single-use PENDING->PAID). No auth, no PII in the redirect.
 */

import crypto from 'crypto';

import { buildCheckoutUrl } from '@wapay/providers-payfast';

import prisma from '../../../lib/prisma.js';
import { getPaymentRequest } from '../../../lib/payment-requests.js';
import { depositFeeCents } from '../../../lib/deposits.js';

// Same guard as lib/deposits.js newIntentId: ledger-core rejects idemKeys
// with epoch-lookalike digit runs, so ids are redrawn until clean.
const TIMESTAMP_LOOKALIKE = /(?<!\d)1\d{12}(?!\d)|(?<!\d)1[6-9]\d{8}(?!\d)/;
function newIntentId() {
  for (;;) {
    const id = crypto.randomUUID();
    if (!TIMESTAMP_LOOKALIKE.test(id)) return id;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).send('method not allowed');
  }

  const code = String(req.query.code || '').toUpperCase();
  if (!/^[A-Z]{6,12}$/.test(code)) return res.status(400).send('bad code');

  const request = await getPaymentRequest({ code });
  if (!request) return res.status(404).send('unknown request');
  if (request.status !== 'PENDING') {
    // Send them back to the page, which explains the terminal state.
    return res.redirect(302, `/pay/${code}`);
  }

  const requester = await prisma.account.findUnique({ where: { id: request.accountId } });
  if (!requester) return res.status(410).send('requester unavailable');

  const amountCents = request.amountCents;
  const feeCents = depositFeeCents(amountCents);
  const grossCents = amountCents + feeCents;

  const id = newIntentId();
  const idemKey = `wapay-pfreq-${id}`;
  await prisma.providerRequest.create({
    data: {
      id,
      provider: 'PAYFAST',
      route: 'payrequest',
      idemKey,
      status: 'PENDING',
      accountId: request.accountId,
      metadata: {
        accountId: request.accountId,
        waId: requester.waId,
        amountCents,
        feeCents,
        grossCents,
        requestCode: code,
      },
    },
  });

  console.log(
    JSON.stringify({
      type: 'payrequest_checkout_created',
      requestCode: code,
      paymentId: id,
      amountCents,
      feeCents,
      timestamp: new Date().toISOString(),
    })
  );

  const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  const checkoutUrl = buildCheckoutUrl({
    merchantId: process.env.PAYFAST_MERCHANT_ID,
    merchantKey: process.env.PAYFAST_MERCHANT_KEY,
    passphrase: process.env.PAYFAST_PASSPHRASE || undefined,
    sandbox: process.env.PAYFAST_SANDBOX === 'true',
    amountCents: grossCents,
    mPaymentId: id,
    itemName: 'WaPay payment request',
    returnUrl: `${base}/pay/${code}`,
    cancelUrl: `${base}/pay/${code}`,
    notifyUrl: `${base}/api/payfast/itn`,
  });

  return res.redirect(302, checkoutUrl);
}
