/**
 * Pay-out rules (founder decisions, 2026-10-20, after the card-to-cash morning; tightened 2026-10-24 after
 * the stolen-card cash-out of BUGLOG #140: "maximum withdrawals per day is 3k, every customer doing a
 * withdrawal over 1000 needs to do a KYC"):
 *
 *   - a daily cap for EVERY account: at most WAPAY_PAYOUT_DAILY_CAP_CENTS (R3,000) in any 24 hours, KYC
 *     or not (2026-10-24). The new-account cap below still applies when it is the lower one;
 *   - KYC over R1,000 (2026-10-24): a single pay-out of MORE than WAPAY_PAYOUT_KYC_SINGLE_CENTS (R1,000),
 *     or more than WAPAY_PAYOUT_KYC_DAILY_CENTS (R1,000) in 24 hours, so three R1,000 pay-outs cannot
 *     dodge it. Without the check a customer can take up to R1,000 a day; with it, up to the cap.
 *
 *   - a daily cap for new accounts: an account younger than WAPAY_PAYOUT_NEW_ACCOUNT_DAYS
 *     (7) may pay out at most WAPAY_PAYOUT_NEW_ACCOUNT_DAILY_CAP_CENTS (R10,000) in any
 *     24 hours, KYC or not;
 *   - KYC by threshold: with WAPAY_PAYOUT_KYC=threshold, an unverified account needs the
 *     identity check for a single pay-out of WAPAY_PAYOUT_KYC_SINGLE_CENTS (R3,000) or more,
 *     or when its pay-outs in 24 hours would pass WAPAY_PAYOUT_KYC_DAILY_CENTS (R10,000).
 *     WAPAY_PAYOUT_KYC=off keeps KYC out entirely; any other value keeps the original
 *     "KYC for everyone" gate.
 *
 * No hold on card-funded money and no cap tied to the funding source: the founder
 * decided against both. "In 24 hours" is a rolling window measured from now, counted
 * over pay-outs that succeeded or are still pending on the rail. The customer is told
 * the rule in one honest line with the remaining amount; no time promise, no blame.
 * Enforced where money leaves: lib/payouts.js (requestPayout) as the backstop and in
 * the withdraw flow at the amount step so nobody types bank details for a pay-out that
 * cannot happen.
 */
export const DAY_MS = 24 * 60 * 60 * 1000;

export function kycMode(env = process.env) {
  // Exactly 'off' and exactly 'threshold' (tests/payout lock: only exactly "off" skips the gate).
  const v = String(env.WAPAY_PAYOUT_KYC || '');
  if (v === 'off') return 'off';
  if (v === 'threshold') return 'threshold';
  return 'all';
}

export function kycConfigured(env = process.env) {
  return !!(env.DIDIT_API_KEY && env.DIDIT_WORKFLOW_ID && env.DIDIT_WEBHOOK_SECRET);
}

export function payoutRules(env = process.env) {
  const n = (k, d) => { const v = Number(env[k]); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : d; };
  return {
    newAccountDays: n('WAPAY_PAYOUT_NEW_ACCOUNT_DAYS', 7),
    newAccountDailyCapCents: n('WAPAY_PAYOUT_NEW_ACCOUNT_DAILY_CAP_CENTS', 1000000),
    dailyCapCents: n('WAPAY_PAYOUT_DAILY_CAP_CENTS', 300000),
    kycSingleCents: n('WAPAY_PAYOUT_KYC_SINGLE_CENTS', 100000),
    kycDailyCents: n('WAPAY_PAYOUT_KYC_DAILY_CENTS', 100000),
    kycMode: kycMode(env),
    kycConfigured: kycConfigured(env),
  };
}

export function kycVerified(account) {
  const p = account?.profile;
  return !!(p && typeof p === 'object' && p.kyc && p.kyc.status === 'VERIFIED');
}

/** Rands paid out (or pending on the rail) in the last 24 hours. Never throws. */
export async function paidOutLast24h({ prisma, accountId, now = Date.now() }) {
  try {
    const rows = await prisma.providerRequest.findMany({ where: { accountId, route: 'ott-payout', status: { in: ['SUCCESS', 'PENDING'] }, requestTs: { gte: new Date(now - DAY_MS) } }, select: { metadata: true } });
    return rows.reduce((s, r) => s + (Number(r?.metadata?.amountCents) || 0), 0);
  } catch {
    return 0;
  }
}

/**
 * The decision for one pay-out of `amountCents`. Pure apart from the two reads
 * (the account's age and the 24-hour total); a failed read is treated as an old
 * account with nothing paid out, so a database hiccup never blocks a customer
 * for the wrong reason (the float and the rail still gate the money).
 */
export async function checkPayoutRules({ prisma, account, amountCents, now = Date.now(), env = process.env }) {
  const rules = payoutRules(env);
  let createdAt = account?.createdAt ? new Date(account.createdAt).getTime() : null;
  let profileAccount = account;
  if ((createdAt == null || !account?.profile) && prisma?.account?.findUnique && account?.id) {
    try {
      const row = await prisma.account.findUnique({ where: { id: account.id }, select: { createdAt: true, profile: true } });
      if (row) { createdAt = createdAt ?? (row.createdAt ? new Date(row.createdAt).getTime() : null); profileAccount = { ...account, profile: account?.profile || row.profile }; }
    } catch {
      // fall through: no age known, not verified
    }
  }
  const amount = Number(amountCents) || 0;
  const ageDays = createdAt != null ? (now - createdAt) / DAY_MS : null;
  const isNew = ageDays != null && ageDays < rules.newAccountDays;
  const usedCents = await paidOutLast24h({ prisma, accountId: account?.id, now });
  const verified = kycVerified(profileAccount);
  // The cap for everyone (2026-10-24); a new account's own cap only when it is lower.
  const newCapBites = isNew && rules.newAccountDailyCapCents < rules.dailyCapCents;
  const capCents = newCapBites ? rules.newAccountDailyCapCents : rules.dailyCapCents;
  if (usedCents + amount > capCents) {
    return { ok: false, error: 'DAILY_CAP', capCents, usedCents, remainingCents: Math.max(0, capCents - usedCents), newAccount: newCapBites, newAccountDays: rules.newAccountDays, isNew, verified };
  }
  if (rules.kycMode === 'threshold' && !verified) {
    if (amount > rules.kycSingleCents) return { ok: false, error: 'KYC_REQUIRED', reason: 'SINGLE', thresholdCents: rules.kycSingleCents, usedCents, kycConfigured: rules.kycConfigured, isNew, verified };
    if (usedCents + amount > rules.kycDailyCents) return { ok: false, error: 'KYC_REQUIRED', reason: 'DAILY', thresholdCents: rules.kycDailyCents, usedCents, kycConfigured: rules.kycConfigured, isNew, verified };
  }
  return { ok: true, usedCents, isNew, verified };
}

const R = (c) => `R${(Number(c) / 100).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).replace(/ /g, ',')}`;

/** The one line a customer sees when the daily cap stops a pay-out. */
export function dailyCapCopy(out) {
  const cap = R(out.capCents); const remaining = Number(out.remainingCents) || 0;
  const who = out.newAccount ? 'New accounts can pay out' : 'You can pay out';
  if (remaining > 0) return `⏸ ${who} up to ${cap} in any 24 hours. You have paid out ${R(out.usedCents)} in the last 24 hours, so up to ${R(remaining)} more works now. Type a smaller amount, or "cancel".`;
  return `⏸ ${who} up to ${cap} in any 24 hours, and you have reached that for now. Your money stays safe in your balance. Try again once 24 hours have passed since your earlier pay-outs, or "cancel".`;
}

/** The line for a pay-out that needs the identity check; honest when the check is not switched on yet. */
export function kycThresholdCopy(out, { configured = out.kycConfigured } = {}) {
  const what = out.reason === 'SINGLE' ? `Pay-outs over ${R(out.thresholdCents)}` : `Paying out more than ${R(out.thresholdCents)} in 24 hours`;
  if (configured) return `🪪 ${what} need a once-off identity check on your phone. Reply *VERIFY* and I will send you the secure link, or type a smaller amount.`;
  const under = out.reason === 'SINGLE' ? `up to ${R(out.thresholdCents)} per pay-out works now` : `a smaller amount works now`;
  return `🪪 ${what} need a once-off identity check, which is being switched on. For now ${under}. Type a smaller amount, or "cancel".`;
}

/**
 * A short rule note for the amount prompt, only when a rule can bite this account: the cap when the
 * balance is above it (or the account is new and its own cap is lower), the identity check when the
 * account is not verified.
 */
export function rulesNote({ createdAt, verified = false, balanceCents = null, now = Date.now(), env = process.env } = {}) {
  const rules = payoutRules(env);
  const ageDays = createdAt ? (now - new Date(createdAt).getTime()) / DAY_MS : null;
  const isNew = ageDays != null && ageDays < rules.newAccountDays;
  const parts = [];
  if (isNew && rules.newAccountDailyCapCents < rules.dailyCapCents) parts.push(`New accounts can pay out up to ${R(rules.newAccountDailyCapCents)} in any 24 hours.`);
  else if (Number(balanceCents) > rules.dailyCapCents) parts.push(`You can pay out up to ${R(rules.dailyCapCents)} in any 24 hours.`);
  if (rules.kycMode === 'threshold' && !verified) {
    parts.push(rules.kycSingleCents === rules.kycDailyCents
      ? `Paying out more than ${R(rules.kycDailyCents)} in 24 hours needs a once-off identity check.`
      : `Pay-outs over ${R(rules.kycSingleCents)}, or more than ${R(rules.kycDailyCents)} in 24 hours, need a once-off identity check.`);
  }
  return parts.join(' ');
}
