/**
 * One customer's money situation, in one read, for every gate and for the
 * agent (handover v2 §4, founder 2026-10-12). What failed for Lisa was not
 * vocabulary: no reply knew her situation. She had R0 to spend, a R350
 * voucher from the founder delivered that evening, and an unpaid R367 link,
 * and ten requests to "put it in my bank account" got the same minimum
 * line. A gate that cannot see this is a bug; this is what it reads.
 *
 *   {
 *     availableCents,     spendable now (SPEND + CASH available)
 *     heldCents,          held for something in flight (pending + holds)
 *     giftsReceived:      [{ id, amountCents, fromName, at, rail, inBalance }]  (last 30 days)
 *     pendingLinks:       [{ amountCents, grossCents, at, ageMinutes }]        unpaid deposit links (last 7 days)
 *     pendingPayouts:     [{ reference, amountCents, feeCents, method, at }]
 *     identity:           { kind: 'RSAID' | 'PASSPORT' | null, countryOfIssue }
 *     savedDestinations:  number
 *   }
 *
 * Read-only and best-effort per part: a part that cannot be read is empty,
 * never a throw into the chat. Amounts are integer cents; no number, PIN or
 * full cellphone ever leaves this module (the sender is named by display
 * name only).
 */
import prisma from './prisma.js';

const DAY = 24 * 60 * 60 * 1000;
/** Journal idemKeys that mean "this gift is in the recipient's balance" (the manual entry of 2026-10-12, and the claim-to-balance once it ships). */
export const GIFT_IN_BALANCE_PREFIXES = Object.freeze(['manual-gift-to-wallet-', 'gift-claim-balance-']);

const tail9 = (m) => String(m || '').replace(/\D/g, '').slice(-9);
const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };

export async function moneySituation({ prisma: db = prisma, account, now = new Date() } = {}) {
  const accountId = account?.id;
  const empty = { availableCents: 0, heldCents: 0, giftsReceived: [], pendingLinks: [], pendingPayouts: [], identity: { kind: null, countryOfIssue: null }, savedDestinations: 0 };
  if (!accountId) return empty;
  const nowMs = new Date(now).getTime();
  const [wallets, gifts, links, payouts, identity, saved] = await Promise.all([
    safe(() => db.wallet.findMany({ where: { accountId } }), []),
    safe(async () => {
      const t9 = tail9(account.msisdn || account.waId);
      if (t9.length < 9) return [];
      return db.pendingGift.findMany({ where: { recipientMsisdn: { endsWith: t9 }, status: { in: ['ISSUED', 'DELIVERED'] }, createdAt: { gte: new Date(nowMs - 30 * DAY) } }, orderBy: { createdAt: 'desc' }, take: 5 });
    }, []),
    safe(() => db.providerRequest.findMany({ where: { accountId, provider: 'PAYFAST', route: 'deposit', status: 'PENDING', requestTs: { gte: new Date(nowMs - 7 * DAY) } }, orderBy: { requestTs: 'desc' }, take: 3 }), []),
    safe(() => db.providerRequest.findMany({ where: { accountId, provider: 'OTT', route: 'ott-payout', status: 'PENDING' }, orderBy: { requestTs: 'desc' }, take: 3 }), []),
    safe(() => db.payoutIdentity.findUnique({ where: { accountId } }), null),
    safe(() => db.payoutDestination.count({ where: { accountId } }), 0),
  ]);

  const availableCents = (wallets || []).reduce((s, w) => s + (Number.isInteger(w.availableCents) ? w.availableCents : 0), 0);
  const heldCents = (wallets || []).reduce((s, w) => s + (Number.isInteger(w.pendingCents) ? w.pendingCents : 0), 0);

  // Who sent each gift (display name only) and whether it is already in the balance.
  const giftIds = (gifts || []).map((g) => g.id);
  const senderIds = [...new Set((gifts || []).map((g) => g.senderAccountId).filter(Boolean))];
  const [senders, moved] = await Promise.all([
    senderIds.length ? safe(() => db.account.findMany({ where: { id: { in: senderIds } }, select: { id: true, displayName: true } }), []) : [],
    giftIds.length ? safe(() => db.journalEntry.findMany({ where: { idemKey: { in: giftIds.flatMap((id) => GIFT_IN_BALANCE_PREFIXES.map((p) => `${p}${id}`)) } }, select: { idemKey: true } }), []) : [],
  ]);
  const nameOf = Object.fromEntries((senders || []).map((a) => [a.id, String(a.displayName || '').trim().split(/\s+/)[0] || null]));
  const movedKeys = new Set((moved || []).map((e) => e.idemKey));
  const giftsReceived = (gifts || []).map((g) => ({
    id: g.id,
    amountCents: g.amountCents,
    fromName: nameOf[g.senderAccountId] || null,
    at: g.deliveredAt || g.createdAt,
    rail: g.rail,
    inBalance: GIFT_IN_BALANCE_PREFIXES.some((p) => movedKeys.has(`${p}${g.id}`)),
  }));

  const pendingLinks = (links || []).map((r) => ({
    amountCents: Number.isInteger(r.metadata?.amountCents) ? r.metadata.amountCents : null,
    grossCents: Number.isInteger(r.metadata?.grossCents) ? r.metadata.grossCents : null,
    at: r.requestTs,
    ageMinutes: Math.max(0, Math.round((nowMs - new Date(r.requestTs).getTime()) / 60000)),
  }));
  const pendingPayouts = (payouts || []).map((r) => ({
    reference: r.metadata?.reference || null,
    amountCents: Number.isInteger(r.metadata?.amountCents) ? r.metadata.amountCents : null,
    feeCents: Number.isInteger(r.metadata?.feeCents) ? r.metadata.feeCents : null,
    method: r.metadata?.method || null,
    at: r.requestTs,
  }));

  return {
    availableCents,
    heldCents,
    giftsReceived,
    pendingLinks,
    pendingPayouts,
    identity: { kind: identity?.idType === 'PASSPORT' ? 'PASSPORT' : identity ? 'RSAID' : null, countryOfIssue: identity?.countryOfIssue || null },
    savedDestinations: Number.isInteger(saved) ? saved : 0,
  };
}

/** "on Saturday" / "today" / "yesterday" / "on 3 Oct", in SAST. Pure. */
export function whenSaid(at, now = new Date()) {
  const sast = (d) => new Date(new Date(d).getTime() + 2 * 60 * 60 * 1000);
  const a = sast(at); const n = sast(now);
  const day = (d) => Math.floor(d.getTime() / DAY);
  const diff = day(n) - day(a);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff < 7) return `on ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][a.getUTCDay()]}`;
  return `on ${a.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][a.getUTCMonth()]}`;
}

const R = (c) => `R${(c / 100).toFixed(2).replace(/\.00$/, '')}`;
/** A link younger than this may still be in flight at the payment page; older and unpaid means nobody paid it. */
export const UNPAID_LINK_AFTER_MINUTES = Number(process.env.WAPAY_DEPOSIT_UNPAID_AFTER_MINUTES ?? 15);

/**
 * Where the customer's money is, as plain sentences that lead with their
 * money (handover §4: "You have R0 to withdraw. The R350 Nieuwoudt sent you
 * is a voucher…", never a product fact first). One sentence per fact the
 * customer may not know; nothing when there is nothing to explain. No
 * partner is named. Pure.
 */
export function situationSentences(s, { now = new Date() } = {}) {
  const out = [];
  for (const g of (s?.giftsReceived || []).filter((x) => !x.inBalance).slice(0, 2)) {
    const who = g.fromName ? `${g.fromName} sent you` : 'you received';
    out.push(`The ${R(g.amountCents)} ${who} ${whenSaid(g.at, now)} came as a voucher PIN, not as money in your balance, so it cannot be withdrawn.`);
  }
  for (const g of (s?.giftsReceived || []).filter((x) => x.inBalance).slice(0, 1)) {
    if ((s?.availableCents || 0) > 0) out.push(`The ${R(g.amountCents)} ${g.fromName ? `from ${g.fromName}` : 'you received'} is in your balance.`);
  }
  for (const l of (s?.pendingLinks || []).slice(0, 1)) {
    const amt = l.grossCents || l.amountCents;
    if (!amt) continue;
    out.push(l.ageMinutes >= UNPAID_LINK_AFTER_MINUTES
      ? `Your ${R(amt)} payment link from ${whenSaid(l.at, now).replace(/^on /, '')} was not paid, so nothing came in from it and nothing was taken.`
      : `Your ${R(amt)} payment link has no payment yet.`);
  }
  for (const p of (s?.pendingPayouts || []).slice(0, 1)) {
    if (!Number.isInteger(p.amountCents)) continue;
    const total = p.amountCents + (Number.isInteger(p.feeCents) ? p.feeCents : 0);
    out.push(`${R(total)} is held for your ${R(p.amountCents)} withdrawal${p.reference ? ` (${p.reference})` : ''} until the bank confirms it; if it does not go through, it comes back to your balance.`);
  }
  return out;
}

/**
 * How many times the customer has recently been given this gate: assistant
 * turns carrying refs.gate === gate among the newest eight in the last
 * twelve hours. Other replies in between do not reset it: Lisa met the gate
 * seven times in eleven hours with a voucher purchase, a how-it-works answer
 * and a status check in between, and each time it was new to the code.
 * Language-proof: it reads the gate id the sender stored, never the
 * (localized) text. 0 = first time, 1 = second, 2 = third, 3+ = after that.
 * Best-effort: 0 on any error.
 */
export async function gateRepeatCount(args = {}) {
  return (await gateHistory(args)).count;
}

/**
 * gateRepeatCount plus whether any of those replies already brought in a
 * person (refs.personAsked, set only when the ops alert actually went), so a
 * later reply never claims a person was asked when nobody was.
 */
export async function gateHistory({ prisma: db = prisma, accountId, gate, now = new Date(), withinMs = 12 * 60 * 60 * 1000, lookback = 8 } = {}) {
  if (!accountId || !gate) return { count: 0, personAsked: false };
  const rows = await safe(() => db.conversationTurn.findMany({
    where: { accountId, role: 'assistant', createdAt: { gte: new Date(new Date(now).getTime() - withinMs) } },
    orderBy: { createdAt: 'desc' },
    take: lookback,
    select: { refs: true },
  }), []);
  const hits = (rows || []).filter((r) => r?.refs && typeof r.refs === 'object' && r.refs.gate === gate);
  return { count: hits.length, personAsked: hits.some((r) => r.refs.personAsked === true) };
}
