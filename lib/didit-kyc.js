/**
 * Didit KYC integration — the v1 provider (founder decision 2026-08-28).
 *
 * Built against the verified v3 API (docs.didit.me, researched 2026-08-28):
 * - POST https://verification.didit.me/v3/session/  (x-api-key) → hosted
 *   verification `url` we hand to the customer over WhatsApp. `vendor_data`
 *   is our account id and doubles as Didit's idempotency key: re-creating
 *   for the same account returns the live unfinished session.
 * - GET  /v3/session/{id}/decision/ — the source of truth after a webhook.
 * - Webhook signature: HMAC-SHA256 hex over the EXACT RAW BODY BYTES with
 *   the destination's secret_shared_key, header X-Signature, plus
 *   X-Timestamp replay window (5 min). Compare with timingSafeEqual.
 *
 * KYC state lives in Account.profile.kyc (always MERGED, never clobbering
 * other profile keys):
 *   { status, provider:'didit', sessionId, url, startedAt, verifiedAt,
 *     fullName, documentType, idNumberMasked, declineReason, notifiedStatus }
 *
 * Status map (Didit session status → ours):
 *   Approved → VERIFIED · Declined → DECLINED · In Review → PENDING_REVIEW ·
 *   Expired / Kyc Expired / Abandoned → EXPIRED · anything in flight → PENDING.
 *   Unknown statuses are logged and DO NOT change our state.
 *
 * PRIVACY (POPIA): we deliberately store the MASKED document number only —
 * the full number stays with Didit. Never log extracted person data.
 * Envs: DIDIT_API_KEY, DIDIT_WORKFLOW_ID, DIDIT_WEBHOOK_SECRET. All three
 * absent → the feature is off and every entry point says so (fail closed).
 */

import crypto from 'crypto';
import prisma from './prisma.js';
import { mergeProfileSubkeyAtomic } from './profile-merge.js';

const BASE = 'https://verification.didit.me';
export const DIDIT_REPLAY_WINDOW_S = 300;

export function diditConfigured() {
  return !!(process.env.DIDIT_API_KEY && process.env.DIDIT_WORKFLOW_ID && process.env.DIDIT_WEBHOOK_SECRET);
}

function maskDocNumber(n) {
  const s = String(n || '');
  if (s.length < 4) return s ? '••••' : null;
  return '•'.repeat(Math.max(0, s.length - 3)) + s.slice(-3);
}

/** Didit session status → WaPay kyc status. Unknown → null (no change). */
export function mapDiditStatus(status) {
  switch (status) {
    case 'Approved': return 'VERIFIED';
    case 'Declined': return 'DECLINED';
    case 'In Review': return 'PENDING_REVIEW';
    case 'Expired':
    case 'Kyc Expired':
    case 'Abandoned': return 'EXPIRED';
    case 'Not Started':
    case 'In Progress':
    case 'Awaiting User':
    case 'Resubmitted': return 'PENDING';
    default: return null;
  }
}

async function mergeKyc(prismaClient, accountId, patch) {
  // ATOMIC nested merge (review 2026-08-28) — a concurrent language write on
  // the next inbound message can no longer clobber the KYC object.
  const ok = await mergeProfileSubkeyAtomic({
    prisma: prismaClient, accountId, key: 'kyc', patch: { ...patch, provider: 'didit' },
  });
  if (!ok) return null;
  const account = await prismaClient.account.findUnique({ where: { id: accountId } });
  return account?.profile?.kyc || null;
}

/** Digit runs of 4+ can be ID numbers/DOBs — redact before persisting free text. */
function redactPII(s) {
  return typeof s === 'string' ? s.replace(/\d{4,}/g, '####') : s;
}

/**
 * Create (or resume — vendor_data idempotency) a hosted verification session
 * for the account and record it as PENDING.
 *
 * @returns {Promise<{ok: boolean, url?: string, sessionId?: string, error?: string}>}
 */
export async function startKycSession({ prisma: prismaClient = prisma, account, fetchFn = fetch }) {
  if (!diditConfigured()) return { ok: false, error: 'DIDIT_NOT_CONFIGURED' };
  try {
    const profile = account.profile && typeof account.profile === 'object' ? account.profile : {};
    const resp = await fetchFn(`${BASE}/v3/session/`, {
      method: 'POST',
      headers: { 'x-api-key': process.env.DIDIT_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflow_id: process.env.DIDIT_WORKFLOW_ID,
        vendor_data: account.id,
        metadata: { waId: account.waId },
        language: ['af', 'en'].includes(profile.language) ? profile.language : 'en',
      }),
    });
    if (!resp.ok) {
      const status = resp.status;
      console.error(JSON.stringify({ type: 'didit_create_failed', httpStatus: status }));
      return { ok: false, error: status === 429 ? 'DIDIT_RATE_LIMITED' : `DIDIT_HTTP_${status}` };
    }
    const data = await resp.json();
    if (!data?.url || !data?.session_id) return { ok: false, error: 'DIDIT_BAD_RESPONSE' };
    await mergeKyc(prismaClient, account.id, {
      status: 'PENDING',
      sessionId: data.session_id,
      url: data.url,
      startedAt: new Date().toISOString(),
    });
    return { ok: true, url: data.url, sessionId: data.session_id };
  } catch (error) {
    console.error(JSON.stringify({ type: 'didit_create_error', error: error?.message }));
    return { ok: false, error: 'DIDIT_UNREACHABLE' };
  }
}

/**
 * Verify a Didit webhook: HMAC-SHA256 hex over the raw body bytes with the
 * webhook secret, plus the timestamp replay window. Constant-time compare.
 */
export function verifyDiditSignature({ rawBody, signature, timestamp, nowMs = Date.now() }) {
  const secret = process.env.DIDIT_WEBHOOK_SECRET;
  if (!secret || !rawBody || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > DIDIT_REPLAY_WINDOW_S) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Fetch the decision (source of truth) and apply it to the account's
 * profile.kyc. Idempotent: re-applying the same status is a no-op patch.
 * Extracted person data: name + document type + MASKED number only.
 *
 * @returns {Promise<{ok: boolean, kyc?: object, changed?: boolean, error?: string}>}
 */
export async function syncKycFromDecision({ prisma: prismaClient = prisma, accountId, sessionId, fetchFn = fetch }) {
  if (!diditConfigured()) return { ok: false, error: 'DIDIT_NOT_CONFIGURED' };
  try {
    const resp = await fetchFn(`${BASE}/v3/session/${sessionId}/decision/`, {
      headers: { 'x-api-key': process.env.DIDIT_API_KEY },
    });
    if (!resp.ok) return { ok: false, error: `DIDIT_HTTP_${resp.status}` };
    const d = await resp.json();
    // BINDING: the decision Didit returned must belong to THIS account. If
    // vendor_data is present and disagrees, refuse — a mismatched session id
    // must never write KYC onto the wrong account (review 2026-08-28).
    if (d?.vendor_data != null && String(d.vendor_data) !== String(accountId)) {
      console.error(JSON.stringify({ type: 'didit_vendor_mismatch', sessionId }));
      return { ok: false, error: 'DIDIT_VENDOR_MISMATCH' };
    }
    const mapped = mapDiditStatus(d?.status);
    if (!mapped) {
      console.error(JSON.stringify({ type: 'didit_unknown_status', status: String(d?.status).slice(0, 40) }));
      return { ok: true, changed: false };
    }
    // Guard against regressing a VERIFIED account from a stale/foreign
    // session. A legitimate re-verification carries the SAME sessionId we
    // stored; a different session id touching a VERIFIED account is refused.
    const current = await prismaClient.account.findUnique({ where: { id: accountId } });
    if (!current) return { ok: false, error: 'ACCOUNT_NOT_FOUND' };
    const prevKyc = current.profile?.kyc || {};
    if (prevKyc.status === 'VERIFIED' && mapped !== 'VERIFIED' && prevKyc.sessionId && prevKyc.sessionId !== sessionId) {
      console.error(JSON.stringify({ type: 'didit_stale_downgrade_blocked', sessionId }));
      return { ok: true, changed: false };
    }
    const patch = { status: mapped, sessionId };
    if (mapped === 'VERIFIED') {
      patch.verifiedAt = new Date().toISOString();
      const idv = Array.isArray(d.id_verifications)
        ? d.id_verifications.find((x) => x?.status === 'Approved') || d.id_verifications[0]
        : null;
      if (idv) {
        patch.fullName = idv.full_name || [idv.first_name, idv.last_name].filter(Boolean).join(' ') || null;
        patch.documentType = idv.document_type || null;
        patch.idNumberMasked = maskDocNumber(idv.personal_number || idv.document_number);
      }
    }
    if (mapped === 'DECLINED') {
      patch.declineReason = typeof d?.reviews?.[0]?.comment === 'string'
        ? redactPII(d.reviews[0].comment).slice(0, 200)
        : null;
    }
    const prev = prevKyc.status;
    const kyc = await mergeKyc(prismaClient, accountId, patch);
    return { ok: true, kyc, changed: prev !== mapped };
  } catch (error) {
    console.error(JSON.stringify({ type: 'didit_sync_error', error: error?.message }));
    return { ok: false, error: 'DIDIT_UNREACHABLE' };
  }
}

/** Mark a status as customer-notified (gates duplicate WhatsApp sends). */
export async function markKycNotified({ prisma: prismaClient = prisma, accountId, status }) {
  await mergeKyc(prismaClient, accountId, { notifiedStatus: status });
}
