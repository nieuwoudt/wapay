/**
 * Supplier floats — Mission Control's answer to "how much money sits at each
 * counterparty, and does the supplier agree with our books?" (v1.3 Task 1:
 * we fund prepaid floats and currently fly blind on them).
 *
 * Two views per supplier:
 * - LEDGER view (always available): the net CLEARING:{rail} position derived
 *   from the double-entry journal. Positive = the counterparty owes WaPay
 *   settlement; negative = WaPay owes the counterparty. Float top-up bank
 *   transfers are not yet journaled, so a prepaid supplier's ledger position
 *   and live float legitimately differ — that gap IS the drift number.
 * - SUPPLIER view (where a balance API exists): the two OTT rails, pulled
 *   server-side with a ~60s cache. Blu has no known balance endpoint (spec
 *   requested from Phuti); PayFast is an acquirer settling to bank — its API
 *   offers transaction history only (verified 2026-08-29), no balance.
 *
 * Security: admin session / internal key gated like every admin route.
 * Credentials never leave the server; supplier errors are reduced to short
 * codes so no URL, header, or provider message can leak into the response.
 */

import prisma from '../../../lib/prisma.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { OttClient } from '@wapay/providers-ott';
import { OttPayoutClient, payoutAmountToCents } from '../../../lib/ott-payout.js';

export const config = { maxDuration: 25 };

/** Serverless-instance cache: shields supplier APIs from dashboard reloads. */
const CACHE_TTL_MS = 60_000;
let cache = { at: 0, data: null };

/** Default low-float alarm line; per-supplier override via env. */
function warnThresholdCents(supplierKey) {
  const per = Number(process.env[`WAPAY_FLOAT_WARN_CENTS_${supplierKey}`]);
  if (Number.isInteger(per) && per >= 0) return per;
  const global = Number(process.env.WAPAY_FLOAT_WARN_CENTS);
  if (Number.isInteger(global) && global >= 0) return global;
  return 50_000; // R500
}

/** Reduce any supplier failure to a safe short code — never the raw message. */
function safeErrorCode(error) {
  const msg = String(error?.message || '');
  if (error?.code === 'TRANSPORT_INDETERMINATE') return 'TIMEOUT';
  if (msg === 'AUTH') return 'AUTH';
  if (msg === 'RETRYABLE') return 'UNREACHABLE';
  if (msg === 'USER_INPUT') return 'REJECTED';
  if (/^Missing env/.test(msg)) return 'NOT_CONFIGURED';
  return 'ERROR';
}

const hasEnv = (...names) => names.every((n) => !!process.env[n]);

/** Live OTT ISSUANCE float (prepaid; every voucher issued draws it down). */
async function ottIssuanceBalance() {
  if (!hasEnv('OTT_BASE_URL', 'OTT_API_USERNAME', 'OTT_API_PASSWORD', 'OTT_API_KEY')) {
    return { configured: false };
  }
  try {
    const client = new OttClient({ timeoutMs: 8000 });
    const bal = await client.getBalance();
    return {
      configured: true,
      balanceCents: bal.balanceCents,
      availableCents: bal.availableBalanceCents,
    };
  } catch (error) {
    return { configured: true, error: safeErrorCode(error) };
  }
}

/** Live OTT PAYOUT float (pre-funded; withdrawals will draw it down). */
async function ottPayoutBalance() {
  if (!hasEnv('OTT_PAYOUT_BASE_URL', 'OTT_PAYOUT_USERNAME', 'OTT_PAYOUT_PASSWORD', 'OTT_PAYOUT_API_KEY')) {
    return { configured: false };
  }
  try {
    const client = new OttPayoutClient({ timeoutMs: 8000 });
    const ref = `flt${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    const body = await client.getBalance({ yourUniqueReference: ref });
    // The payout API returns an untyped body; hunt the balance field
    // defensively and convert its rand string exactly.
    const rawBalance = body?.balance ?? body?.availableBalance ?? body?.available_balance ?? body?.Balance;
    const balanceCents = rawBalance != null ? payoutAmountToCents(rawBalance) : null;
    if (balanceCents == null) return { configured: true, error: 'REJECTED' };
    return { configured: true, balanceCents, availableCents: balanceCents };
  } catch (error) {
    return { configured: true, error: safeErrorCode(error) };
  }
}

/** Net CLEARING:* positions from the journal (debit − credit per rail). */
async function clearingPositions() {
  const rows = await prisma.journalLine.groupBy({
    by: ['accountCode'],
    where: { accountCode: { startsWith: 'CLEARING:' } },
    _sum: { debitCents: true, creditCents: true },
  });
  const positions = {};
  for (const r of rows) {
    const rail = r.accountCode.slice('CLEARING:'.length);
    positions[rail] = (r._sum.debitCents || 0) - (r._sum.creditCents || 0);
  }
  return positions;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });

  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).json(cache.data);
  }

  // A ledger query failure is UNKNOWN, never a fake R0 for every supplier.
  const [positions, ottIssue, ottPayout] = await Promise.all([
    clearingPositions().catch(() => null),
    ottIssuanceBalance(),
    ottPayoutBalance(),
  ]);

  const supplierRow = (key, name, ledgerRail, api, note) => {
    const ledgerCents = ledgerRail && positions ? positions[ledgerRail] ?? 0 : null;
    const balanceCents = api && Number.isInteger(api.availableCents) ? api.availableCents : null;
    const warnCents = warnThresholdCents(key);
    return {
      key,
      name,
      ledgerRail,
      ledgerCents,
      api: api
        ? {
            configured: api.configured,
            balanceCents: Number.isInteger(api.balanceCents) ? api.balanceCents : null,
            availableCents: balanceCents,
            error: api.error || null,
          }
        : null,
      // Drift only means something when the supplier answered AND a
      // dedicated clearing account exists for this rail.
      driftCents: balanceCents != null && ledgerCents != null ? balanceCents - ledgerCents : null,
      warnCents,
      low: balanceCents != null ? balanceCents < warnCents : null,
      note: note || null,
    };
  };

  const data = {
    generatedAt: new Date().toISOString(),
    ledgerAvailable: positions !== null,
    floats: [
      supplierRow('OTT', 'OTT issuance float', 'OTT', ottIssue,
        'Prepaid; every voucher issued draws it down.'),
      supplierRow('OTT_PAYOUT', 'OTT payout float', null, ottPayout,
        'Pre-funded for cash-outs; separate credentials from issuance. Cash-outs will book CLEARING:OTT when live.'),
      supplierRow('BLU', 'Blu trade account', 'BLU', null,
        'No balance endpoint known; OpenAPI spec requested from Phuti.'),
      supplierRow('YOYO', 'Yoyo / wiCode (UniFuel)', 'YOYO', null,
        'Posts via UniFuel wiCode issuance; supplier stats via the UniFuel service.'),
      supplierRow('PAYFAST', 'PayFast (acquirer)', 'PAYFAST', null,
        'Settles to bank; API offers transaction history only, no balance.'),
    ],
  };

  cache = { at: Date.now(), data };
  res.setHeader('Cache-Control', 'private, max-age=60');
  return res.status(200).json(data);
}
