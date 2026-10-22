/**
 * Payer pre-registration (C, WAPAY_PAYER_PREREGISTER; docs/ONBOARDING.md §5,
 * 2026-10-22). When a card payer pays a link with their number and that number
 * has no WaPay account, an account record is made for it in S0_INITIAL with
 * profile.origin = { kind: 'PAYER', requestCode, paidAt }, so their history is
 * there the day they write. Their first message, or their tap on the v2
 * receipt's "My receipt" button, opens it in one step with the receipt on top.
 *
 * POPIA: the payer gave this number for their receipt. It is used for that
 * receipt and for nothing else until they write to WaPay themselves: no message
 * beyond the receipt they already get, no marketing, no reminder, no profiling.
 * The row holds the number, the link it paid and when; the attribution the
 * loop already records for a payer (acquisitionSource paylink, the requester
 * as referrer, exactly what getOrCreateUser would stamp on their first
 * message); a SPEND wallet at zero. Nothing else.
 *
 * Also the v2 receipt template's message (docs/templates/wapay_payment_receipt_v2.md).
 */
import prismaDefault from './prisma.js';
import { newAccountProfile } from './growth-attribution.js';
import { normaliseMsisdn, toWaId } from './msisdn.js';
import { firstNameFrom } from './ad-flow.js';
import { receiptButtonPayload } from './one-step-signup.js';

const log = (type, data) => console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));

/**
 * Make the payer's S0 account when their number has none. Idempotent: a number
 * with any account (either stored form) is left untouched; a race adopts the
 * winner (upsert on the unique waId). Never throws.
 * @returns {Promise<{ ok: boolean, created?: boolean, existed?: boolean, accountId?: string, reason?: string }>}
 */
export async function preRegisterPayer({ prisma = prismaDefault, payerMsisdn, requestCode, paidAt = null, referrerAccountId = null, now = new Date() } = {}) {
  try {
    const wa = toWaId(payerMsisdn);
    const local = normaliseMsisdn(payerMsisdn);
    if (!/^27\d{9}$/.test(wa) || !/^0\d{9}$/.test(local)) return { ok: false, reason: 'BAD_NUMBER' };
    const code = String(requestCode || '').toUpperCase();
    if (!/^PR[A-HJKMNP-Z]{6}$/.test(code)) return { ok: false, reason: 'BAD_CODE' };
    const existing = await prisma.account.findFirst({ where: { OR: [{ waId: wa }, { msisdn: wa }, { msisdn: local }, { waId: local }] }, select: { id: true } });
    if (existing) return { ok: true, existed: true, accountId: existing.id };
    const paid = paidAt ? new Date(paidAt) : now;
    const profile = {
      ...newAccountProfile({ paidBefore: true, referrerAccountId: referrerAccountId || null, now }),
      origin: { kind: 'PAYER', requestCode: code, paidAt: (Number.isNaN(paid.getTime()) ? now : paid).toISOString() },
    };
    const account = await prisma.account.upsert({
      where: { waId: wa },
      create: { waId: wa, msisdn: wa, displayName: 'Friend', onboardingState: 'S0_INITIAL', createdAt: now, profile },
      update: {},
    });
    await prisma.wallet.upsert({
      where: { accountId_balanceType: { accountId: account.id, balanceType: 'SPEND' } },
      create: { accountId: account.id, balanceType: 'SPEND', currency: 'ZAR', availableCents: 0, pendingCents: 0 },
      update: {},
    });
    const created = account?.profile?.origin?.requestCode === code;
    log('payer_preregistered', { accountId: account.id, requestCode: code, created });
    return { ok: true, created, accountId: account.id };
  } catch (error) {
    log('payer_preregister_error', { error: error?.message });
    return { ok: false, reason: 'ERROR' };
  }
}

/**
 * A pre-registered payer writes for the first time: the account starts now. Its age (the
 * pay-out rules' new-account cap, lib/payout-rules.js), the sign-up funnel and the Growth tab
 * count from this moment, never from the receipt, so a number cannot be aged by paying a link
 * and waiting; profile.origin.paidAt keeps the receipt's time. Stamps profile.onboarding with
 * the path and startedAt and moves createdAt to now, once, on any sign-up path, atomically in
 * Postgres. Never throws.
 */
export async function markPayerStarted({ prisma = prismaDefault, account, path = 'CLASSIC', now = new Date() } = {}) {
  try {
    const p = account?.profile && typeof account.profile === 'object' ? account.profile : null;
    if (!account?.id || p?.origin?.kind !== 'PAYER' || p?.onboarding?.startedAt) return false;
    const defaults = JSON.stringify({ path: path === 'ONE_STEP' ? 'ONE_STEP' : 'CLASSIC', startedAt: now.toISOString() });
    const moved = await prisma.$executeRaw`
      UPDATE "Account"
      SET "createdAt" = now(),
          profile = jsonb_set(coalesce(profile, '{}'::jsonb), '{onboarding}', ${defaults}::jsonb || coalesce(profile->'onboarding', '{}'::jsonb), true)
      WHERE id = ${account.id}
        AND profile->'origin'->>'kind' = 'PAYER'
        AND (profile->'onboarding'->>'startedAt') IS NULL`;
    if (moved) log('payer_started', { accountId: account.id, path });
    return moved > 0;
  } catch (error) {
    log('payer_started_error', { accountId: account?.id || null, error: error?.message });
    return false;
  }
}

/**
 * The v2 receipt template's send (UTILITY, wapay_payment_receipt_v2): {{1}} the
 * amount, {{2}} the requester's first name (a business's name for a business
 * link), {{3}} the reference; the "My receipt" quick-reply button carries
 * WAPAY_RECEIPT:<code>, which comes back with the tap. Pure.
 */
export function receiptV2TemplateMessage({ to, templateName, amount, requesterFirstName, reference, code }) {
  return {
    to,
    templateName,
    language: 'en',
    components: [
      { type: 'body', parameters: [
        { type: 'text', text: String(amount) },
        { type: 'text', text: String(requesterFirstName || 'a WaPay user') },
        { type: 'text', text: String(reference) },
      ] },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: receiptButtonPayload(code) }] },
    ],
  };
}

/** The name on the v2 receipt: the business's name, else the requester's first name, else a neutral label. Pure. */
export function receiptV2Name({ requester = null, businessName = null } = {}) {
  if (businessName) return String(businessName).slice(0, 60);
  return firstNameFrom(requester?.displayName) || 'a WaPay user';
}
