/**
 * Read-only Adumo probe for operators (internal key): which switches are on,
 * whether the hosted-page and the reporting credentials are present (masked),
 * whether OAuth answers, and optionally the state of one transaction
 * (`?mref=PRXXXXXX-1` or `?tx=<transactionId>`). Nothing here can move money.
 */
import crypto from 'node:crypto';
import { adumoConfig, adumoConfigured, adumoEnabled, primaryCardRail } from '../../../lib/adumo.js';
import { AdumoReportingClient, adumoReportingConfig, adumoReportingConfigured } from '../../../lib/adumo-reporting.js';

export const config = { maxDuration: 25 };

function keyOk(req) {
  const internalKey = process.env.WAPAY_INTERNAL_API_KEY || '';
  const presented = req.headers['x-internal-api-key'];
  if (!internalKey || typeof presented !== 'string' || !presented) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(internalKey).digest();
  return crypto.timingSafeEqual(a, b);
}
const mask = (s) => (s ? `${String(s).slice(0, 4)}…${String(s).slice(-2)}` : null);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!keyOk(req)) return res.status(401).json({ error: 'unauthorized' });
  const c = adumoConfig();
  const r = adumoReportingConfig();
  const out = {
    checkedAt: new Date().toISOString(),
    build: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null,
    switches: { enabled: adumoEnabled(), configured: adumoConfigured(), primaryCardRail: primaryCardRail(), sandbox: c.sandbox },
    virtual: { merchantId: mask(c.merchantId), applicationId: mask(c.applicationId), jwtSecret: !!c.jwtSecret },
    reporting: { configured: adumoReportingConfigured(), base: r.base, clientId: mask(r.clientId), clientSecret: !!r.clientSecret },
  };
  if (!adumoReportingConfigured()) return res.status(200).json(out);
  const client = new AdumoReportingClient({ timeoutMs: 8000 });
  try {
    await client.token();
    out.reporting.tokenOk = true;
  } catch (e) {
    out.reporting.tokenOk = false;
    out.reporting.error = { code: e?.code || null, httpStatus: e?.httpStatus || null };
    return res.status(200).json(out);
  }
  const mref = String(req.query.mref || '').trim();
  const tx = String(req.query.tx || '').trim();
  if (mref || tx) {
    try {
      out.transaction = tx ? await client.getStateByTransactionId(tx) : await client.getStateByMerchantReference(mref);
      delete out.transaction.body;
    } catch (e) {
      out.transaction = { error: e?.code || 'TRANSPORT', httpStatus: e?.httpStatus || null };
    }
  }
  return res.status(200).json(out);
}
