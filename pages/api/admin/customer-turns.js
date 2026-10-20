/**
 * GET /api/admin/customer-turns?id=<accountId>&limit=300   (admin session or internal key)
 *
 * One customer's conversation for Mission Control (founder 2026-10-19: "see the
 * support message history from and to a customer, and all the questions they
 * asked"). The text is what memory holds (PIN and code inputs are already
 * stored as [PIN]; names and amounts are the operator's to see). Flags tell the
 * operator what needs them: an unanswered last message, the withdraw gate's
 * tier, whether a person was asked, whether a person has replied.
 */
import prisma from '../../../lib/prisma.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { summariseTurns } from '../../../lib/inbox.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const id = String(req.query.id || '').trim();
  if (!/^[a-z0-9]{20,40}$/i.test(id)) return res.status(400).json({ error: 'BAD_ACCOUNT' });
  const limit = Math.min(1000, Math.max(20, Number(req.query.limit) || 300));
  const rows = await prisma.conversationTurn.findMany({ where: { accountId: id }, orderBy: { createdAt: 'desc' }, take: limit, select: { id: true, role: true, kind: true, text: true, createdAt: true, refs: true } });
  const turns = rows.reverse().map((t) => ({ id: t.id, at: t.createdAt, role: t.role, kind: t.kind, text: t.text, refs: t.refs || null }));
  return res.status(200).json({ accountId: id, turns, ...summariseTurns(turns) });
}
