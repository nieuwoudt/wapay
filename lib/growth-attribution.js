/**
 * Growth attribution (2026-10-10): where each account came from, what it
 * went on to do, and the events Meta needs to optimise ad delivery.
 *
 * Stored on `Account.profile.attribution`, written at the moments they
 * happen and read by Mission Control's Growth tab:
 *   source            ad | paylink  (organic accounts carry no attribution)
 *   adId, ctwaClid, headline, body, sourceUrl, mediaType, capturedAt
 *                     from Meta's click-to-WhatsApp `referral` on the first
 *                     message after the click (stamped SYNCHRONOUSLY in
 *                     getOrCreateUser, before any reply: a crash later in the
 *                     turn must not lose it, it cannot be recovered)
 *   referrerAccountId the requester whose pay link this person paid before
 *                     onboarding (the loop's tree: who brought whom)
 *   onboardedAt       onboarding complete (OTP, PIN, consent)
 *   capi              { lead, qualified, purchase } ISO timestamps of the
 *                     Conversions API events already sent, once each
 *
 * Everything here is best-effort and bounded: a growth write or a Meta call
 * must never slow or fail a customer's turn.
 */

import prismaDefault from './prisma.js';
import { getProfile, updateProfile } from './user-profile.js';
import { mergeProfileSubkeyAtomic } from './profile-merge.js';
import { capiConfig, buildBusinessMessagingEvent, sendCapiEvents, CAPI_EVENTS } from './meta-capi.js';

const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;

/** Meta's referral object → our attribution record, or null when it is not an ad click. Pure. */
export function attributionFromReferral(referral, now = new Date()) {
  if (!referral || typeof referral !== 'object') return null;
  const ctwaClid = referral.ctwa_clid ? String(referral.ctwa_clid).slice(0, 200) : null;
  const sourceType = referral.source_type ? String(referral.source_type).slice(0, 40) : null;
  if (!ctwaClid && sourceType !== 'ad') return null;
  return {
    source: 'ad',
    adId: referral.source_id ? String(referral.source_id).slice(0, 40) : null,
    ctwaClid,
    sourceType,
    sourceUrl: referral.source_url ? String(referral.source_url).slice(0, 300) : null,
    headline: referral.headline ? String(referral.headline).slice(0, 200) : null,
    body: referral.body ? String(referral.body).slice(0, 300) : null,
    mediaType: referral.media_type ? String(referral.media_type).slice(0, 40) : null,
    capturedAt: now.toISOString(),
  };
}

/** The profile a brand-new account is created with. Pure. */
export function newAccountProfile({ referral = null, paidBefore = false, referrerAccountId = null, now = new Date() } = {}) {
  const ad = attributionFromReferral(referral, now);
  if (ad) return { acquisitionSource: 'ad', attribution: ad };
  if (paidBefore) {
    return {
      acquisitionSource: 'paylink',
      attribution: { source: 'paylink', referrerAccountId: referrerAccountId || null, capturedAt: now.toISOString() },
    };
  }
  return { acquisitionSource: 'organic' };
}

/**
 * The requester whose pay link this number paid by card, if any (newest
 * first). Money-backed: the card rails stamp `payerMsisdn` on the intent.
 */
export async function findPayLinkReferrer({ prisma = prismaDefault, waId } = {}) {
  try {
    const local = String(waId || '').replace(/^27/, '0');
    if (!/^0\d{9}$/.test(local)) return null;
    const intent = await prisma.providerRequest.findFirst({
      where: { provider: { in: ['PAYFAST', 'ADUMO'] }, metadata: { path: ['payerMsisdn'], equals: local } },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    });
    if (!intent) return null;
    const requester = intent.metadata?.accountId ? String(intent.metadata.accountId) : null;
    return { paidBefore: true, referrerAccountId: requester };
  } catch (error) {
    console.error(JSON.stringify({ type: 'growth_referrer_lookup_error', error: error?.message }));
    return null;
  }
}

// Nested merge IN Postgres (jsonb ||) so a concurrent write to another
// attribution key is never lost; `capi` marks are merged the same way.
async function patchAttribution({ prisma, accountId, patch }) {
  const ok = await mergeProfileSubkeyAtomic({ prisma, accountId, key: 'attribution', patch });
  if (!ok) throw new Error('attribution merge failed');
  return patch;
}

/**
 * An existing account that has not finished onboarding and carries no ad
 * attribution yet, now arriving on an ad click: stamp it. Returns true when
 * something was written.
 */
export async function attachReferralIfMissing({ prisma = prismaDefault, account, referral, now = new Date() } = {}) {
  try {
    const ad = attributionFromReferral(referral, now);
    if (!ad || !account?.id) return false;
    if (account.onboardingState === 'S5_COMPLETED') return false;
    const profile = account.profile && typeof account.profile === 'object' ? account.profile : await getProfile({ prisma, accountId: account.id });
    if (profile?.attribution?.ctwaClid) return false;
    await updateProfile({ prisma, accountId: account.id, patch: { acquisitionSource: 'ad' } });
    await patchAttribution({ prisma, accountId: account.id, patch: ad });
    return true;
  } catch (error) {
    console.error(JSON.stringify({ type: 'growth_attach_referral_error', error: error?.message }));
    return false;
  }
}

/** Onboarding just completed: remember when. */
export async function markOnboarded({ prisma = prismaDefault, accountId, now = new Date() } = {}) {
  try {
    if (!accountId) return null;
    return await patchAttribution({ prisma, accountId, patch: { onboardedAt: now.toISOString() } });
  } catch (error) {
    console.error(JSON.stringify({ type: 'growth_mark_onboarded_error', error: error?.message }));
    return null;
  }
}

/** When this account onboarded, created its first link, and first received money. */
export async function accountMilestones({ prisma = prismaDefault, accountId } = {}) {
  const [consent, link, fund] = await Promise.all([
    prisma.consent.findFirst({ where: { accountId }, orderBy: { grantedAt: 'asc' }, select: { grantedAt: true } }),
    prisma.paymentRequest.findFirst({ where: { accountId }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    prisma.$queryRaw`
      SELECT je."createdAt" AS at, jl."creditCents" AS cents
      FROM "JournalLine" jl JOIN "JournalEntry" je ON je.id = jl."entryId"
      WHERE jl."accountCode" LIKE ${`WALLET:${accountId}:%`} AND jl."creditCents" > 0
      ORDER BY je."createdAt" ASC LIMIT 1`,
  ]);
  const first = Array.isArray(fund) ? fund[0] : null;
  return {
    onboardedAt: consent?.grantedAt || null,
    firstLinkAt: link?.createdAt || null,
    firstFundedAt: first?.at ? new Date(first.at) : null,
    firstFundedCents: first?.cents != null ? Number(first.cents) : null,
  };
}

/** Meta refuses event_time older than 7 days; a late sweep sends the newest allowed time. */
function clampEventTime(at, now) {
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  const floor = now.getTime() - SEVEN_DAYS_MS + 3600 * 1000;
  return new Date(Math.max(t, floor));
}

/**
 * Send the Conversions API events this account has earned and not yet had
 * sent (LeadSubmitted at onboarding, QualifiedLead at first link, Purchase
 * at first money in). Once each; marks live in profile.attribution.capi.
 * Never throws.
 */
export async function syncCapiForAccount({ prisma = prismaDefault, accountId, now = new Date(), env = process.env, fetchImpl } = {}) {
  try {
    const cfg = capiConfig(env);
    if (!cfg.configured) return { skipped: 'NOT_CONFIGURED' };
    const profile = await getProfile({ prisma, accountId });
    const attr = profile.attribution || {};
    if (!attr.ctwaClid) return { skipped: 'NO_CLICK_ID' };
    const marks = attr.capi || {};
    if (marks.lead && marks.qualified && marks.purchase) return { skipped: 'COMPLETE' };
    const ms = await accountMilestones({ prisma, accountId });
    const onboardedAt = attr.onboardedAt ? new Date(attr.onboardedAt) : ms.onboardedAt;
    const events = [];
    const earned = {};
    if (onboardedAt && !marks.lead) {
      events.push(buildBusinessMessagingEvent({ eventName: CAPI_EVENTS.LEAD, eventTime: clampEventTime(onboardedAt, now), ctwaClid: attr.ctwaClid, wabaId: cfg.wabaId, eventId: `${accountId}:lead` }));
      earned.lead = now.toISOString();
    }
    if (ms.firstLinkAt && !marks.qualified) {
      events.push(buildBusinessMessagingEvent({ eventName: CAPI_EVENTS.QUALIFIED, eventTime: clampEventTime(ms.firstLinkAt, now), ctwaClid: attr.ctwaClid, wabaId: cfg.wabaId, eventId: `${accountId}:qualified` }));
      earned.qualified = now.toISOString();
    }
    if (ms.firstFundedAt && !marks.purchase) {
      events.push(buildBusinessMessagingEvent({ eventName: CAPI_EVENTS.PURCHASE, eventTime: clampEventTime(ms.firstFundedAt, now), ctwaClid: attr.ctwaClid, wabaId: cfg.wabaId, eventId: `${accountId}:purchase`, valueCents: ms.firstFundedCents || 0 }));
      earned.purchase = now.toISOString();
    }
    if (!events.length) return { skipped: 'NOTHING_EARNED' };
    const sent = await sendCapiEvents(events, { env, fetchImpl });
    if (!sent.ok) return { ok: false, error: sent.error || sent.skipped || `status ${sent.status}` };
    await patchAttribution({ prisma, accountId, patch: { capi: { ...marks, ...earned } } });
    return { ok: true, sent: events.map((e) => e.event_name) };
  } catch (error) {
    console.error(JSON.stringify({ type: 'growth_capi_sync_error', error: error?.message }));
    return { ok: false, error: error?.message || 'sync failed' };
  }
}

/**
 * Daily floor for the Conversions API: attributed accounts whose Purchase
 * has not been sent yet, newest first, bounded by count and time.
 */
export async function capiSweep({ prisma = prismaDefault, limit = 50, deadlineMs = 15000, now = new Date(), env = process.env, fetchImpl } = {}) {
  const out = { checked: 0, sent: 0, skipped: 0, errors: 0 };
  try {
    if (!capiConfig(env).configured) return { ...out, skipped: 'NOT_CONFIGURED' };
    const rows = await prisma.$queryRaw`
      SELECT a.id
      FROM "Account" a
      WHERE a."profile"->'attribution'->>'ctwaClid' IS NOT NULL
        AND a."profile"->'attribution'->'capi'->>'purchase' IS NULL
      ORDER BY a."createdAt" DESC
      LIMIT ${limit}`;
    const started = Date.now();
    for (const r of rows) {
      if (Date.now() - started > deadlineMs) break;
      out.checked += 1;
      const res = await syncCapiForAccount({ prisma, accountId: r.id, now, env, fetchImpl });
      if (res?.ok) out.sent += res.sent.length;
      else if (res?.skipped) out.skipped += 1;
      else out.errors += 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ type: 'growth_capi_sweep_error', error: error?.message }));
    out.errors += 1;
  }
  return out;
}

/**
 * The processor's two calls. Both bounded and best-effort.
 * growthOnTurn: stamp a late ad referral on an unfinished account; send any
 * earned Conversions API event for an attributed, onboarded account.
 */
export async function growthOnTurn({ prisma = prismaDefault, account, referral, now = new Date() } = {}) {
  if (!account?.id) return;
  if (referral) await attachReferralIfMissing({ prisma, account, referral, now });
  const attr = account.profile && typeof account.profile === 'object' ? account.profile.attribution : null;
  if (account.onboardingState === 'S5_COMPLETED' && attr?.ctwaClid && !attr?.capi?.purchase && capiConfig().configured) {
    await Promise.race([
      syncCapiForAccount({ prisma, accountId: account.id, now }),
      new Promise((resolve) => setTimeout(() => resolve({ skipped: 'TIMEOUT' }), 3000)),
    ]);
  }
}

/** growthOnOnboarded: remember the moment and send LeadSubmitted straight away. */
export async function growthOnOnboarded({ prisma = prismaDefault, account, now = new Date() } = {}) {
  if (!account?.id) return;
  await markOnboarded({ prisma, accountId: account.id, now });
  if (capiConfig().configured) {
    await Promise.race([
      syncCapiForAccount({ prisma, accountId: account.id, now }),
      new Promise((resolve) => setTimeout(() => resolve({ skipped: 'TIMEOUT' }), 3000)),
    ]);
  }
}
