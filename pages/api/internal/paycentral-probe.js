/**
 * PayCentral connectivity probe (internal key). Read-only: it logs in once and then reads a
 * balance for card "0" (an answer of "card not found" is fine); it never touches a card or money.
 * It answers the one-whitelisted-address question (docs/CARDS.md 0.11):
 *   - one login with the client's normal door retries, which is what every real call does;
 *   - `samples` single attempts, each on a fresh connection with no retry, counted as ok,
 *     refused while connecting, refused with a 403, or failed after connecting. With a Vercel
 *     Static IPs pair and one address whitelisted, about half are refused if Vercel spreads
 *     connections over both addresses. How they are refused tells us where the whitelist sits.
 * If the login fails or refusals are frequent, set PAYCENTRAL_EGRESS_PROXY (one fixed address of
 * our own) and send PayCentral that address instead.
 * Reports presence booleans and masks only: never the password, the token or the proxy URL.
 * Bounded to about 45 seconds whatever PayCentral does.
 */
import crypto from 'node:crypto';
import { PayCentralClient, payCentralConfigured } from '../../../lib/paycentral.js';

export const config = { maxDuration: 60 };

const WALL_BUDGET_MS = 45000;

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
  const started = Date.now();

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

  let client;
  try {
    client = new PayCentralClient({ connectTimeoutMs: 3000, timeoutMs: 5000, readAttempts: 1, callBudgetMs: 15000 });
  } catch (e) {
    return res.status(200).json({ ...out, error: e?.code || 'CONFIG' });
  }

  try {
    const r = await client.authenticate();
    out.login = { ok: true, ms: r.ms };
  } catch (e) {
    out.login = { ok: false, code: e?.code || 'ERROR', attempts: e?.attempts ?? null };
  }

  const samples = Math.min(Math.max(Number(req.query?.samples) || 6, 1), 10);
  const tally = { attempts: 0, ok: 0, refused_connect: 0, refused_403: 0, failed_after_connect: 0, error: 0 };
  if (out.login.ok) {
    for (let i = 0; i < samples && Date.now() - started < WALL_BUDGET_MS - 6000; i += 1) {
      tally.attempts += 1;
      try {
        tally[await client.doorSample()] += 1;
      } catch {
        tally.error += 1;
      }
    }
  }
  out.samples = tally;
  const refused = tally.refused_connect + tally.refused_403;
  out.verdict = !out.login.ok
    ? 'Not reachable: check the whitelist and the credentials, or set PAYCENTRAL_EGRESS_PROXY'
    : refused > 0
      ? `Works with retries: ${refused} of ${tally.attempts} connections left from the other address (${tally.refused_connect} at connect, ${tally.refused_403} by 403)`
      : 'Works: no refusals seen';
  out.ms = Date.now() - started;
  return res.status(200).json(out);
}
