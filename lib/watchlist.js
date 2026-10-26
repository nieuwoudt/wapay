/**
 * Numbers we should be watching (founder 2026-10-26: "flag those numbers for me in the dashboard: numbers we
 * should be watching"). Computed from WaPay's own rows over the last 30 days, never typed in by hand:
 *
 *   frozen         the accounts frozen after the stolen-card cash-out (profile.payouts.frozen)
 *   accounts       not frozen, but tied to the fraud: money moved with a frozen account (sends and links paid from
 *                  a balance), their links pressed-pay or opened from outside South Africa, a link paid with their
 *                  own number by card, a pay-out destination shared with a frozen account, a pay-out request the
 *                  triage scored 4 or 5, repeated withdrawal attempts during the pause
 *   payers         payer numbers (not accounts) that paid frozen accounts' links by card, or paid three or more
 *                  different accounts in a week
 *
 * Masked numbers only (last four digits); the customer card in Mission Control has the rest. Nothing here is sent
 * to a model.
 */
import prismaDefault from './prisma.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const last9 = (n) => String(n || '').replace(/\D/g, '').slice(-9);
const mask = (n) => (n ? `•••${String(n).replace(/\D/g, '').slice(-4)}` : null);
export const WATCH_REASONS = {
  FROZEN_MONEY: 'money moved with a frozen account',
  ABROAD_CHECKOUT: 'pay pressed on their link from outside South Africa',
  ABROAD_OPEN: 'their link opened from outside South Africa',
  OWN_CARD: 'paid their own link by card',
  FROZEN_DESTINATION: 'same pay-out destination as a frozen account',
  HIGH_TRIAGE: 'a pay-out request scored 4 or 5',
  PAUSE_TRIES: 'tried to withdraw 3 or more times during the pause',
};
const WEIGHT = { FROZEN_MONEY: 5, FROZEN_DESTINATION: 5, ABROAD_CHECKOUT: 3, OWN_CARD: 3, HIGH_TRIAGE: 3, ABROAD_OPEN: 1, PAUSE_TRIES: 1 };

async function safe(p, fallback) { try { return await p; } catch { return fallback; } }

export async function watchlist({ prisma = prismaDefault, now = Date.now(), days = 30, env = process.env } = {}) {
  // The founder's own numbers (the ops alert recipients) and the test numbers are never watched.
  const own = new Set(`${env.WAPAY_OPS_ALERT_MSISDNS || ''},${env.WAPAY_PAYOUT_TEST_NUMBERS || ''}`.split(',').map(last9).filter((n) => n.length === 9));
  const since = new Date(now - days * DAY_MS);
  const frozenRows = await safe(prisma.account.findMany({ where: { profile: { path: ['payouts', 'frozen'], equals: true } }, select: { id: true, waId: true, displayName: true, createdAt: true, profile: true } }), []);
  const frozenIds = new Set(frozenRows.map((a) => a.id));
  const frozen9 = new Set(frozenRows.map((a) => last9(a.waId)).filter(Boolean));
  const reasons = new Map(); // accountId -> Map(code -> detail)
  const flag = (id, code, detail = null) => { if (!id || frozenIds.has(id)) return; const m = reasons.get(id) || new Map(); if (!m.has(code)) m.set(code, detail); reasons.set(id, m); };

  // 1. Money moved with a frozen account: P2P entries (sends and links paid from a balance) with a frozen wallet on one side.
  if (frozenIds.size) {
    const wallets = [...frozenIds].flatMap((id) => [`WALLET:${id}:SPEND`, `WALLET:${id}:CASH`]);
    const entries = await safe(prisma.journalEntry.findMany({ where: { source: 'P2P_SEND', createdAt: { gte: since }, lines: { some: { accountCode: { in: wallets } } } }, select: { lines: { select: { accountCode: true, debitCents: true, creditCents: true } } } }), []);
    for (const e of entries) {
      const ids = (e.lines || []).filter((l) => /^WALLET:/.test(l.accountCode)).map((l) => l.accountCode.split(':')[1]);
      const cents = Math.max(0, ...(e.lines || []).map((l) => Number(l.creditCents) || 0));
      for (const id of ids) if (!frozenIds.has(id)) flag(id, 'FROZEN_MONEY', cents);
    }
  }
  // 2. Their links pressed-pay or opened from outside South Africa.
  const abroad = await safe(prisma.linkVisit.findMany({ where: { createdAt: { gte: since }, kind: { in: ['OPEN', 'CHECKOUT'] }, country: { not: null, notIn: ['ZA'] } }, select: { accountId: true, kind: true, country: true } }), []);
  for (const v of abroad) flag(v.accountId, v.kind === 'CHECKOUT' ? 'ABROAD_CHECKOUT' : 'ABROAD_OPEN', v.country);
  // 3. Links paid by card: their own number, and payer numbers worth watching.
  const intents = await safe(prisma.providerRequest.findMany({ where: { route: 'payrequest', status: 'SUCCESS', requestTs: { gte: since } }, select: { accountId: true, metadata: true } }), []);
  const ownerNumber = new Map((await safe(prisma.account.findMany({ where: { id: { in: [...new Set(intents.map((i) => i.accountId).filter(Boolean))] } }, select: { id: true, waId: true } }), [])).map((a) => [a.id, last9(a.waId)]));
  const payerStats = new Map(); // payer9 -> { accounts:Set, frozenPaid, cents }
  for (const i of intents) {
    const payer = last9(i.metadata?.payerMsisdn);
    if (!payer || !i.accountId) continue;
    if (payer === ownerNumber.get(i.accountId)) flag(i.accountId, 'OWN_CARD');
    const s = payerStats.get(payer) || { accounts: new Set(), frozenPaid: 0, cents: 0 };
    s.accounts.add(i.accountId);
    if (frozenIds.has(i.accountId)) s.frozenPaid += 1;
    s.cents += Number(i.metadata?.amountCents) || 0;
    payerStats.set(payer, s);
  }
  // 4. A pay-out destination shared with a frozen account (destKey on every pay-out row since 2026-10-24).
  const payoutRows = await safe(prisma.providerRequest.findMany({ where: { route: 'ott-payout', requestTs: { gte: new Date(now - 90 * DAY_MS) } }, select: { accountId: true, metadata: true } }), []);
  const frozenKeys = new Set(payoutRows.filter((r) => frozenIds.has(r.accountId) && r.metadata?.destKey).map((r) => r.metadata.destKey));
  for (const r of payoutRows) if (r.metadata?.destKey && frozenKeys.has(r.metadata.destKey)) flag(r.accountId, 'FROZEN_DESTINATION');
  // 5. A pay-out request the triage scored 4 or 5.
  const requests = await safe(prisma.auditLog.findMany({ where: { event: 'PAYOUT_REQUEST', timestamp: { gte: since } }, select: { accountId: true, metadata: true } }), []);
  for (const r of requests) if (Number(r.metadata?.level) >= 4) flag(r.accountId, 'HIGH_TRIAGE', r.metadata.level);
  // 6. Three or more withdrawal attempts that met the pause.
  const tries = await safe(prisma.conversationTurn.findMany({ where: { role: 'assistant', createdAt: { gte: since }, text: { contains: 'Pay-outs are paused' } }, select: { accountId: true } }), []);
  const tryCount = new Map(); for (const t of tries) tryCount.set(t.accountId, (tryCount.get(t.accountId) || 0) + 1);
  for (const [id, n] of tryCount) if (n >= 3) flag(id, 'PAUSE_TRIES', n);

  // The accounts, with what they hold.
  let ids = [...reasons.keys()];
  const [accounts, wallets] = await Promise.all([
    safe(prisma.account.findMany({ where: { id: { in: ids } }, select: { id: true, waId: true, displayName: true, createdAt: true, profile: true } }), []),
    safe(prisma.wallet.findMany({ where: { accountId: { in: [...ids, ...frozenIds] } }, select: { accountId: true, availableCents: true, pendingCents: true } }), []),
  ]);
  const held = new Map(); for (const w of wallets) held.set(w.accountId, (held.get(w.accountId) || 0) + (Number(w.availableCents) || 0) + (Number(w.pendingCents) || 0));
  const byId = new Map(accounts.map((a) => [a.id, a]));
  ids = ids.filter((id) => !own.has(last9(byId.get(id)?.waId)));
  const watched = ids.map((id) => {
    const a = byId.get(id);
    const r = reasons.get(id);
    const score = [...r.keys()].reduce((s, c) => s + (WEIGHT[c] || 1), 0);
    return {
      accountId: id,
      phone: mask(a?.waId),
      name: a?.profile?.kyc?.fullName || a?.displayName || null,
      openedAt: a?.createdAt || null,
      idChecked: a?.profile?.kyc?.status === 'VERIFIED',
      balanceCents: held.get(id) || 0,
      score,
      reasons: [...r.entries()].map(([code, detail]) => ({ code, text: WATCH_REASONS[code] + (code.startsWith('ABROAD') && detail ? ` (${detail})` : '') })),
    };
  }).sort((x, y) => y.score - x.score || y.balanceCents - x.balanceCents);
  const payers = [...payerStats.entries()]
    .filter(([n, s]) => !own.has(n) && (s.frozenPaid > 0 || s.accounts.size >= 3 || frozen9.has(n)))
    .map(([n, s]) => ({ number: mask(n), paidAccounts: s.accounts.size, paidFrozenAccounts: s.frozenPaid, totalCents: s.cents, isFrozenAccount: frozen9.has(n) }))
    .sort((x, y) => y.paidFrozenAccounts - x.paidFrozenAccounts || y.paidAccounts - x.paidAccounts);
  const frozenList = frozenRows.map((a) => ({ accountId: a.id, phone: mask(a.waId), name: a.profile?.kyc?.fullName || a.displayName || null, openedAt: a.createdAt, frozenAt: a.profile?.payouts?.at || null, reason: a.profile?.payouts?.reason || null, balanceCents: held.get(a.id) || 0 }))
    .sort((x, y) => y.balanceCents - x.balanceCents);
  return { days, accounts: watched, payers, frozen: frozenList, frozenHeldCents: frozenList.reduce((s, f) => s + f.balanceCents, 0) };
}
