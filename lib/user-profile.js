/**
 * User memory — the bot gets to know each customer (founder ask 2026-08-20).
 *
 * One JSON profile per account, written DETERMINISTICALLY at success points
 * (never by the model) and injected into the orchestrator as context every
 * turn. Shape:
 *   language           - preferred reply language (most-seen non-'other')
 *   languageCounts     - {en: 12, zu: 3} rolling evidence
 *   preferredDepositMethod - 'CARD' | 'VOUCHER' (last successful load rail)
 *   lastMeterNumber    - last electricity meter successfully used
 *   interests          - last ≤8 product topics the user asked about
 *   updatedAt          - ISO timestamp
 *
 * Every writer is best-effort: profile writes must never break a money flow.
 */

import prisma from './prisma.js';
import { mergeProfileAtomic } from './profile-merge.js';

/** @returns {Promise<object>} the profile (empty object when none yet) */
export async function getProfile({ prisma: prismaClient = prisma, accountId }) {
  try {
    if (!accountId) return {};
    const row = await prismaClient.account.findUnique({ where: { id: accountId } });
    return row?.profile && typeof row.profile === 'object' ? row.profile : {};
  } catch (error) {
    console.error(JSON.stringify({ type: 'profile_read_error', accountId, error: error?.message }));
    return {};
  }
}

/**
 * Shallow-merge a patch into the profile. Best-effort. ATOMIC: the merge
 * happens in Postgres (jsonb ||), so a concurrent writer to a different key
 * (e.g. the KYC webhook) is never clobbered (review 2026-08-28).
 */
export async function updateProfile({ prisma: prismaClient = prisma, accountId, patch }) {
  if (!accountId || !patch || typeof patch !== 'object') return null;
  const ok = await mergeProfileAtomic({ prisma: prismaClient, accountId, patch });
  if (!ok) return null;
  return getProfile({ prisma: prismaClient, accountId });
}

/**
 * Record the language of one user turn. The PREFERRED language is the one
 * with the most evidence — a single foreign-language test message must not
 * flip the bot's tongue (live bug 2026-08-20: one isiZulu line in history
 * made the bot answer "Okay" in isiZulu).
 */
export async function noteLanguage({ prisma: prismaClient = prisma, accountId, language }) {
  if (!language || language === 'other') return null;
  const profile = await getProfile({ prisma: prismaClient, accountId });
  const counts = { ...(profile.languageCounts || {}) };
  counts[language] = (counts[language] || 0) + 1;
  // An EXPLICIT choice ("speak Xhosa") locks the reply language: rolling
  // evidence keeps accruing, but a locked language only yields to a
  // challenger that clearly overtakes it (a real, sustained switch), never
  // to one or two ambiguous English turns (abuse review 2026-08-25).
  const current = profile.language;
  let preferred;
  if (profile.languageLocked && current) {
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    preferred = top[1] >= (counts[current] || 0) + 3 ? top[0] : current;
  } else {
    preferred = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }
  return updateProfile({ prisma: prismaClient, accountId, patch: { language: preferred, languageCounts: counts } });
}

/** Record a successful load rail: 'CARD' (PayFast) or 'VOUCHER' (Blu). */
/**
 * Explicit language choice ("speak Xhosa") — the strongest evidence there
 * is: set it immediately and weight it so casual code-switching in later
 * messages cannot flip it back by accident.
 */
export async function setLanguage({ prisma: prismaClient = prisma, accountId, language }) {
  if (!language) return null;
  const profile = await getProfile({ prisma: prismaClient, accountId });
  const counts = { ...(profile.languageCounts || {}) };
  counts[language] = (counts[language] || 0) + 5;
  return updateProfile({
    prisma: prismaClient,
    accountId,
    patch: { language, languageCounts: counts, languageLocked: true },
  });
}

export async function noteDepositMethod({ prisma: prismaClient = prisma, accountId, method }) {
  if (!['CARD', 'VOUCHER'].includes(method)) return null;
  return updateProfile({ prisma: prismaClient, accountId, patch: { preferredDepositMethod: method } });
}

/** Record the meter a successful electricity flow used. */
export async function noteMeterNumber({ prisma: prismaClient = prisma, accountId, meterNumber }) {
  const m = String(meterNumber || '').replace(/\D/g, '');
  if (m.length < 8 || m.length > 13) return null;
  return updateProfile({ prisma: prismaClient, accountId, patch: { lastMeterNumber: m } });
}

/** Record a product topic the user showed interest in (ring of 8). */
export async function noteInterest({ prisma: prismaClient = prisma, accountId, topic }) {
  const t = String(topic || '').trim().toLowerCase().slice(0, 40);
  if (t.length < 3) return null;
  const profile = await getProfile({ prisma: prismaClient, accountId });
  const interests = [t, ...(profile.interests || []).filter((x) => x !== t)].slice(0, 8);
  return updateProfile({ prisma: prismaClient, accountId, patch: { interests } });
}

/**
 * The profile as a compact context block for the orchestrator. Empty string
 * when nothing is known yet.
 */
export function formatProfileContext(profile) {
  if (!profile || typeof profile !== 'object') return '';
  const bits = [];
  if (profile.language) bits.push(`preferred language: ${profile.language}`);
  if (profile.preferredDepositMethod) {
    bits.push(`deposits by ${profile.preferredDepositMethod === 'CARD' ? 'card/PayFast' : 'cash voucher'}`);
  }
  if (profile.lastMeterNumber) bits.push(`last electricity meter: ${profile.lastMeterNumber}`);
  if (profile.interests?.length) bits.push(`recent interests: ${profile.interests.slice(0, 5).join(', ')}`);
  if (!bits.length) return '';
  return `KNOWN USER PROFILE (system memory, not user input): ${bits.join('; ')}.`;
}
