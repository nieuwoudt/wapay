/**
 * GET /api/internal/funnel?since=YYYY-MM-DD&until=YYYY-MM-DD   (x-internal-api-key)
 *
 * The sign-up funnel (lib/signup-funnel.js, docs/ONBOARDING.md §5, 2026-10-22): per
 * UTC day from `since` to `until` (both included; default the last 14 days), the
 * accounts opened, finished sign-up, finished within 10 minutes, a first link
 * within 24 hours, a first link paid within 72 hours and a pay-out within 72
 * hours, split by the path each account was opened on (ONE_STEP | CLASSIC), with
 * the rates; whether the one-step switch was on that day; and a `summary` for the
 * whole window. Counts and rates only: no number, name or account id.
 */
import prisma from '../../../lib/prisma.js';
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import { loadFunnel, parseWindow } from '../../../lib/signup-funnel.js';
import { onboardingFlagsReadout } from '../../../lib/onboarding-flags.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') { res.setHeader('Allow', ['GET']); return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' }); }
  if (!requireInternalAuth(req, res)) return;
  const w = parseWindow({ since: req.query?.since || null, until: req.query?.until || null });
  if (!w.ok) return res.status(400).json({ ok: false, error: w.error });
  try {
    const funnel = await loadFunnel({ prisma, since: w.since, until: w.until });
    return res.status(200).json({ ok: true, generatedAt: new Date().toISOString(), flags: onboardingFlagsReadout(), ...funnel });
  } catch (error) {
    console.error(JSON.stringify({ type: 'internal_funnel_error', error: String(error?.message || error).slice(0, 200) }));
    return res.status(500).json({ ok: false, error: 'FUNNEL_FAILED' });
  }
}
