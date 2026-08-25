/**
 * POST /api/payfast/itn — PayFast Instant Transaction Notification webhook.
 *
 * PayFast POSTs form-urlencoded fields after a card payment. The fields this
 * route relies on:
 *   m_payment_id   - OUR deposit intent id (we set it at checkout)
 *   pf_payment_id  - PayFast's reference, stored as providerRef
 *   payment_status - must be COMPLETE (verifyItn enforces this)
 *   amount_gross   - rand string ('50.00'); verifyItn compares it against the
 *                    intent's amountCents. NEVER credited from — the credit
 *                    amount always comes from our own intent row.
 *
 * Order of operations is the security model:
 *   parse raw body -> look up intent -> verifyItn (signature over the raw
 *   fields INCLUDING empty ones — the UniFuel outage lesson — plus source IP,
 *   amount, status, server confirmation) -> only then touch money.
 *
 * Idempotency: the ledger entry is posted with the intent's idemKey, so a
 * redelivered ITN replays the original journal entry — the wallet is credited
 * exactly once no matter how many times PayFast retries.
 *
 * Response contract:
 *   - not verified: 400 (nothing was credited; the raw ITN is stored for forensics)
 *   - verified but the credit/mark failed: 500, so PayFast redelivers and the
 *     idemKey makes the retry safe
 *   - verified and credited: 200 'OK' — ALWAYS, even if the WhatsApp
 *     confirmation fails; messaging must never make PayFast retry a payment.
 */

import { verifyItn } from '@wapay/providers-payfast';
import { sendWhatsAppText, sendWhatsAppTemplate } from '@wapay/whatsapp';

import prisma from '../../../lib/prisma.js';
import { readRawBody } from '../../../lib/webhook-security.js';
import {
  getDepositIntent,
  markDeposit,
  recordItnDebug,
  centsToRandString,
} from '../../../lib/deposits.js';
import { markRequestPaid, maskedRequesterLabel } from '../../../lib/payment-requests.js';
import { noteDepositMethod } from '../../../lib/user-profile.js';
import { postEntry, ensureWallet } from '../../../lib/ledger-post.js';
import { buildLoad, RAIL, BALANCE } from '../../../lib/ledger-core.js';

// The ITN signature is computed over the exact form fields PayFast sent —
// Next's body parser must stay off so the raw bytes are available.
export const config = { api: { bodyParser: false } };

/** Parse a form-urlencoded body into a plain object, preserving field order. */
function parseFormBody(rawBody) {
  const params = {};
  for (const [key, value] of new URLSearchParams(rawBody)) {
    params[key] = value;
  }
  return params;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    console.error(JSON.stringify({ type: 'payfast_itn_body_read_error', error: error?.message }));
    return res.status(400).send('invalid body');
  }

  const params = parseFormBody(rawBody);
  const paymentId = params.m_payment_id;

  // First hop of x-forwarded-for is the client PayFast connected from.
  const sourceIp =
    String(req.headers['x-forwarded-for'] ?? '')
      .split(',')[0]
      .trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (!paymentId) {
    console.error(JSON.stringify({ type: 'payfast_itn_rejected', reason: 'MISSING_M_PAYMENT_ID', sourceIp }));
    return res.status(400).send('missing m_payment_id');
  }

  let intent;
  try {
    intent = await getDepositIntent({ paymentId });
  } catch (error) {
    console.error(JSON.stringify({ type: 'payfast_itn_lookup_error', paymentId, error: error?.message }));
    return res.status(500).send('lookup failed');
  }

  if (!intent) {
    console.error(JSON.stringify({ type: 'payfast_itn_rejected', reason: 'UNKNOWN_PAYMENT_ID', paymentId, sourceIp }));
    return res.status(404).send('unknown payment');
  }

  const { accountId, waId, amountCents } = intent.metadata ?? {};
  if (!accountId || !Number.isInteger(amountCents) || amountCents <= 0) {
    // Our own row is malformed — a bug on our side, not the caller's.
    console.error(JSON.stringify({ type: 'payfast_itn_intent_corrupt', paymentId }));
    return res.status(500).send('intent corrupt');
  }

  // Customer pays GROSS (credit + payment fee); wallet is credited
  // amountCents; the fee books as revenue. Intents created before the fee
  // shipped have no feeCents — they were quoted gross == amount.
  const feeCents = Number.isInteger(intent.metadata?.feeCents) ? intent.metadata.feeCents : 0;
  const grossCents = Number.isInteger(intent.metadata?.grossCents)
    ? intent.metadata.grossCents
    : amountCents + feeCents;

  // Verification BEFORE any money movement: signature (over raw fields,
  // empty values included), source IP, expected amount, payment status,
  // and PayFast server confirmation all live inside verifyItn.
  const verification = await verifyItn({
    params,
    expectedAmountCents: grossCents,
    sourceIp,
    sandbox: process.env.PAYFAST_SANDBOX === 'true',
    // The merchant passphrase is part of the ITN signature hash. Omitting it
    // fails every real payment with INVALID_SIGNATURE while sandbox tests
    // without a passphrase still pass — an easy silent breakage.
    passphrase: process.env.PAYFAST_PASSPHRASE || undefined,
    // PayFast's modern network (payment.payfast.io) sends ITNs from ranges
    // beyond the documented 2019-era CIDRs (observed live: 102.216.36.1,
    // 2026-08-21 — a real R20 was rejected). Signature + server POST-back are
    // the strong checks, so IP is warn-only unless explicitly enforced.
    enforceSourceIp: process.env.PAYFAST_ENFORCE_SOURCE_IP === 'true',
  });

  if (!verification.ok) {
    console.error(
      JSON.stringify({
        type: 'payfast_itn_rejected',
        reason: verification.reason,
        paymentId,
        sourceIp,
        payment_status: params.payment_status,
        amount_gross: params.amount_gross,
        pf_payment_id: params.pf_payment_id,
      })
    );
    try {
      // The UniFuel lesson: always store the raw ITN — it is the only way to
      // debug a signature mismatch after the fact.
      await recordItnDebug({ paymentId, rawItn: params, reason: verification.reason, sourceIp });
    } catch (error) {
      console.error(JSON.stringify({ type: 'payfast_itn_debug_store_error', paymentId, error: error?.message }));
    }
    return res.status(400).send('verification failed');
  }

  // Verified. Credit the wallet — idempotently — and mark the intent.
  let posted;
  try {
    await ensureWallet({ accountId });

    posted = await postEntry(
      buildLoad({
        accountId,
        rail: RAIL.PAYFAST,
        faceCents: amountCents,
        customerFeeCents: feeCents,
        idemKey: intent.idemKey,
      })
    );

    await markDeposit({ paymentId, status: 'SUCCESS', providerRef: params.pf_payment_id });
    // Memory: this customer loads by card — but only for their OWN deposits.
    // On a payment request the card belongs to a THIRD PARTY, not the
    // requester being credited (QA 2026-08-21).
    if (intent.route === 'deposit') {
      noteDepositMethod({ accountId, method: 'CARD' }).catch(() => {});
    }
  } catch (error) {
    // Nothing (or only part) landed — tell PayFast to redeliver; the idemKey
    // makes the retry post exactly the same entry.
    console.error(
      JSON.stringify({
        type: 'payfast_itn_credit_error',
        paymentId,
        idemKey: intent.idemKey,
        error: error?.message,
      })
    );
    return res.status(500).send('credit failed');
  }

  console.log(
    JSON.stringify({
      type: 'payfast_itn_credited',
      paymentId,
      idemKey: intent.idemKey,
      amountCents,
      pf_payment_id: params.pf_payment_id,
      replayed: posted.replayed,
      timestamp: new Date().toISOString(),
    })
  );

  // A payment-request intent also flips the request PENDING->PAID. Runs on
  // EVERY delivery, replayed or not — markRequestPaid is an atomic
  // PENDING->PAID check-and-set, so redeliveries are no-ops, and a crash
  // that earlier 500'd between credit and mark is repaired by the retry
  // (QA 2026-08-21: the old !replayed guard stranded credited requests
  // PENDING forever, leaving them re-payable).
  const requestCode = intent.metadata?.requestCode || null;
  let wonRequestTransition = false;
  if (requestCode) {
    try {
      wonRequestTransition = await markRequestPaid({
        code: requestCode,
        payerRef: `PAYFAST:${params.pf_payment_id}`,
      });
    } catch (error) {
      console.error(
        JSON.stringify({ type: 'payrequest_mark_paid_error', paymentId, requestCode, error: error?.message })
      );
    }

    // A replayed entry with a DIFFERENT PayFast reference means the payer's
    // card was charged a SECOND time for the same request (double-click, or
    // card after an in-chat payment). The credit stayed exactly-once — but
    // that second charge needs a manual refund. Scream.
    if (posted.replayed && intent.providerRef && intent.providerRef !== params.pf_payment_id) {
      console.error(
        JSON.stringify({
          type: 'payfast_overpayment_detected',
          severity: 'CRITICAL_REFUND_NEEDED',
          paymentId,
          requestCode,
          creditedRef: intent.providerRef,
          duplicateRef: params.pf_payment_id,
          amountGross: params.amount_gross,
        })
      );
    }
  }

  // Confirmation message — best effort only. A send failure must NOT fail
  // the ITN response. Deposits confirm on the first (non-replayed) credit;
  // payment requests confirm when THIS delivery won the PENDING->PAID
  // transition (so a repair-retry still notifies, and a losing rail never
  // double-notifies).
  const shouldConfirm = requestCode ? wonRequestTransition : !posted.replayed;
  if (waId && shouldConfirm) {
    try {
      const wallet = await prisma.wallet.findFirst({
        where: { accountId, balanceType: BALANCE.SPEND },
      });
      const lines = requestCode
        ? [`💸 Your payment request was PAID: R${centsToRandString(amountCents)} received!`]
        : [`✅ Deposit received: R${centsToRandString(amountCents)}`];
      if (wallet) {
        lines.push(`New balance: R${centsToRandString(wallet.availableCents)}`);
      }
      const confirmSent = await sendWhatsAppText({ to: waId, text: lines.join('\n') });
      if (!confirmSent?.ok) {
        // send functions resolve {ok:false} on failure — they never throw.
        console.error(
          JSON.stringify({ type: 'payfast_itn_confirm_send_error', paymentId, error: confirmSent?.error })
        );
        // A payment request can be paid days after creation — outside the
        // requester's 24h service window, where free-form is rejected. The
        // approved template (env-gated) is the only rail that still lands.
        const paidTemplate = process.env.WAPAY_TEMPLATE_REQUEST_PAID || '';
        if (requestCode && paidTemplate) {
          const tpl = await sendWhatsAppTemplate({
            to: waId,
            templateName: paidTemplate,
            language: 'en',
            components: [
              {
                type: 'body',
                parameters: [
                  { type: 'text', text: `R${centsToRandString(amountCents)}` },
                  { type: 'text', text: requestCode },
                ],
              },
            ],
          });
          if (!tpl?.ok) {
            console.error(
              JSON.stringify({ type: 'payfast_itn_confirm_template_error', paymentId, error: tpl?.error })
            );
          }
        }
      }
    } catch (error) {
      console.error(
        JSON.stringify({ type: 'payfast_itn_confirm_send_error', paymentId, error: error?.message })
      );
    }
  }

  // The PAYER's receipt (card leg of a payment request only — founder ask
  // 2026-08-22: every payer becomes a user). Best effort, never fails the
  // ITN. The destination comes from the SIGNED payload (custom_str1 rode
  // the checkout session that actually paid — a later checkout click can't
  // redirect it); metadata.payerMsisdn is only the fallback for intents
  // created before custom_str1 shipped. Free-form text lands whenever the
  // payer has messaged us (the wa.me receipt button); Meta REJECTS it for a
  // never-messaged number — sendWhatsAppText/Template NEVER throw, they
  // return {ok:false} (QA 2026-08-22: a catch here is dead code), so we
  // branch on the result and fall back to the approved template when
  // WAPAY_TEMPLATE_PAYMENT_RECEIPT names one.
  try {
    const custom = String(params.custom_str1 || '');
    const payerMsisdn = /^0\d{9}$/.test(custom)
      ? custom
      : /^0\d{9}$/.test(String(intent.metadata?.payerMsisdn || ''))
        ? intent.metadata.payerMsisdn
        : null;
    if (requestCode && wonRequestTransition && payerMsisdn) {
      // Persist the number that actually paid, so the in-chat receipt ask
      // reveals the PayFast reference to the true payer only.
      if (intent.metadata?.payerMsisdn !== payerMsisdn) {
        await prisma.providerRequest
          .update({ where: { idemKey: intent.idemKey }, data: { metadata: { ...intent.metadata, payerMsisdn } } })
          .catch(() => {});
      }

      const payerWaId = `27${payerMsisdn.slice(1)}`;
      let requesterLabel = 'the requester';
      try {
        const requester = await prisma.account.findUnique({ where: { id: accountId } });
        requesterLabel = maskedRequesterLabel(requester);
      } catch {
        // Label is cosmetic; the receipt still stands without it.
      }
      const paidRands = centsToRandString(grossCents);
      const refLine = params.pf_payment_id
        ? `Ref: PF ${params.pf_payment_id} · ${requestCode}`
        : `Ref: ${requestCode}`;

      // Purely transactional — no upsell in a receipt (POPIA: the form said
      // the number is for the receipt; the onboarding offer lives in the
      // user-initiated wa.me path instead).
      const sent = await sendWhatsAppText({
        to: payerWaId,
        text:
          `🧾 Payment confirmed: R${paidRands} to ${requesterLabel} ✅\n` +
          `${refLine}\n` +
          `This message is your receipt.`,
      });
      if (!sent?.ok) {
        console.error(
          JSON.stringify({ type: 'payfast_itn_payer_receipt_error', paymentId, error: sent?.error })
        );
        const templateName = process.env.WAPAY_TEMPLATE_PAYMENT_RECEIPT || '';
        if (templateName) {
          const tpl = await sendWhatsAppTemplate({
            to: payerWaId,
            templateName,
            language: 'en',
            components: [
              {
                type: 'body',
                parameters: [
                  { type: 'text', text: `R${paidRands}` },
                  { type: 'text', text: requesterLabel },
                  { type: 'text', text: String(params.pf_payment_id || requestCode) },
                ],
              },
            ],
          });
          if (!tpl?.ok) {
            console.error(
              JSON.stringify({
                type: 'payfast_itn_payer_receipt_template_error',
                paymentId,
                error: tpl?.error,
              })
            );
          }
        }
      }
    }
  } catch (error) {
    // Belt and braces: the payer receipt must never threaten the 200.
    console.error(
      JSON.stringify({ type: 'payfast_itn_payer_receipt_error', paymentId, error: error?.message })
    );
  }

  return res.status(200).send('OK');
}
