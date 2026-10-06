/**
 * POST /api/internal/blu-voucher-probe
 *
 * Operator probe for the Blu Voucher STATUS endpoint only
 * (GET /voucher/variable/vouchers?token=…). Read-only on Blu's side: it never
 * redeems, never touches the ledger, writes no row. Exists because the chat's
 * "Status Check Failed" on 2026-10-06 hid whether Blu refused the credentials,
 * the endpoint failed, or the voucher was unknown, and Vercel logs are not
 * readable from the Blu thread.
 *
 * Internal key only. The PIN is a bearer secret: it travels in the POST body,
 * is passed straight to BluClient.checkStatus (which logs it masked), and is
 * never echoed; the answer carries the voucher's status and value and, on a
 * failure, the supplier's status code and a masked, capped reason.
 */
import { BluClient } from '@wapay/providers-blu';
import { requireInternalAuth } from '../../../lib/internal-auth.js';

export const config = { maxDuration: 25 };

function masked(text) {
  return String(text || '').replace(/\d{6,}/g, (m) => `${'*'.repeat(m.length - 2)}${m.slice(-2)}`).slice(0, 200);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }
  if (!requireInternalAuth(req, res)) return;
  const pin = String(req.body?.pin || '').replace(/[\s-]/g, '');
  if (!/^\d{12,16}$/.test(pin)) {
    return res.status(400).json({ ok: false, error: 'USER_INPUT', message: 'pin must be 12 to 16 digits' });
  }
  const host = String(process.env.BLU_BASE_URL || '').replace(/^https?:\/\//, '').split('/')[0];
  const startedAt = Date.now();
  try {
    const client = new BluClient();
    const status = await client.checkStatus(pin);
    return res.status(200).json({
      ok: true,
      host,
      ms: Date.now() - startedAt,
      pinLast4: pin.slice(-4),
      status: status?.status ?? null,
      amountCents: status?.amount_cents ?? null,
      expiryDate: status?.expiryDate ?? status?.expiry ?? null,
    });
  } catch (error) {
    return res.status(200).json({
      ok: false,
      host,
      ms: Date.now() - startedAt,
      pinLast4: pin.slice(-4),
      error: {
        kind: error?.message || null,
        statusCode: error?.statusCode ?? null,
        reason: masked(error?.reason || error?.providerMessage || ''),
        userMessage: masked(error?.userMessage || ''),
      },
    });
  }
}
