/**
 * GET /api/internal/flags   (x-internal-api-key)
 *
 * What production is actually running: the commit and the switches the chat
 * reads at call time, so a Vercel env change can be verified from the outside
 * without a test sign-up (founder 2026-10-19: "I've added the variable, make
 * sure it's working"). Booleans and counts only, never a secret.
 */
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import { launchHold, VAS_LIVE, RAILS, isRailLive } from '../../../lib/vas-config.js';
import { businessQuestionEnabled } from '../../../lib/business-chat.js';
import { adRemindersEnabled } from '../../../lib/ad-reminders.js';
import { readWhatsAppQuality } from '../../../lib/whatsapp-quality.js';
import { payoutLive } from '../../../lib/fee-facts.js';
import { isWicodeLive } from '../../../lib/spend-catalogue.js';
import { opsAlertRecipients } from '../../../lib/ops-alerts.js';
import { mayRegister, businessSignupAllowlist } from '../../../lib/business-auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') { res.setHeader('Allow', ['GET']); return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' }); }
  if (!requireInternalAuth(req, res)) return;
  const env = process.env;
  const quality = await readWhatsAppQuality().catch(() => null);
  return res.status(200).json({
    ok: true,
    commit: env.VERCEL_GIT_COMMIT_SHA ? String(env.VERCEL_GIT_COMMIT_SHA).slice(0, 7) : null,
    at: new Date().toISOString(),
    businessQuestion: { enabled: businessQuestionEnabled(), raw: env.WAPAY_ONBOARDING_BUSINESS_QUESTION == null ? null : String(env.WAPAY_ONBOARDING_BUSINESS_QUESTION) },
    businessSignups: { open: mayRegister('27000000000'), invited: businessSignupAllowlist().length },
    launchHold: launchHold(),
    vasLive: { airtime: VAS_LIVE.AIRTIME, data: VAS_LIVE.DATA, electricity: VAS_LIVE.ELECTRICITY, ...Object.fromEntries(Object.keys(RAILS).map((r) => [r, isRailLive(r)])) },
    fuelLive: isWicodeLive(),
    withdrawLive: payoutLive(),
    opsAlertRecipients: opsAlertRecipients().length,
    adminHost: !!(env.WAPAY_ADMIN_HOST || '').trim(),
    adReminders: adRemindersEnabled(),
    whatsapp: quality ? { qualityRating: quality.qualityRating || null, messagingLimitTier: quality.messagingLimitTier || null, status: quality.status || null, supportContact: quality.profile?.hasSupportContact ?? null, error: quality.error || null } : null,
  });
}
