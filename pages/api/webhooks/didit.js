/**
 * Didit KYC webhook — status.updated drives our KYC state.
 *
 * Order is LAW here, same as the WhatsApp webhook: signature over the exact
 * raw bytes FIRST (401 on failure, before any parsing side effects), then
 * process AWAITED, then ACK (Vercel kills post-response work — BUGLOG #7).
 * Didit's 5s delivery timeout may lapse while we work; that is safe by
 * design: Didit retries, and everything here is idempotent — the status
 * merge re-applies harmlessly and the customer notification is gated on
 * profile.kyc.notifiedStatus.
 *
 * We never trust the webhook's embedded decision payload: on status.updated
 * we fetch the decision endpoint as the source of truth (spec §3).
 */

import prisma from '../../../lib/prisma.js';
import { sendWhatsAppText } from '@wapay/whatsapp';
import { localizeOutbound } from '../../../lib/localize.js';
import {
  diditConfigured,
  verifyDiditSignature,
  syncKycFromDecision,
  markKycNotified,
} from '../../../lib/didit-kyc.js';

// Signature is over the exact raw bytes — the parser must stay off.
export const config = { api: { bodyParser: false }, maxDuration: 25 };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const NOTIFY = {
  VERIFIED: '✅ Your WaPay identity verification is complete. Thank you!',
  DECLINED: '❌ Your WaPay identity verification could not be completed. Reply "help" and we will sort it out together.',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!diditConfigured()) return res.status(503).json({ error: 'not configured' });

  const rawBody = await readRawBody(req);
  const ok = verifyDiditSignature({
    rawBody,
    signature: req.headers['x-signature'],
    timestamp: req.headers['x-timestamp'],
  });
  if (!ok) {
    console.error(JSON.stringify({ type: 'didit_webhook_bad_signature' }));
    return res.status(401).json({ error: 'signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(200).json({ ok: true, ignored: 'unparseable' });
  }

  // Only session status changes move our state; every other event type is
  // acknowledged and ignored (returning non-2xx would just earn retries).
  if (event?.webhook_type !== 'status.updated' || !event?.session_id || !event?.vendor_data) {
    return res.status(200).json({ ok: true, ignored: event?.webhook_type || 'shape' });
  }

  try {
    const accountId = String(event.vendor_data);
    const synced = await syncKycFromDecision({ accountId, sessionId: String(event.session_id) });
    if (!synced.ok) {
      // 5xx → Didit retries; our processing is idempotent so retries are safe.
      return res.status(502).json({ error: synced.error });
    }

    // Notify on VERIFIED/DECLINED, gated ONLY on notifiedStatus (not on
    // `changed`): a redelivery after a failed send must still notify. If the
    // send fails we return 5xx so Didit retries; the notifiedStatus gate then
    // prevents a double-send once one succeeds (review 2026-08-28).
    const status = synced.kyc?.status;
    if (NOTIFY[status] && synced.kyc?.notifiedStatus !== status) {
      const account = await prisma.account.findUnique({ where: { id: accountId } });
      if (account?.waId) {
        const msg = await localizeOutbound(NOTIFY[status], account.profile?.language);
        const sent = await sendWhatsAppText({ to: account.waId, text: msg });
        if (sent?.ok) {
          await markKycNotified({ accountId, status });
        } else {
          console.error(JSON.stringify({ type: 'didit_notify_send_failed', accountId, status }));
          return res.status(502).json({ error: 'notify_failed_retry' });
        }
      }
    }
    logEvent(event, status);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(JSON.stringify({ type: 'didit_webhook_error', error: error?.message }));
    return res.status(500).json({ error: 'internal' });
  }
}

function logEvent(event, mappedStatus) {
  console.log(JSON.stringify({
    type: 'didit_status_applied',
    sessionId: event.session_id,
    diditStatus: event.status,
    mappedStatus,
    eventId: event.event_id,
    timestamp: new Date().toISOString(),
  }));
}
