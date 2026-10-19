/**
 * GET /api/admin/audit   (admin session cookie or internal key)
 *
 * Mission Control's Health tab: the daily conversation audit's latest run,
 * the backlog by status, the trend over the last 30 runs and the findings
 * (lib/audit/store.js). The contract, shared with the tab's writer:
 *
 *   { latestRun, counts: { open, recurring, resolved },
 *     trend: [{ date, found, resolved, open }],
 *     findings: [...], recurring: [...] }
 *
 * where a finding is { id, fingerprint, severity, category, title,
 * occurrences, firstSeenAt, lastSeenAt, status, accounts, sampleBotQuote,
 * sampleUserQuote, why, fix } and accounts is a count. `findings` holds every
 * open and recurring finding plus those resolved in the last 30 days, P1
 * first, newest first; `recurring` holds the recurring ones by occurrences.
 * Quotes come from the redacted memory with known names masked; no customer
 * identifier leaves this route. Read-only.
 */
import prisma from '../../../lib/prisma.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { statusCounts, trend, toAdminFinding, toAdminRun } from '../../../lib/audit/store.js';

export const config = { maxDuration: 25 };

const DAY_MS = 24 * 60 * 60 * 1000;
const SEV_RANK = { P1: 1, P2: 2, P3: 3 };

async function safe(fn, fallback) {
  try {
    return await fn();
  } catch (error) {
    console.error(JSON.stringify({ type: 'admin_audit_block_error', error: error?.message }));
    return fallback;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }
  const auth = requireAdmin(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });

  const resolvedSince = new Date(Date.now() - 30 * DAY_MS);
  const [latest, counts, trendRows, rows] = await Promise.all([
    safe(() => prisma.auditRun.findFirst({ orderBy: { startedAt: 'desc' } }), null),
    safe(() => statusCounts({ prisma }), { open: 0, recurring: 0, resolved: 0 }),
    safe(() => trend({ prisma, limit: 30 }), []),
    safe(() => prisma.auditFinding.findMany({
      where: { OR: [{ status: { in: ['open', 'recurring'] } }, { status: 'resolved', resolvedAt: { gte: resolvedSince } }] },
      orderBy: [{ lastSeenAt: 'desc' }],
      take: 400,
    }), []),
  ]);

  const findings = (rows || [])
    .map(toAdminFinding)
    .sort((a, b) => (SEV_RANK[a.severity] || 9) - (SEV_RANK[b.severity] || 9) || Date.parse(b.lastSeenAt || 0) - Date.parse(a.lastSeenAt || 0));
  const recurring = findings
    .filter((f) => f.status === 'recurring')
    .sort((a, b) => b.occurrences - a.occurrences || (SEV_RANK[a.severity] || 9) - (SEV_RANK[b.severity] || 9))
    .slice(0, 50);

  return res.status(200).json({
    latestRun: toAdminRun(latest),
    counts,
    trend: trendRows || [],
    findings,
    recurring,
  });
}
