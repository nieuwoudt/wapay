/**
 * GET /api/admin/inbox?days=7&limit=100   (admin session or internal key)
 *
 * The support inbox (founder 2026-10-19): every customer who wrote in the
 * window, newest first, with what the operator needs to triage: the last thing
 * they said, whether it was answered, the withdraw gate's tier, whether a person
 * was asked, whether they asked to close the account, whether a person has
 * replied. Reading is bounded (turns per account trimmed on the server).
 */
import prisma from '../../../lib/prisma.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { summariseTurns } from '../../../lib/inbox.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const limit = Math.min(300, Math.max(10, Number(req.query.limit) || 100));
  const since = new Date(Date.now() - days * 86400000);
  const heads = await prisma.$queryRaw`
    SELECT "accountId", max("createdAt") AS last_user_at, count(*)::int AS n
    FROM conversation_turns WHERE role = 'user' AND "createdAt" >= ${since}
    GROUP BY 1 ORDER BY 2 DESC LIMIT ${limit}`;
  const ids = (heads || []).map((h) => h.accountId);
  if (!ids.length) return res.status(200).json({ days, items: [] });
  const [accounts, turns] = await Promise.all([
    prisma.account.findMany({ where: { id: { in: ids } }, select: { id: true, msisdn: true, waId: true, displayName: true, onboardingState: true, conversationState: true, createdAt: true, profile: true } }),
    prisma.conversationTurn.findMany({ where: { accountId: { in: ids }, createdAt: { gte: new Date(since.getTime() - 86400000) } }, orderBy: { createdAt: 'asc' }, select: { accountId: true, role: true, kind: true, text: true, createdAt: true, refs: true } }),
  ]);
  const byAcc = new Map(); for (const t of turns) { if (!byAcc.has(t.accountId)) byAcc.set(t.accountId, []); byAcc.get(t.accountId).push({ at: t.createdAt, role: t.role, kind: t.kind, text: t.text, refs: t.refs || null }); }
  const acc = new Map(accounts.map((a) => [a.id, a]));
  const items = ids.map((id) => {
    const a = acc.get(id); const ts = (byAcc.get(id) || []).slice(-60);
    const sum = summariseTurns(ts);
    return {
      accountId: id, msisdn: a?.msisdn || a?.waId || null, displayName: a?.displayName || null, state: a?.onboardingState || null, flowState: a?.conversationState || null,
      source: a?.profile?.acquisitionSource || 'organic', joinedAt: a?.createdAt || null,
      turnsInWindow: Number((heads.find((h) => h.accountId === id) || {}).n || 0),
      ...sum,
    };
  });
  return res.status(200).json({ days, items });
}
