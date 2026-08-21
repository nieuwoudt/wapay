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
import { sendWhatsAppText } from '@wapay/whatsapp';

import prisma from '../../../lib/prisma.js';
import { readRawBody } from '../../../lib/webhook-security.js';
import {
  getDepositIntent,
  markDeposit,
  recordItnDebug,
  centsToRandString,
} from '../../../lib/deposits.js';
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
    // Memory: this customer loads by card (best-effort, never blocks the ITN).
    noteDepositMethod({ accountId, method: 'CARD' }).catch(() => {});
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

  // Confirmation message — best effort only. A send failure must NOT fail the
  // ITN response, and a redelivered ITN (replayed entry) must not message the
  // customer twice.
  if (waId && !posted.replayed) {
    try {
      const wallet = await prisma.wallet.findFirst({
        where: { accountId, balanceType: BALANCE.SPEND },
      });
      const lines = [`✅ Deposit received: R${centsToRandString(amountCents)}`];
      if (wallet) {
        lines.push(`New balance: R${centsToRandString(wallet.availableCents)}`);
      }
      await sendWhatsAppText({ to: waId, text: lines.join('\n') });
    } catch (error) {
      console.error(
        JSON.stringify({ type: 'payfast_itn_confirm_send_error', paymentId, error: error?.message })
      );
    }
  }

  return res.status(200).send('OK');
}
