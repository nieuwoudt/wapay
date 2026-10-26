/**
 * Pay-out fraud triage (founder 2026-10-24, after the stolen-card cash-out of BUGLOG #140): "keep me
 * updated whenever someone requests a payout ... build in flags for fraud, levels of triage 1-5 of how
 * likely it is fraud, so that we can pick up these types of transactions faster".
 *
 * Every pay-out request that reaches requestPayout is scored from what the database already knows, gets
 * a level from 1 (looks genuine) to 5 (looks like fraud) with the reasons in plain words, is written to
 * the audit log (event PAYOUT_REQUEST, read by Mission Control) and is sent to the ops numbers on
 * WhatsApp with an e-mail twin. A request at or above WAPAY_PAYOUT_REVIEW_LEVEL (4; "off" disables) waits
 * for a person: requestPayout refuses it with REVIEW before any row, cent, hold or rail call, and the
 * customer is told a person checks it first. The founder clears an account for a while
 * (POST /api/internal/payout-review { decision: 'clear' }) or freezes it ({ decision: 'freeze' }).
 *
 * The signals, each from rows WaPay already keeps (calibrated on the 22 October burst: every burst account
 * replayed at each frozen account's first pay-out, 16 of 21 scored 4 or 5, so review starts at level 4; a new
 * customer paid once by a friend who withdraws within two hours also scores 4 and waits for a quick check):
 *   account age, ID check, money under two hours old, links paid with the account's own number, card
 *   payments in 24 hours, a payer who also paid other accounts, money moved with a frozen account, a
 *   payer who is a frozen account, a pay-out destination shared with other accounts or with a frozen one,
 *   a cash code going to another person's phone, a first pay-out that takes nearly everything, repeated
 *   attempts. Destinations are compared by a keyed hash (destinationKey) written on every pay-out row from
 *   2026-10-24, never by the number itself. Every read is best effort: a failed read adds nothing.
 *
 * Golden thread: nothing here is sent to a model. The alert carries the masked phone, the level and the
 * reasons, never an ID number, a bank account number or a payer's number.
 */
import crypto from 'node:crypto';
import prismaDefault from './prisma.js';
import { ACCT, BALANCE } from './ledger-core.js';
import { mergeProfileSubkeyAtomic } from './profile-merge.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const PAYOUT_REVIEW_COPY = '🔎 This pay-out needs a check by a person at WaPay before it can go. Your money is safe in your WaPay balance and nothing has left it. Please try again later.';
export const LEVEL_LABEL = { 1: 'very unlikely', 2: 'unlikely', 3: 'possible', 4: 'likely', 5: 'very likely' };
export const LEVEL_DOT = { 1: '🟢', 2: '🟢', 3: '🟡', 4: '🟠', 5: '🔴' };

const last9 = (n) => String(n || '').replace(/\D/g, '').slice(-9);
const BANK_METHODS = new Set(['PAYSHAP', 'RTC']);

/** The review level (WAPAY_PAYOUT_REVIEW_LEVEL, default 4 after the 22 October replay); null when switched off. */
export function reviewLevel(env = process.env) {
  const raw = String(env.WAPAY_PAYOUT_REVIEW_LEVEL ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === '0') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 4;
}

/** A keyed hash of where the money goes (bank account or cellphone), comparable across accounts. */
export function destinationKey(method, recipient, env = process.env) {
  const family = BANK_METHODS.has(method) ? 'BANK' : 'CASH';
  const number = String((family === 'BANK' ? recipient?.account_number : recipient?.mobile) || '').replace(/\D/g, '');
  if (number.length < 6) return null;
  const secret = String(env.WAPAY_PAYOUT_FINGERPRINT_SECRET || env.WAPAY_PIN_PROOF_SECRET || 'wapay-destination-key');
  return crypto.createHmac('sha256', secret).update(`${family}|${family === 'CASH' ? last9(number) : number}`).digest('hex').slice(0, 32);
}

/** Score to level: 0 or less is 1, then 1-2, 3-4, 5-6, 7 and up. */
export function levelOf(score) {
  if (score >= 7) return 5;
  if (score >= 5) return 4;
  if (score >= 3) return 3;
  if (score >= 1) return 2;
  return 1;
}

async function safe(promise, fallback) {
  try { return await promise; } catch { return fallback; }
}

/**
 * The triage for one pay-out request. `express` is the express-fee decision (lib/payout-express.js) when
 * the caller has it; `recipient` the cleaned recipient (for the destination and the cash phone checks).
 * Returns { level, score, reasons: [{ code, points, text }], facts, destKey }.
 */
export async function payoutTriage({ prisma = prismaDefault, account, amountCents = 0, method = null, recipient = null, express = null, feeCents = null, now = Date.now(), env = process.env }) {
  const reasons = [];
  const add = (code, points, text) => reasons.push({ code, points, text });
  const id = account?.id;
  const row = id ? await safe(prisma.account.findUnique({ where: { id }, select: { createdAt: true, profile: true, waId: true, msisdn: true } }), null) : null;
  const createdAt = new Date(row?.createdAt || account?.createdAt || now).getTime();
  const profile = row?.profile || account?.profile || {};
  const own9 = last9(row?.waId || account?.waId || row?.msisdn || account?.msisdn);
  const ageHours = (now - createdAt) / 3600000;
  const verified = profile?.kyc?.status === 'VERIFIED';
  const facts = { ageHours: Math.round(ageHours), verified };

  if (ageHours < 24) add('NEW_TODAY', 3, 'account opened in the last 24 hours');
  else if (ageHours < 7 * 24) add('NEW_WEEK', 2, `account ${Math.floor(ageHours / 24)} days old`);
  else if (ageHours < 30 * 24) add('NEW_MONTH', 1, `account ${Math.floor(ageHours / 24)} days old`);
  if (verified) add('ID_CHECKED', -3, 'ID checked');
  if (express?.express) add('FRESH_MONEY', 2, 'pays out money that arrived under 2 hours ago');

  // Links paid into this account in the last 7 days, and who paid them.
  const paid = id ? await safe(prisma.paymentRequest.findMany({ where: { accountId: id, status: 'PAID', paidAt: { gte: new Date(now - 7 * DAY_MS), lte: new Date(now) } }, select: { id: true, payerRef: true, paidAt: true, amountCents: true } }), []) : [];
  const cardPaid = (paid || []).filter((p) => !String(p.payerRef || '').startsWith('WAPAY:'));
  // The card rails stamp the payer's number on the pay intent (route 'payrequest', metadata.requestCode).
  const intents = cardPaid.length ? await safe(prisma.providerRequest.findMany({ where: { route: 'payrequest', accountId: id, requestTs: { gte: new Date(now - 8 * DAY_MS), lte: new Date(now) } }, select: { id: true, metadata: true } }), []) : [];
  const codeOf = (i) => String(i?.metadata?.requestCode || String(i?.id || '').replace(/^pfreq-/i, '')).toUpperCase();
  const payerByCode = new Map((intents || []).filter((i) => i?.metadata?.payerMsisdn).map((i) => [codeOf(i), last9(i.metadata.payerMsisdn)]));
  for (const k of [...payerByCode.keys()]) if (!cardPaid.some((p) => String(p.id).toUpperCase() === k)) payerByCode.delete(k);
  const selfPaid = cardPaid.filter((p) => own9 && payerByCode.get(String(p.id).toUpperCase()) === own9).length;
  const card24 = cardPaid.filter((p) => new Date(p.paidAt).getTime() >= now - DAY_MS).length;
  facts.cardPayments7d = cardPaid.length;
  facts.cardPayments24h = card24;
  if (selfPaid > 0) add('OWN_CARD', 3, `paid ${selfPaid === 1 ? 'one of its own links' : `${selfPaid} of its own links`} by card with its own number`);
  if (card24 >= 5) add('CARD_BURST', 2, `${card24} card payments in 24 hours`);
  else if (card24 >= 3) add('CARD_BURST', 1, `${card24} card payments in 24 hours`);

  // Where the payers paid from (lib/link-visits.js, 2026-10-25): a checkout from outside South Africa.
  const abroad = id && typeof prisma?.linkVisit?.findMany === 'function' ? await safe(prisma.linkVisit.findMany({ where: { kind: 'CHECKOUT', accountId: id, createdAt: { gte: new Date(now - 7 * DAY_MS), lte: new Date(now) }, country: { not: null, notIn: ['ZA'] } }, select: { country: true } }), []) : [];
  if ((abroad || []).length) add('FOREIGN_PAYER', 2, `a payer pressed pay from outside South Africa (${[...new Set(abroad.map((a) => a.country))].slice(0, 3).join(', ')})`);

  // A payer who also paid other accounts this week (one number paying many new accounts was the burst).
  const payers = [...new Set([...payerByCode.values()].filter((n) => n && n !== own9))].slice(0, 10);
  if (payers.length) {
    const others = await safe(prisma.providerRequest.findMany({
      where: { route: 'payrequest', status: 'SUCCESS', requestTs: { gte: new Date(now - 7 * DAY_MS), lte: new Date(now) }, NOT: { accountId: id }, OR: payers.flatMap((n) => [{ metadata: { path: ['payerMsisdn'], equals: `0${n}` } }, { metadata: { path: ['payerMsisdn'], equals: `27${n}` } }]) },
      select: { accountId: true },
    }), []);
    const distinct = new Set((others || []).map((o) => o.accountId).filter(Boolean)).size;
    facts.payerOtherAccounts = distinct;
    if (distinct >= 2) add('PAYER_MANY', 2, `a payer of this account also paid ${distinct} other accounts this week`);
  }

  // Frozen accounts: money moved with one, paid by one, or the same destination as one.
  const frozen = await safe(prisma.account.findMany({ where: { profile: { path: ['payouts', 'frozen'], equals: true } }, select: { id: true, waId: true } }), []);
  const frozenIds = new Set((frozen || []).map((f) => f.id).filter((f) => f !== id));
  const frozen9 = new Set((frozen || []).filter((f) => f.id !== id).map((f) => last9(f.waId)).filter(Boolean));
  if (frozenIds.size && id) {
    const sends = await safe(prisma.journalEntry.findMany({
      where: { source: 'P2P_SEND', createdAt: { gte: new Date(now - 30 * DAY_MS), lte: new Date(now) }, lines: { some: { accountCode: { in: [ACCT.wallet(id, BALANCE.SPEND), ACCT.wallet(id, BALANCE.CASH)] } } } },
      select: { lines: { select: { accountCode: true } } },
    }), []);
    const touched = (sends || []).some((e) => (e.lines || []).some((l) => frozenIds.has(String(l.accountCode).split(':')[1])));
    if (touched) add('FROZEN_LINK', 4, 'moved money with a frozen account');
    if ([...payerByCode.values()].some((n) => n && frozen9.has(n))) add('FROZEN_PAYER', 4, 'paid by the number of a frozen account');
  }
  const destKey = recipient && method ? destinationKey(method, recipient, env) : null;
  if (destKey) {
    const same = await safe(prisma.providerRequest.findMany({
      where: { route: 'ott-payout', requestTs: { gte: new Date(now - 90 * DAY_MS), lte: new Date(now) }, NOT: { accountId: id }, metadata: { path: ['destKey'], equals: destKey } },
      select: { accountId: true },
    }), []);
    const sharedIds = new Set((same || []).map((s) => s.accountId).filter(Boolean));
    facts.sharedDestination = sharedIds.size;
    if ([...sharedIds].some((a) => frozenIds.has(a))) add('FROZEN_DESTINATION', 7, 'pays out to the same bank account or phone as a frozen account');
    else if (sharedIds.size) add('SHARED_DESTINATION', 3, `pays out to the same bank account or phone as ${sharedIds.size} other account${sharedIds.size === 1 ? '' : 's'}`);
  }
  if (method && !BANK_METHODS.has(method) && recipient?.mobile && own9 && last9(recipient.mobile) !== own9) add('CASH_OTHER_PHONE', 1, 'the cash code goes to another person\'s phone');

  // Earlier pay-outs: a first one that takes nearly everything, or many tries in a day.
  const history = id ? await safe(prisma.providerRequest.findMany({ where: { accountId: id, route: 'ott-payout', requestTs: { gte: new Date(now - 90 * DAY_MS), lt: new Date(now) } }, select: { status: true, requestTs: true } }), []) : [];
  const paidBefore = (history || []).filter((h) => h.status === 'SUCCESS').length;
  const tries24 = (history || []).filter((h) => new Date(h.requestTs).getTime() >= now - DAY_MS).length;
  facts.paidOutBefore = paidBefore;
  const wallets = id ? await safe(prisma.wallet.findMany({ where: { accountId: id }, select: { availableCents: true } }), []) : [];
  const balance = (wallets || []).reduce((s, w) => s + (Number(w.availableCents) || 0), 0);
  facts.balanceCents = balance;
  const total = (Number(amountCents) || 0) + (Number(feeCents) || 0);
  if (paidBefore === 0 && balance > 0 && total >= 0.9 * balance) add('FIRST_ALL', 1, 'first pay-out, takes nearly the whole balance');
  if (tries24 >= 4) add('MANY_ATTEMPTS', 1, `${tries24} pay-out attempts in 24 hours`);

  const score = reasons.reduce((s, r) => s + r.points, 0);
  let level = levelOf(score);
  if (reasons.some((r) => r.code === 'FROZEN_DESTINATION')) level = 5;
  else if (reasons.some((r) => r.code === 'FROZEN_LINK' || r.code === 'FROZEN_PAYER')) level = Math.max(level, 4);
  const cleared = clearanceOf(profile, now);
  return { level, score, reasons: reasons.sort((a, b) => b.points - a.points), facts, destKey, cleared };
}

/** The founder's clearance on this profile, if it still runs: { until, by } or null. */
export function clearanceOf(profile, now = Date.now()) {
  const until = profile?.payouts?.clearedUntil ? new Date(profile.payouts.clearedUntil).getTime() : 0;
  return until > now ? { until: new Date(until).toISOString(), by: profile.payouts.clearedBy || null } : null;
}

/** Whether this request waits for a person: at or above the review level and not cleared. */
export function reviewNeeded({ triage, env = process.env }) {
  const at = reviewLevel(env);
  return !!(triage && at != null && triage.level >= at && !triage.cleared);
}

/** Clears an account's pay-outs past the review for `hours` (the founder's word), or ends a clearance. */
export async function setPayoutClearance({ prisma = prismaDefault, accountId, hours = 72, by = 'ops', reason = null, now = new Date() }) {
  const idStr = String(accountId || '').trim();
  if (!/^[a-z0-9]{20,40}$/i.test(idStr)) return { ok: false, error: 'BAD_ACCOUNT' };
  const h = Math.max(0, Math.min(24 * 30, Number(hours) || 0));
  const patch = h > 0
    ? { clearedUntil: new Date(now.getTime() + h * 3600000).toISOString(), clearedBy: String(by).slice(0, 40), clearedReason: reason ? String(reason).slice(0, 200) : null, clearedAt: now.toISOString() }
    : { clearedUntil: null, clearedBy: String(by).slice(0, 40), clearedReason: reason ? String(reason).slice(0, 200) : null, clearedAt: now.toISOString() };
  const ok = await mergeProfileSubkeyAtomic({ prisma, accountId: idStr, key: 'payouts', patch });
  return ok ? { ok: true, accountId: idStr, clearedUntil: patch.clearedUntil } : { ok: false, error: 'NO_ACCOUNT' };
}

const R = (c) => `R${(Number(c || 0) / 100).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).replace(/ | /g, ',')}`;
const METHOD = { PAYSHAP: 'PayShap', RTC: 'bank transfer', CASHSEND: 'Absa cash', NEDCASH: 'Nedbank cash', EWALLET: 'FNB eWallet' };

/** What happened to the request, in a few words for the alert. */
export function outcomeLabel(out) {
  if (out?.ok && out.status === 'SETTLED') return 'paid';
  if (out?.ok && out.status === 'PENDING') return 'with the bank rail';
  const e = out?.error || out?.status || 'FAILED';
  return {
    REVIEW: 'HELD for your check, nothing sent',
    AWAITING_APPROVAL: 'WAITING FOR YOUR APPROVAL, money set aside, nothing sent',
    TEST_RUN: 'test run for a test number, nothing sent',
    FROZEN: 'refused, the account is frozen',
    PAYOUT_HOLD: 'refused, pay-outs are paused',
    DAILY_CAP: 'refused, over the daily cap',
    KYC_REQUIRED: 'refused, needs the ID check',
    FEE_CHANGED: 'stopped, the fee went up after the confirmation',
    INSUFFICIENT_FUNDS: 'refused, not enough balance',
    FLOAT_SHORT: 'refused, the pay-out float is empty',
    NOT_AUTHORISED: 'refused, no valid PIN',
  }[e] || `failed (${e})`;
}

/** The one WhatsApp line (and e-mail body) for a pay-out request. */
export function payoutRequestAlertText({ triage, account, amountCents, method, feeCents = null, express = false, out, approveUrl = null }) {
  const phone = String(account?.waId || account?.msisdn || '').replace(/\D/g, '');
  const name = account?.profile?.kyc?.fullName || account?.displayName || null;
  const level = triage?.level || null;
  const head = level ? `${LEVEL_DOT[level]} Pay-out request, fraud level ${level}/5 (${LEVEL_LABEL[level]})` : '💸 Pay-out request (not scored)';
  const fee = Number.isInteger(feeCents) ? ` · fee ${R(feeCents)}${express ? ' (double, money under 2 h old)' : ''}` : '';
  const who = `Account •••${phone.slice(-4) || '????'}${name ? ` ${String(name).slice(0, 30)}` : ''}${triage?.facts ? ` · ${triage.facts.verified ? 'ID checked' : 'ID not checked'}` : ''}`;
  const why = triage?.reasons?.filter((r) => r.points > 0).slice(0, 4).map((r) => r.text);
  return [
    head,
    `${R(amountCents)} by ${METHOD[method] || method || 'pay-out'}${fee}`,
    who,
    why?.length ? `Why: ${why.join('; ')}` : 'Why: nothing unusual',
    `Result: ${outcomeLabel(out)}${triage?.cleared ? ' (cleared by the founder)' : ''}`,
    approveUrl ? `Approve or reject: ${approveUrl}` : level >= 4 ? `To act: clear or freeze account ${account?.id || ''}` : null,
  ].filter(Boolean).join('\n');
}
