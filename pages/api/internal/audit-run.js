/**
 * POST /api/internal/audit-run[?since=ISO][&dry=1]   (x-internal-api-key)
 *
 * Runs the daily conversation audit now (lib/audit/run.js): the same step the
 * 02:00 UTC cron takes, with a longer budget. `since` overrides the window's
 * start (otherwise the last run's end, or 24 hours); `dry=1` computes and
 * returns everything without writing a row or sending the summary. The
 * answer carries counts, patterns and the findings (redacted quotes, account
 * ids only); never a name or a number.
 *
 *   curl -X POST -H "x-internal-api-key: $KEY" \
 *     "https://wapay-api.vercel.app/api/internal/audit-run?dry=1"
 */
import prisma from '../../../lib/prisma.js';
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import { runDailyAudit } from '../../../lib/audit/run.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }
  if (!requireInternalAuth(req, res)) return;
  const sinceRaw = req.query?.since ? String(req.query.since) : null;
  const since = sinceRaw ? new Date(sinceRaw) : null;
  if (since && Number.isNaN(since.getTime())) return res.status(400).json({ ok: false, error: 'BAD_SINCE' });
  const dry = String(req.query?.dry) === '1';
  const out = await runDailyAudit({ prisma, since, dry, deadlineMs: 50_000 });
  return res.status(out.ok ? 200 : 500).json(out);
}
