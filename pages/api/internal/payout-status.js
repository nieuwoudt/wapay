/**
 * Read-only OTT payout rail probe for operators (internal key). Uses the
 * deployment's OTT_PAYOUT_* credentials to call the three read endpoints
 * (GetBalance, GetActiveProviders, GetActiveProvidersLimits) and reports
 * what came back, masked. No pay-out can be started here. It answers the
 * sandbox's first questions (are the credentials right, which provider
 * codes exist, which recipient fields each needs) without secrets leaving
 * Vercel.
 */
import crypto from 'node:crypto';
import { OttPayoutClient } from '../../../lib/ott-payout.js';
import { payoutEnabled, payoutConfigured, kycRequired, resolveProviders, _resetProviderCache } from '../../../lib/payouts.js';
import { diditConfigured } from '../../../lib/didit-kyc.js';

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
    switches: { payoutEnabled: payoutEnabled(), payoutConfigured: payoutConfigured(), kycRequired: kycRequired(), diditConfigured: diditConfigured() },
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
  return res.status(200).json(out);
}
