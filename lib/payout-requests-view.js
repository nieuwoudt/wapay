/**
 * The pay-out requests Mission Control and the internal review route show (founder 2026-10-24): the
 * audit rows lib/payouts.js writes for every request (event PAYOUT_REQUEST), newest first, with the
 * masked phone, the name, whether the account is frozen, the fraud level and its reasons, and the result.
 */
import { LEVEL_LABEL } from './payout-triage.js';
import { readPayoutHold } from './payout-hold.js';

export const REASON_SHORT = {
  NEW_TODAY: 'opened today', NEW_WEEK: 'new this week', NEW_MONTH: 'new this month', ID_CHECKED: 'ID checked',
  FRESH_MONEY: 'money under 2 h old', OWN_CARD: 'paid own link by card', CARD_BURST: 'many card payments',
  PAYER_MANY: 'payer paid other accounts', FROZEN_LINK: 'money with a frozen account', FROZEN_PAYER: 'paid by a frozen account',
  FROZEN_DESTINATION: 'same destination as a frozen account', SHARED_DESTINATION: 'destination shared with others',
  CASH_OTHER_PHONE: 'cash to another phone', FIRST_ALL: 'first pay-out, takes all', MANY_ATTEMPTS: 'many attempts', FOREIGN_PAYER: 'paid from abroad',
};

export async function payoutRequestsView({ prisma, days = 7, now = Date.now() }) {
  const since = new Date(now - Math.min(30, Math.max(1, Number(days) || 7)) * 24 * 3600 * 1000);
  const rows = await prisma.auditLog.findMany({ where: { event: 'PAYOUT_REQUEST', timestamp: { gte: since } }, orderBy: { timestamp: 'desc' }, take: 100, select: { accountId: true, timestamp: true, metadata: true } });
  const ids = [...new Set(rows.map((r) => r.accountId))];
  const accounts = ids.length ? await prisma.account.findMany({ where: { id: { in: ids } }, select: { id: true, waId: true, displayName: true, profile: true } }) : [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const hold = await readPayoutHold({ prisma }).catch(() => null);
  const requests = rows.map((r) => {
    const a = byId.get(r.accountId);
    const m = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
    return {
      at: r.timestamp,
      accountId: r.accountId,
      phone: a?.waId ? `•••${String(a.waId).slice(-4)}` : null,
      name: a?.profile?.kyc?.fullName || a?.displayName || null,
      frozen: a?.profile?.payouts?.frozen === true,
      level: m.level ?? null,
      label: LEVEL_LABEL[m.level] || null,
      reasons: (m.reasons || []).filter((c) => c !== 'ID_CHECKED').map((c) => REASON_SHORT[c] || c),
      amountCents: m.amountCents ?? null,
      method: m.method || null,
      feeCents: m.feeCents ?? null,
      express: !!m.express,
      outcome: m.outcome || null,
      cleared: !!m.cleared,
    };
  });
  const byLevel = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const q of requests) if (byLevel[q.level] != null) byLevel[q.level] += 1;
  return { hold: hold ? { held: hold.held, since: hold.since } : null, requests, byLevel };
}
