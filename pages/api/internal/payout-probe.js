/**
 * Sandbox-only PerformPayout probe (internal key). Sends ONE pay-out request
 * to OTT's TEST environment exactly as the withdraw flow would (same client,
 * same recipient cleaning, same live provider list) and returns the exact
 * wire request and the raw response, masked, so a supplier question ("share
 * your request and response") is answered with facts. Never touches the
 * ledger or a customer row; refuses any base URL whose host does not start
 * with "test-", and any amount above R50.
 *
 *   POST { method: 'PAYSHAP'|'NEDCASH'|…, amountCents: 2000, recipient: {…}, encoding?: 'form' }
 */
import crypto from 'node:crypto';
import { OttPayoutClient, DEFAULT_HASH_STYLE } from '../../../lib/ott-payout.js';
import { resolveProviders, cleanRecipient, payoutReference, payoutConfigured, _resetProviderCache } from '../../../lib/payouts.js';

export const config = { maxDuration: 25 };

function keyOk(req) {
  const internalKey = process.env.WAPAY_INTERNAL_API_KEY || '';
  const presented = req.headers['x-internal-api-key'];
  if (!internalKey || typeof presented !== 'string' || !presented) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(internalKey).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Long digit runs (account, ID, cellphone) keep their last three digits; the hash keeps a prefix. */
const maskDigits = (s) => String(s).replace(/\d{6,}/g, (d) => `***${d.slice(-3)}`);
function maskDeep(v) {
  if (typeof v === 'string') return maskDigits(v);
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'hashcheck' ? `${String(x).slice(0, 8)}…` : maskDeep(x)]));
  return v;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!keyOk(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!payoutConfigured()) return res.status(503).json({ error: 'OTT_PAYOUT_* incomplete in this deployment' });
  const host = new URL(process.env.OTT_PAYOUT_BASE_URL).hostname;
  if (!host.startsWith('test-')) return res.status(403).json({ error: 'SANDBOX_ONLY', host });

  const { method = 'PAYSHAP', amountCents = 2000, recipient = {}, encoding } = req.body && typeof req.body === 'object' ? req.body : {};
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 5000) return res.status(400).json({ error: 'amountCents must be an integer from 1 to 5000' });

  const client = new OttPayoutClient({ timeoutMs: 20000, ...(encoding === 'form' ? { bodyEncoding: 'form' } : {}) });
  _resetProviderCache();
  const providers = await resolveProviders({ client }).catch(() => []);
  const provider = providers.find((p) => p.method === method);
  if (!provider) return res.status(400).json({ error: 'NO_PROVIDER', method, available: providers.map((p) => p.method) });
  let cleaned;
  try {
    cleaned = cleanRecipient(method, recipient, provider.requiredFields);
  } catch (e) {
    return res.status(400).json({ error: e.code || 'BAD_RECIPIENT', field: e.field || null });
  }
  // Hash renderings to try, in order; the first answer that is not "Invalid Hash" ends the run
  // (a real status means OTT accepted the hash, whatever it then decided about the pay-out).
  const variants = Array.isArray(req.body?.variants) && req.body.variants.length ? req.body.variants.slice(0, 4) : [DEFAULT_HASH_STYLE];
  const attempts = [];
  for (const hashStyle of variants) {
    const reference = payoutReference(`probe-${crypto.randomBytes(8).toString('hex')}`);
    const result = await client.performPayout({ amountCents, providerCode: provider.providerCode, providerName: provider.providerName, recipient: cleaned, yourUniqueReference: reference, hashStyle });
    attempts.push({
      reference,
      hashStyle,
      request: maskDeep(result.wire),
      response: { httpStatus: result.httpStatus, status: result.status, outcome: result.outcome, settlement: result.settlement, paymentReference: result.paymentReference || null, errors: result.errors || null, body: maskDeep(result.body) },
    });
    if (result.outcome !== 'INVALID_HASH') break;
  }
  const last = attempts[attempts.length - 1];
  return res.status(200).json({
    checkedAt: new Date().toISOString(),
    build: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null,
    host,
    provider: { method, providerCode: provider.providerCode, providerName: provider.providerName, requiredFields: provider.requiredFields },
    accepted: last.response.outcome !== 'INVALID_HASH' ? last.hashStyle : null,
    attempts,
  });
}
