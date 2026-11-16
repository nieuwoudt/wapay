/**
 * PayCentral connectivity probe (internal key). Read-only: it only logs in, never touches a
 * card or money. It answers the one-whitelisted-address question (docs/CARDS.md 0.11):
 *   - `samples` single-attempt logins, each on a fresh connection, counted as ok,
 *     refused at the door, or other: with a Vercel Static IPs pair and one address
 *     whitelisted, roughly half should be refused if Vercel spreads connections over both;
 *   - one normal login with door retries, which is what every real call does.
 * If the door refuses often or the normal login fails, set PAYCENTRAL_EGRESS_PROXY (one fixed
 * address of our own) and send PayCentral that address instead.
 * Reports presence booleans and masks only: never the password, the token or the proxy URL.
 */
import crypto from 'node:crypto';
import { PayCentralClient, payCentralConfigured, _resetPayCentralState } from '../../../lib/paycentral.js';

export const config = { maxDuration: 60 };

function keyOk(req) {
  const internalKey = process.env.WAPAY_INTERNAL_API_KEY || '';
  const presented = req.headers['x-internal-api-key'];
  if (!internalKey || typeof presented !== 'string' || !presented) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(internalKey).digest();
  return crypto.timingSafeEqual(a, b);
}
const maskEmail = (s) => (s ? `${String(s).slice(0, 2)}…@${String(s).split('@')[1] || ''}` : null);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!keyOk(req)) return res.status(401).json({ error: 'unauthorized' });

  const out = {
    checkedAt: new Date().toISOString(),
    build: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null,
    region: process.env.VERCEL_REGION || null,
    configured: payCentralConfigured(),
    env: {
      baseUrl: process.env.PAYCENTRAL_BASE_URL || null,
      email: maskEmail(process.env.PAYCENTRAL_API_EMAIL),
      password: !!process.env.PAYCENTRAL_API_PASSWORD,
      egress: process.env.PAYCENTRAL_EGRESS_PROXY ? 'single address via PAYCENTRAL_EGRESS_PROXY' : 'Vercel Static IPs pair',
      wholeRands: process.env.PAYCENTRAL_WHOLE_RANDS !== 'false',
    },
  };
  if (!out.configured) return res.status(200).json({ ...out, error: 'PAYCENTRAL_API_EMAIL / PAYCENTRAL_API_PASSWORD not set in this deployment' });

  const samples = Math.min(Math.max(Number(req.query?.samples) || 6, 1), 10);
  const sampleClient = new PayCentralClient({ connectTimeoutMs: 3000, timeoutMs: 8000 });
  const tally = { ok: 0, refusedAtDoor: 0, other: 0, otherCodes: [] };
  for (let i = 0; i < samples; i += 1) {
    try {
      await sampleClient.authenticate({ fresh: true, doorAttempts: 1 });
      tally.ok += 1;
    } catch (e) {
      if (e?.code === 'DOOR_REFUSED') tally.refusedAtDoor += 1;
      else {
        tally.other += 1;
        if (tally.otherCodes.length < 3) tally.otherCodes.push(e?.code || 'ERROR');
      }
    }
  }
  out.samples = { attempts: samples, ...tally };

  _resetPayCentralState();
  try {
    const client = new PayCentralClient({ connectTimeoutMs: 3000 });
    const r = await client.authenticate({ fresh: true });
    out.loginWithRetries = { ok: true, ms: r.ms };
  } catch (e) {
    out.loginWithRetries = { ok: false, code: e?.code || 'ERROR', attempts: e?.attempts ?? null };
  }
  out.verdict = out.loginWithRetries.ok
    ? (out.samples.refusedAtDoor > 0 ? 'Works with retries; some connections leave from the non-whitelisted address' : 'Works; no refusals seen')
    : 'Not reachable: check the whitelist, or set PAYCENTRAL_EGRESS_PROXY';
  return res.status(200).json(out);
}
