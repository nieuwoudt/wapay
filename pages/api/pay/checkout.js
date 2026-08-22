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

import { buildCheckoutUrl } from '@wapay/providers-payfast';

import prisma from '../../../lib/prisma.js';
import { getPaymentRequest } from '../../../lib/payment-requests.js';
import { depositFeeCents } from '../../../lib/deposits.js';
import { normaliseMsisdn, isValidSaMsisdn } from '../../../lib/msisdn.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).send('method not allowed');
  }

  const code = String(req.query.code || '').toUpperCase();
  if (!/^[A-Z]{6,12}$/.test(code)) return res.status(400).send('bad code');

  // The payer's WhatsApp number from the pay-page form (founder ask
  // 2026-08-22: every card payer becomes a user). Capture is best-effort
  // BY DESIGN: an invalid or missing number must never block the payment —
  // the requester getting paid always outranks the growth hook.
  const payerMsisdn = (() => {
    const raw = String(req.query.payer || '');
    if (!raw) return null;
    return isValidSaMsisdn(raw) ? normaliseMsisdn(raw) : null;
  })();

  const request = await getPaymentRequest({ code });
  if (!request) return res.status(404).send('unknown request');
  if (request.status !== 'PENDING') {
    // Send them back to the page, which explains the terminal state.
    return res.redirect(302, `/pay/${code}`);
  }

  const requester = await prisma.account.findUnique({ where: { id: request.accountId } });
  if (!requester) return res.status(410).send('requester unavailable');

  // FEE DIRECTION (founder decision 2026-08-22): the PAYER pays exactly
  // the request amount — the card fee is deducted from what the REQUESTER
  // receives. Whoever sends the link carries the cost.
  const amountCents = request.amountCents;
  const feeCents = depositFeeCents(amountCents);
  const creditCents = amountCents - feeCents;

  // ONE intent per request code, and ONE idemKey shared with the balance
  // leg (`wapay-payreq-<code>`): however many times checkout is clicked and
  // whichever rail settles first, postEntry can only ever credit ONCE — the
  // loser replays the winner's entry (QA 2026-08-21: fresh-intent-per-click
  // enabled double card charges + double credits).
  const idemKey = `wapay-payreq-${code}`;
  let intent = await prisma.providerRequest.findUnique({ where: { idemKey } });
  if (intent?.status === 'SUCCESS') {
    return res.redirect(302, `/pay/${code}`);
  }
  if (!intent) {
    try {
      intent = await prisma.providerRequest.create({
        data: {
          id: `pfreq-${code}`,
          provider: 'PAYFAST',
          route: 'payrequest',
          idemKey,
          status: 'PENDING',
          accountId: request.accountId,
          metadata: {
            accountId: request.accountId,
            waId: requester.waId,
            // amountCents = what the PAYER pays; creditCents = what the
            // REQUESTER receives (amount - card fee).
            amountCents: creditCents,
            feeCents,
            grossCents: amountCents,
            requestCode: code,
            // Where the payer's receipt goes (0-form; null when not given).
            payerMsisdn,
          },
        },
      });
    } catch (err) {
      if (err?.code !== 'P2002') throw err;
      intent = await prisma.providerRequest.findUnique({ where: { idemKey } });
      if (!intent) throw err;
    }
  } else if (payerMsisdn && intent.metadata?.payerMsisdn !== payerMsisdn) {
    // The intent is reused across checkout clicks — remember whoever clicked
    // LAST (only one person can ever complete the single-use payment, and
    // the ITN reads the metadata after they have). Best effort: a stale
    // number on the receipt is not worth blocking checkout for.
    try {
      intent = await prisma.providerRequest.update({
        where: { idemKey },
        data: { metadata: { ...intent.metadata, payerMsisdn } },
      });
    } catch (err) {
      console.error(
        JSON.stringify({ type: 'payrequest_payer_update_error', requestCode: code, error: err?.message })
      );
    }
  }
  const id = intent.id;

  console.log(
    JSON.stringify({
      type: 'payrequest_checkout_created',
      requestCode: code,
      paymentId: id,
      amountCents,
      feeCents,
      payerCaptured: Boolean(payerMsisdn),
      timestamp: new Date().toISOString(),
    })
  );

  const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  const checkoutUrl = buildCheckoutUrl({
    merchantId: process.env.PAYFAST_MERCHANT_ID,
    merchantKey: process.env.PAYFAST_MERCHANT_KEY,
    passphrase: process.env.PAYFAST_PASSPHRASE || undefined,
    sandbox: process.env.PAYFAST_SANDBOX === 'true',
    amountCents,
    mPaymentId: id,
    itemName: 'WaPay payment request',
    // ?r=1 = "back from PayFast": the page shows a confirming state with no
    // pay buttons while the ITN is in flight (double-charge guard). The
    // cancel URL stays bare so a cancelled payer gets the buttons back.
    returnUrl: `${base}/pay/${code}?r=1`,
    cancelUrl: `${base}/pay/${code}`,
    notifyUrl: `${base}/api/payfast/itn`,
  });

  return res.redirect(302, checkoutUrl);
}
