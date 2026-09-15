/**
 * Rails check — can each supplier rail actually be REACHED from production,
 * and is it switched on? Presence of a credential in Vercel proves nothing;
 * this makes one real, read-only call per rail and reports the outcome.
 *
 * Built because "the env var is set" kept being mistaken for "it works"
 * (the merchant endpoints previously answered 403, which looks exactly like
 * an IP restriction, and OTT's own spec asks for a calling IP while our
 * account manager says no allowlisting is applied).
 *
 * READ-ONLY BY CONSTRUCTION: the merchant probe calls CheckVoucher with a
 * deliberately invalid PIN. That validates credentials, hashing and network
 * reachability without touching a real voucher or moving a cent. No money
 * endpoint is ever called here.
 *
 * Admin session or internal key, like every admin route. Credentials never
 * leave the server; failures reduce to short codes.
 */

import { requireAdmin } from '../../../lib/admin-auth.js';
import { OttRedemptionClient } from '../../../lib/ott-redemption.js';
import { payoutEnabled, payoutConfigured, kycRequired } from '../../../lib/payouts.js';

export const config = { maxDuration: 25 };

/** A PIN that is well-formed but cannot exist, so nothing can be consumed. */
const PROBE_PIN = '000000000000';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  res.setHeader('Cache-Control', 'private, no-store');

  const merchant = await probeMerchant();

  return res.status(200).json({
    generatedAt: new Date().toISOString(),
    ottRedemption: merchant,
    payout: {
      enabled: payoutEnabled(),
      configured: payoutConfigured(),
      kycRequired: kycRequired(),
      note: payoutEnabled()
        ? null
        : 'Set WAPAY_PAYOUT_ENABLED=true to open cash-out (counsel gate).',
    },
  });
}

async function probeMerchant() {
  const configured = !!(
    process.env.OTT_MERCHANT_API_KEY &&
    process.env.OTT_MERCHANT_API_USERNAME &&
    process.env.OTT_MERCHANT_API_PASSWORD
  );
  if (!configured) return { configured: false, reachable: null, verdict: 'NOT_CONFIGURED' };

  const base = process.env.OTT_MERCHANT_BASE_URL || process.env.OTT_BASE_URL || '';
  const live = !/(^|\/\/)test-/.test(base);

  try {
    const client = new OttRedemptionClient({ timeoutMs: 8000 });
    await client.checkVoucher(PROBE_PIN);
    // A valid response for an impossible PIN would be very odd, but it
    // still proves the rail answers us.
    return { configured: true, live, reachable: true, verdict: 'REACHABLE' };
  } catch (error) {
    // USER_INPUT means OTT received the call, authenticated it, and
    // rejected the PIN on business grounds. That is a PASS for us.
    if (error.message === 'USER_INPUT') {
      return {
        configured: true, live, reachable: true, verdict: 'REACHABLE',
        detail: 'credentials and hashing accepted; the probe PIN was rejected as expected',
      };
    }
    if (error.message === 'AUTH') {
      return {
        configured: true, live, reachable: true, verdict: 'AUTH_FAILED',
        detail: 'the endpoint answered but rejected the credentials (401)',
      };
    }
    // RETRYABLE covers network failure, timeout and 5xx. A 403 from an IP
    // restriction also lands here, which is the case worth naming.
    return {
      configured: true, live, reachable: false, verdict: 'UNREACHABLE',
      detail: 'no usable answer: network, timeout, 5xx, or an IP restriction (403)',
    };
  }
}
