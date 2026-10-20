/**
 * Read-only OTT payout rail probe for operators (internal key). Uses the
 * deployment's OTT_PAYOUT_* credentials to call the three read endpoints
 * (GetBalance, GetActiveProviders, GetActiveProvidersLimits; GetCountryCodes
 * with ?countries=1) and reports
 * what came back, masked. No pay-out can be started here. It answers the
 * sandbox's first questions (are the credentials right, which provider
 * codes exist, which recipient fields each needs) without secrets leaving
 * Vercel.
 */
import crypto from 'node:crypto';
import { OttPayoutClient } from '../../../lib/ott-payout.js';
import { payoutEnabled, payoutConfigured, kycRequired, resolveProviders, _resetProviderCache } from '../../../lib/payouts.js';
import { diditConfigured } from '../../../lib/didit-kyc.js';
import { vaultConfigured } from '../../../lib/pii-vault.js';
import { COOLOFF_HOURS } from '../../../lib/pin-reset.js';
import { RESUME_HOURS } from '../../../lib/payout-chat.js';

export const config = { maxDuration: 25 };

function keyOk(req) {
  const internalKey = process.env.WAPAY_INTERNAL_API_KEY || '';
  const presented = req.headers['x-internal-api-key'];
  if (!internalKey || typeof presented !== 'string' || !presented) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(internalKey).digest();
  return crypto.timingSafeEqual(a, b);
}
const mask = (s) => (s ? `${String(s).slice(0, 2)}…${String(s).slice(-2)}` : null);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!keyOk(req)) return res.status(401).json({ error: 'unauthorized' });
  const out = {
    checkedAt: new Date().toISOString(),
    build: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null,
    // alertEmail: whether the withdraw gate's third tier can actually reach a person (lib/payout-gate.js).
    switches: { payoutEnabled: payoutEnabled(), payoutConfigured: payoutConfigured(), kycRequired: kycRequired(), diditConfigured: diditConfigured(), alertEmail: !!process.env.ALERT_EMAIL && !!process.env.RESEND_API_KEY,
      // The safeguards' switches, as booleans and numbers only, never a value (BUGLOG #111 to #113).
      piiKey: vaultConfigured(), pinProofSecret: !!(process.env.WAPAY_PIN_PROOF_SECRET || process.env.PIN_PEPPER || process.env.WAPAY_INTERNAL_API_KEY),
      pinPepperSet: !!process.env.PIN_PEPPER, cronSecretSet: !!(process.env.CRON_SECRET && process.env.CRON_SECRET.length >= 16), pinResetCoolOffHours: COOLOFF_HOURS(), payoutResumeHours: RESUME_HOURS(),
      stateIdleMinutes: Number(process.env.WAPAY_STATE_IDLE_MINUTES ?? 30) },
    env: { baseUrl: process.env.OTT_PAYOUT_BASE_URL || null, username: mask(process.env.OTT_PAYOUT_USERNAME), password: !!process.env.OTT_PAYOUT_PASSWORD, apiKey: mask(process.env.OTT_PAYOUT_API_KEY) },
  };
  if (!payoutConfigured()) return res.status(200).json({ ...out, error: 'OTT_PAYOUT_* incomplete in this deployment' });
  const client = new OttPayoutClient({ timeoutMs: 8000 });
  const ref = () => `WPS${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const safe = async (label, fn) => {
    try { return await fn(); } catch (e) { return { error: { code: e?.code || null, message: String(e?.message || e).slice(0, 200) }, label }; }
  };
  out.balance = await safe('balance', () => client.getBalance({ yourUniqueReference: ref() }));
  out.providers = await safe('providers', () => client.getActiveProviders({ yourUniqueReference: ref() }));
  out.limits = await safe('limits', () => (typeof client.getActiveProviderLimits === 'function' ? client.getActiveProviderLimits({ yourUniqueReference: ref() }) : { skipped: true }));
  _resetProviderCache();
  out.mapped = await safe('mapped', () => resolveProviders({ client }));
  // ?countries=1: OTT's country list (the shape a passport pay-out's country_of_issue takes, 2026-10-12). A read.
  if (String(req.query?.countries || '') === '1') out.countries = await safe('countries', () => client.getCountryCodes({ yourUniqueReference: ref() }));
  return res.status(200).json(out);
}
