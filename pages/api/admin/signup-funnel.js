/**
 * GET /api/admin/signup-funnel?range=7|30|90|all   (admin session, or the internal key)
 *
 * Mission Control's "Sign-up funnel" card on the Growth tab (2026-10-22): the same
 * numbers as GET /api/internal/funnel (lib/signup-funnel.js) for the tab's range,
 * per UTC day up to today, split ONE_STEP | CLASSIC. Aggregates only.
 */
import prisma from '../../../lib/prisma.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { loadFunnel, parseWindow } from '../../../lib/signup-funnel.js';
import { onboardingFlagsReadout } from '../../../lib/onboarding-flags.js';

export const config = { maxDuration: 30 };

const RANGES = { '7': 7, '30': 30, '90': 90, all: 366 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const days = RANGES[String(req.query?.range || '30')] ?? 30;
  const now = new Date();
  const until = now.toISOString().slice(0, 10);
  const since = new Date(Date.parse(`${until}T00:00:00.000Z`) - (days - 1) * 86400000).toISOString().slice(0, 10);
  const w = parseWindow({ since, until, now });
  if (!w.ok) return res.status(400).json({ error: w.error });
  try {
    const funnel = await loadFunnel({ prisma, since: w.since, until: w.until, now });
    return res.status(200).json({ ok: true, generatedAt: now.toISOString(), flags: onboardingFlagsReadout(), ...funnel });
  } catch (error) {
    console.error(JSON.stringify({ type: 'admin_signup_funnel_error', error: String(error?.message || error).slice(0, 200) }));
    return res.status(500).json({ error: 'FUNNEL_FAILED' });
  }
}
