/**
 * Referrals from the WaPay chat (founder, 2026-10-20). Source of truth: docs/REFERRALS.md.
 *
 * A member says "invite" and gets ONE forwardable message with their personal
 * link. The link opens WhatsApp to the WaPay number with a prefilled first
 * message that carries the member's code; when the friend sends it, the new
 * account is stamped with the referrer. Per member the data then shows how
 * many people wrote in with their code, how many opened an account, how many
 * were funded (first money in) and how many got paid (first paid link).
 *
 * Rewards are TRACKED now and PAID later: WAPAY_REFERRAL_REWARD_CENTS
 * (default 0 = track only). Above zero, the reward is credited to the
 * referrer's balance through the ledger exactly once per referred account at
 * the first qualifying event (first money in OR first paid link, whichever
 * comes first), from the referral expense account, and the referrer gets one
 * receipt at that moment.
 *
 * Rules kept here (do not weaken):
 * - WaPay never messages the invited person first. The friend writes in by
 *   tapping the link; everything they get is a reply. Nothing in this module
 *   sends to a number that has not written in.
 * - The inviter gets the invite message only when they ask, once per ask.
 *   No reminder, no nudge, no follow-up.
 * - Copy: no em dashes, none of the ad flow's banned words (lib/ad-flow.js
 *   copyViolations), no reward amount promised while the switch is 0, never
 *   a date. tests/referrals.test.mjs runs every string through the checker.
 * - Golden thread: a code is derived from the account id, never a phone
 *   number, and always carries letters, so it is never a run of digits; the
 *   prefilled message carries the code only, never the inviter's name; the
 *   friend is told who invited them by first name only, in WaPay's own reply,
 *   and conversation memory keeps "A friend" (recordAs in lib/say.js).
 * - Money: the reward is a ledger entry from EXPENSE:PROMO:REFERRAL to the
 *   referrer's balance (lib/ledger-core.js buildReferralReward through
 *   lib/ledger-post.js postEntry), idemKey referral-reward-<referredAccountId>.
 *   Exactly once per referred account; never a customer debit; nothing is
 *   paid for a milestone reached while the switch was 0.
 *
 * Everything that touches the database is best-effort and bounded: a
 * referral write must never slow or fail a customer's turn or a money flow.
 */

import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import prismaDefault from './prisma.js';
import { getProfile, updateProfile } from './user-profile.js';
import { mergeProfileSubkeyAtomic } from './profile-merge.js';
import { buildReferralReward, ACCT, BALANCE } from './ledger-core.js';
import { postEntry, ensureWallet } from './ledger-post.js';
import { notifyCustomer } from './notify.js';
import { firstNameFrom, rands } from './ad-flow.js';

const log = (type, data) => console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));

// ---------------------------------------------------------------------------
// Constants and the switch
// ---------------------------------------------------------------------------

/** No 0 and O, no 1, I and L: nothing a person can confuse when they read a code out. */
export const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const REFERRAL_CODE_LENGTH = 7;
/** The short domain the pay links already use (lib/payment-requests.js paymentRequestUrl). */
export const REFERRAL_LINK_BASE = 'https://pleasepayme.co.za/i';
/** The WaPay WhatsApp number the pay page deep-links to (pages/pay/[code].js WA_NUMBER). */
export const WAPAY_WA_NUMBER = '27760497624';
/** What a milestone WOULD earn while the switch is 0: the founder's R10, shown to the operator only. */
export const REFERRAL_NOTIONAL_REWARD_CENTS = 1000;
/** The ledger source of a reward entry; the stats read it back from the journal. */
export const REWARD_SOURCE = 'REFERRAL_REWARD';

/** WAPAY_REFERRAL_REWARD_CENTS as an integer; 0 (the default) means track only. */
export function rewardCents(env = process.env) {
  const n = Number.parseInt(String(env?.WAPAY_REFERRAL_REWARD_CENTS ?? '0'), 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function rewardsOn(env = process.env) {
  return rewardCents(env) > 0;
}

/** The rate the stats value a qualifying milestone at: the switch while on, else the notional R10. */
export function rewardRateCents(env = process.env) {
  return rewardCents(env) || REFERRAL_NOTIONAL_REWARD_CENTS;
}

export function rewardIdemKey(referredAccountId) {
  if (!referredAccountId || typeof referredAccountId !== 'string') throw new Error('referredAccountId is required');
  return `referral-reward-${referredAccountId}`;
}

// ---------------------------------------------------------------------------
// Codes: stable, short, from the account id. Pure.
// ---------------------------------------------------------------------------

/** Seven characters of the alphabet with at least two letters and one digit (so never a number). */
export function isWellFormedCode(code) {
  if (typeof code !== 'string' || code.length !== REFERRAL_CODE_LENGTH) return false;
  for (const ch of code) if (!REFERRAL_CODE_ALPHABET.includes(ch)) return false;
  const letters = (code.match(/[A-Z]/g) || []).length;
  const digits = (code.match(/[0-9]/g) || []).length;
  return letters >= 2 && digits >= 1;
}

/** Upper case, separators dropped; the caller checks isWellFormedCode. */
export function normaliseReferralCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Candidate n for an account (n = 0 is the code almost every account gets;
 * ensureReferralCode moves to n + 1 only when another account already holds
 * it). Deterministic: the same id always yields the same code.
 */
export function referralCodeFor(accountId, n = 0) {
  if (!accountId || typeof accountId !== 'string') throw new Error('accountId is required');
  for (let round = 0; round < 8; round += 1) {
    const digest = crypto.createHash('sha256').update(`wapay-referral:${accountId}:${n}:${round}`).digest();
    let symbols = '';
    for (const byte of digest) symbols += REFERRAL_CODE_ALPHABET[byte % REFERRAL_CODE_ALPHABET.length];
    for (let i = 0; i + REFERRAL_CODE_LENGTH <= symbols.length; i += 1) {
      const candidate = symbols.slice(i, i + REFERRAL_CODE_LENGTH);
      if (isWellFormedCode(candidate)) return candidate;
    }
  }
  throw new Error('no well-formed referral code'); // unreachable in practice
}

// ---------------------------------------------------------------------------
// The link, the prefilled message and the parse. Pure.
// ---------------------------------------------------------------------------

export function referralLink(code) {
  return `${REFERRAL_LINK_BASE}/${code}`;
}

/** The friend's first message. The code only: never the inviter's name (golden thread). */
export function prefilledInvite(code) {
  return `Hi WaPay! A friend invited me. Invite code: ${code}`;
}

/**
 * Where pleasepayme.co.za/i/<code> sends the browser: the wa.me deep link
 * with the prefilled message, plus UTM parameters so web analytics can see
 * the referral channel. The code in the message is what attributes.
 * @returns {{ code: string, location: string } | null} null when the code is malformed
 */
export function referralRedirect(rawCode) {
  const code = normaliseReferralCode(rawCode);
  if (!isWellFormedCode(code)) return null;
  const location =
    `https://wa.me/${WAPAY_WA_NUMBER}?text=${encodeURIComponent(prefilledInvite(code))}` +
    `&utm_source=referral&utm_medium=whatsapp&utm_content=${code}`;
  return { code, location };
}

const CODE_CLASS = `[${REFERRAL_CODE_ALPHABET}${REFERRAL_CODE_ALPHABET.toLowerCase()}]`;
const CODE_AFTER_WORD = new RegExp(`\\bcode\\b\\W{0,4}(${CODE_CLASS}{${REFERRAL_CODE_LENGTH}})(?![A-Za-z0-9])`, 'gi');

/**
 * The code in a first message, tolerant of the prefilled sentence being
 * edited: "Invite code: K7M2XQ4", "my code K7M2XQ4", or just the code in a
 * short message. Never a run of digits (a code carries letters), never an
 * eight-letter pay-request code, never a plain word (a code carries a digit).
 * @returns {string|null}
 */
export function parseReferralCode(text) {
  const t = String(text || '');
  if (!t.trim() || t.length > 400) return null;
  const candidates = [];
  for (const m of t.matchAll(CODE_AFTER_WORD)) candidates.push(m[1]);
  if (!candidates.length) {
    const words = t.trim().split(/\s+/);
    if (words.length <= 12) {
      for (const w of words) {
        const clean = w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
        if (clean.length === REFERRAL_CODE_LENGTH) candidates.push(clean);
      }
    }
  }
  for (const c of candidates) {
    const code = c.toUpperCase();
    if (isWellFormedCode(code)) return code;
  }
  return null;
}

/**
 * The customer asks in their own words (founder, 2026-10-20): "Create me a
 * referral link for a friend to share", "referral link", "invite link",
 * "invite a friend", "refer a friend", "share WaPay", "what is my referral
 * code", "invite". Case-insensitive, tolerant of "please", "can you", "me a",
 * "my" and anything around the ask. Never the friend's arrival sentence ("I
 * was invited", "Invite code: K7M2XQ4"): a message carrying a code is answered
 * by the first-contact hook before this, and "invited" is never an ask.
 */
export function matchInviteAsk(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.length > 160) return false;
  if (/\binvited\b/.test(t)) return false;
  if (parseReferralCode(t)) return false;
  // "referral link", "invite link", "my referral code", "an invite message", anywhere in the sentence.
  if (/\b(invite|invitation|invites|referral|referrals|refer) (link|links|code|codes|message|url)\b/.test(t)) return true;
  // "invite a friend", "refer my sister", "invite friends to wapay".
  if (/\b(invite|refer) (a |my |some |another |an? other |more )?(friend|friends|someone|somebody|people|family|sister|brother|mother|father|mom|dad|wife|husband|partner|colleague|colleagues|customer|customers|mate|mates|chommie|chommies|neighbour|neighbor|cousin|others)\b/.test(t)) return true;
  // "share wapay", "share wapay with my family", "wapay invite", "wapay referral link".
  if (/\bshare wapay\b|\bwapay (invite|invites|invitation|referral|referrals)( link| code)?\b/.test(t)) return true;
  // The bare word, with the politeness people add around it.
  const lead = "(?:please |can you |could you |can i |i want to |i'd like to |i would like to |i need |how do i |how can i |where is my |where's my |what is my |what's my |send me |give me |show me |create me |make me |get |me |a |an |my |the )*";
  if (new RegExp(`^${lead}(invite|invites|invitation|refer|referral|referrals)(?: please)?(?: now)?$`).test(t)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Copy (English; the processor localises). Every string here is checked by
// tests/referrals.test.mjs with lib/ad-flow.js copyViolations.
// ---------------------------------------------------------------------------

/** The forwardable part: what the friend reads. Only what works for everyone today. */
export const INVITE_PITCH = '💚 Join me on WaPay, the wallet in your WhatsApp. Get paid by anyone with a link, pay friends on WaPay for free and top up by card.';

/**
 * The ONE message the member gets when they ask. Forwardable as it is; the
 * reward line names an amount only while the switch is on, else it says the
 * invites are tracked, with no date.
 */
export function inviteMessage({ code, env = process.env } = {}) {
  if (!isWellFormedCode(code)) throw new Error('a well-formed code is required');
  const cents = rewardCents(env);
  const rewardLine = cents > 0
    ? `You get ${rands(cents)} in your balance when a friend you invited adds money or gets paid for the first time.`
    : 'We are tracking your invites; rewards are coming.';
  return `Here is your WaPay invite. Forward it to anyone you like 👇\n\n${INVITE_PITCH} Tap to start: ${referralLink(code)}\n\n${rewardLine}`;
}

/** The friend's first reply: who invited them, by first name only when the inviter shared one. */
export function referredWelcome({ inviterFirstName = null } = {}) {
  const who = inviterFirstName ? `${inviterFirstName} invited you to WaPay 💚` : 'A friend invited you to WaPay 💚';
  return `${who} Let's open your account. You only need this phone, and it's three quick steps.`;
}

/** A member who sends an invite code (their own, or a friend's): nothing to join. */
export const ALREADY_MEMBER_REPLY = 'You already have a WaPay account, so there is nothing to join 😊 Say *home* to see what you can do, or *invite* to get your own link to share.';

/** The one receipt the referrer gets when a reward lands. Names no one. */
export function rewardReceipt({ amountCents, balanceCents = null } = {}) {
  const lines = [`💚 Thank you for inviting a friend to WaPay. Your ${rands(amountCents)} reward is in your balance.`];
  if (Number.isInteger(balanceCents)) lines.push(`New balance: ${rands(balanceCents)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Data: the code on the profile, the stamp on the friend's account, the stats.
// ---------------------------------------------------------------------------

/** The account that holds this code (profile.referral.code), or null. */
export async function accountByReferralCode({ prisma = prismaDefault, code } = {}) {
  const c = normaliseReferralCode(code);
  if (!isWellFormedCode(c)) return null;
  return prisma.account.findFirst({
    where: { profile: { path: ['referral', 'code'], equals: c } },
    select: { id: true, waId: true, displayName: true, onboardingState: true, profile: true },
  });
}

/**
 * The member's code: the one already on their profile, else the first
 * deterministic candidate no other account holds, stored before it is handed
 * out. Only the invite command calls this; reads never issue a code.
 */
export async function ensureReferralCode({ prisma = prismaDefault, accountId, now = new Date() } = {}) {
  if (!accountId) throw new Error('accountId is required');
  const profile = await getProfile({ prisma, accountId });
  const existing = profile?.referral?.code;
  if (isWellFormedCode(existing)) return existing;
  for (let n = 0; n < 6; n += 1) {
    const candidate = referralCodeFor(accountId, n);
    const holder = await accountByReferralCode({ prisma, code: candidate });
    if (holder && holder.id !== accountId) continue; // taken: the next deterministic candidate
    const ok = await mergeProfileSubkeyAtomic({ prisma, accountId, key: 'referral', patch: { code: candidate, codeIssuedAt: now.toISOString() } });
    if (!ok) throw new Error('REFERRAL_CODE_WRITE_FAILED');
    return candidate;
  }
  throw new Error('REFERRAL_CODE_EXHAUSTED');
}

/**
 * First contact with a member's code: stamp where this account came from and
 * count the contact. Written on profile.attribution so the Growth tab's tree
 * and the stats read one place:
 *   referralCode, referredAt        always (first code wins; a second is ignored)
 *   referrerAccountId               when none is there yet (a pay-link referrer stays)
 *   source 'referral' + acquisitionSource 'referral'  when the account was organic
 * An ad click or a pay link that came first keeps its acquisition source; the
 * invite is still counted for the inviter.
 * @returns {Promise<{ ok: boolean, reason?: string, already?: boolean, referrerAccountId?: string|null, inviterFirstName?: string|null }>}
 */
export async function recordReferredContact({ prisma = prismaDefault, account, code, now = new Date() } = {}) {
  const c = normaliseReferralCode(code);
  if (!account?.id || !isWellFormedCode(c)) return { ok: false, reason: 'NO_CODE' };
  const referrer = await accountByReferralCode({ prisma, code: c });
  if (!referrer) return { ok: false, reason: 'UNKNOWN_CODE' };
  if (referrer.id === account.id) return { ok: false, reason: 'SELF' };
  const inviterFirstName = firstNameFrom(referrer.displayName);
  const profile = account.profile && typeof account.profile === 'object' ? account.profile : await getProfile({ prisma, accountId: account.id });
  const attr = profile?.attribution && typeof profile.attribution === 'object' ? profile.attribution : {};
  if (attr.referralCode) {
    return { ok: true, already: true, referrerAccountId: attr.referrerAccountId || null, inviterFirstName: attr.referralCode === c ? inviterFirstName : null };
  }
  const at = now.toISOString();
  const patch = { referralCode: c, referredAt: at };
  if (!attr.referrerAccountId) patch.referrerAccountId = referrer.id;
  const source = profile?.acquisitionSource;
  const organic = !source || source === 'organic';
  if (organic) {
    patch.source = 'referral';
    if (!attr.capturedAt) patch.capturedAt = at;
  }
  const merged = await mergeProfileSubkeyAtomic({ prisma, accountId: account.id, key: 'attribution', patch });
  if (!merged) return { ok: false, reason: 'WRITE_FAILED' };
  if (organic) await updateProfile({ prisma, accountId: account.id, patch: { acquisitionSource: 'referral' } });
  return { ok: true, already: false, referrerAccountId: patch.referrerAccountId || attr.referrerAccountId || null, inviterFirstName, acquisitionSource: organic ? 'referral' : source };
}

/**
 * For a set of accounts: when each first received money (any credit to its
 * balance except a referral reward) and when each first had a link paid.
 * @returns {Promise<{ funded: Map<string, Date>, paid: Map<string, Date> }>}
 */
export async function referredMilestones({ prisma = prismaDefault, accountIds = [] } = {}) {
  const funded = new Map();
  const paid = new Map();
  const ids = [...new Set(accountIds.filter((id) => typeof id === 'string' && id))];
  if (!ids.length) return { funded, paid };
  const codes = ids.map((id) => ACCT.wallet(id, BALANCE.SPEND));
  const credits = await prisma.$queryRaw`
    SELECT split_part(jl."accountCode", ':', 2) AS id, MIN(je."createdAt") AS at
    FROM "JournalLine" jl JOIN "JournalEntry" je ON je.id = jl."entryId"
    WHERE jl."accountCode" IN (${Prisma.join(codes)}) AND jl."creditCents" > 0 AND je.source <> ${REWARD_SOURCE}
    GROUP BY 1`;
  for (const r of Array.isArray(credits) ? credits : []) if (r?.id && r.at) funded.set(String(r.id), new Date(r.at));
  const requests = await prisma.paymentRequest.groupBy({
    by: ['accountId'],
    where: { accountId: { in: ids }, status: 'PAID' },
    _min: { paidAt: true },
  });
  for (const r of Array.isArray(requests) ? requests : []) if (r?.accountId) paid.set(String(r.accountId), r._min?.paidAt ? new Date(r._min.paidAt) : new Date(0));
  return { funded, paid };
}

/**
 * One member's referral numbers, read from the data (never from a claim):
 * invited = accounts that wrote in with the code; onboarded = of those,
 * onboarding complete; funded = first money in; paid = first paid link;
 * rewardEligibleCents = accounts with either milestone, at the reward rate
 * (the switch while on, else the notional R10); rewardPaidCents = what the
 * ledger has actually credited to this member as referral rewards.
 * Read-only: a member who never asked for an invite is shown the code the
 * command would issue, and nothing is written.
 */
export async function referralStats({ prisma = prismaDefault, accountId, env = process.env } = {}) {
  if (!accountId) throw new Error('accountId is required');
  const profile = await getProfile({ prisma, accountId });
  const stored = profile?.referral?.code;
  const issued = isWellFormedCode(stored);
  const code = issued ? stored : referralCodeFor(accountId);
  const rate = rewardRateCents(env);
  const base = { code, link: referralLink(code), issued, invited: 0, onboarded: 0, funded: 0, paid: 0, rewardEligibleCents: 0, rewardPaidCents: 0, rewardRateCents: rate, rewardsOn: rewardsOn(env) };
  const paidRows = await prisma.$queryRaw`
    SELECT COALESCE(SUM(jl."creditCents"), 0)::bigint AS cents
    FROM "JournalLine" jl JOIN "JournalEntry" je ON je.id = jl."entryId"
    WHERE jl."accountCode" = ${ACCT.wallet(accountId, BALANCE.SPEND)} AND je.source = ${REWARD_SOURCE}`;
  base.rewardPaidCents = Number(paidRows?.[0]?.cents || 0);
  if (!issued) return base; // no code was ever handed out: nobody can have written in with it
  const referred = await prisma.account.findMany({
    where: { profile: { path: ['attribution', 'referralCode'], equals: code } },
    select: { id: true, onboardingState: true },
  });
  const ids = referred.map((r) => r.id);
  const { funded, paid } = await referredMilestones({ prisma, accountIds: ids });
  const qualifying = new Set([...funded.keys(), ...paid.keys()]).size;
  return {
    ...base,
    invited: referred.length,
    onboarded: referred.filter((r) => r.onboardingState === 'S5_COMPLETED').length,
    funded: funded.size,
    paid: paid.size,
    rewardEligibleCents: qualifying * rate,
  };
}

// ---------------------------------------------------------------------------
// Milestones: the reward, exactly once, only while the switch is on.
// ---------------------------------------------------------------------------

async function readReferredAccount(prisma, accountId) {
  return prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true, waId: true, onboardingState: true, profile: true },
  });
}

async function sendRewardReceipt({ prisma, referrer, amountCents, deps }) {
  // A member who said stop is not written to for a transaction they did not start; the credit still lands.
  if (referrer?.profile?.messaging?.optOut) return { ok: false, skipped: 'OPTED_OUT' };
  if (!referrer?.waId) return { ok: false, skipped: 'NO_WA_ID' };
  let balanceCents = null;
  try {
    const wallet = await prisma.wallet.findFirst({ where: { accountId: referrer.id, balanceType: BALANCE.SPEND }, select: { availableCents: true } });
    if (wallet && Number.isInteger(wallet.availableCents)) balanceCents = wallet.availableCents;
  } catch {
    // The balance line is a nicety; the receipt matters more.
  }
  const notify = deps.notify || notifyCustomer;
  return notify({ to: referrer.waId, accountId: referrer.id, text: rewardReceipt({ amountCents, balanceCents }), kind: 'receipt' });
}

/**
 * The first qualifying event for a referred account. Marks the account
 * (attribution.referralQualifiedAt / referralQualifiedBy / referralRewardCents),
 * and while the switch is on credits the referrer once (the ledger idemKey
 * arbitrates any race) and sends the one receipt only when THIS call posted a
 * fresh entry. A milestone reached while the switch is 0 is recorded with
 * rewardCents 0 and is never paid later. Never throws.
 */
export async function qualifyReferral({ prisma = prismaDefault, referredAccountId, trigger, now = new Date(), env = process.env, deps = {} } = {}) {
  try {
    if (!referredAccountId) return { skipped: 'NO_ACCOUNT' };
    const referred = await readReferredAccount(prisma, referredAccountId);
    const attr = referred?.profile && typeof referred.profile === 'object' && referred.profile.attribution && typeof referred.profile.attribution === 'object'
      ? referred.profile.attribution
      : null;
    if (!attr?.referralCode) return { skipped: 'NOT_REFERRED' };
    if (attr.referralQualifiedAt) return { skipped: 'ALREADY_QUALIFIED' };
    const referrer = await accountByReferralCode({ prisma, code: attr.referralCode });
    if (!referrer || referrer.id === referredAccountId) return { skipped: 'NO_REFERRER' };

    const cents = rewardCents(env);
    const at = now.toISOString();
    const stamp = { referralQualifiedAt: at, referralQualifiedBy: trigger || 'UNKNOWN', referralRewardCents: 0 };
    let credited = false;
    let receipt = null;
    if (cents > 0) {
      const post = deps.post || postEntry;
      const ensure = deps.ensureWallet || ensureWallet;
      await ensure({ accountId: referrer.id });
      const idemKey = rewardIdemKey(referredAccountId);
      const posted = await post(buildReferralReward({ referrerAccountId: referrer.id, referredAccountId, amountCents: cents, idemKey }));
      stamp.referralRewardCents = cents;
      stamp.referralRewardAt = at;
      stamp.referralRewardIdemKey = idemKey;
      credited = !posted?.replayed;
      if (credited) receipt = await sendRewardReceipt({ prisma, referrer, amountCents: cents, deps });
    }
    await mergeProfileSubkeyAtomic({ prisma, accountId: referredAccountId, key: 'attribution', patch: stamp });
    log('referral_qualified', { referredAccountId, referrerAccountId: referrer.id, trigger: stamp.referralQualifiedBy, rewardCents: stamp.referralRewardCents, credited, receipt: receipt?.rail || receipt?.skipped || null });
    return { ok: true, referrerAccountId: referrer.id, rewardCents: stamp.referralRewardCents, credited, receipt };
  } catch (error) {
    log('referral_qualify_error', { referredAccountId, trigger, error: error?.message });
    return { ok: false, error: error?.message || 'qualify failed' };
  }
}

/** First money in for this account (a deposit, a load, a send received). Idempotent, never throws. */
export async function onFunded({ prisma = prismaDefault, accountId, now, env, deps } = {}) {
  return qualifyReferral({ prisma, referredAccountId: accountId, trigger: 'FUNDED', now, env, deps });
}

/** A please-pay-me link of this account was paid. Idempotent, never throws. */
export async function onLinkPaid({ prisma = prismaDefault, accountId, now, env, deps } = {}) {
  return qualifyReferral({ prisma, referredAccountId: accountId, trigger: 'LINK_PAID', now, env, deps });
}

/**
 * The safety net, on a referred account's own turn: a first credit no hook
 * saw (a voucher load, a send from a member, a held gift claimed at join)
 * qualifies the invite here, with the earlier of the two milestones as the
 * trigger. Cheap for everyone else: it returns before any query unless the
 * account is referred, onboarded and not yet qualified.
 */
export async function referralCatchUp({ prisma = prismaDefault, account, now = new Date(), env = process.env, deps = {} } = {}) {
  try {
    const attr = account?.profile && typeof account.profile === 'object' ? account.profile.attribution : null;
    if (!attr?.referralCode || attr.referralQualifiedAt || account.onboardingState !== 'S5_COMPLETED') return { skipped: 'NOTHING_TO_DO' };
    const { funded, paid } = await referredMilestones({ prisma, accountIds: [account.id] });
    const fundedAt = funded.get(account.id) || null;
    const paidAt = paid.get(account.id) || null;
    if (!fundedAt && !paidAt) return { skipped: 'NOT_YET' };
    const trigger = paidAt && (!fundedAt || paidAt <= fundedAt) ? 'LINK_PAID' : 'FUNDED';
    return await qualifyReferral({ prisma, referredAccountId: account.id, trigger, now, env, deps });
  } catch (error) {
    log('referral_catch_up_error', { accountId: account?.id || null, error: error?.message });
    return { ok: false, error: error?.message || 'catch-up failed' };
  }
}
