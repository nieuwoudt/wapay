/**
 * The one reminder an ad arrival may get (docs/AD_CHAT_FLOW.md section 8).
 *
 * Only when they stopped mid-onboarding, or finished onboarding without a
 * payment link. About 20 hours after their last message, so it lands inside
 * WhatsApp's 24-hour window (no template) and inside the 72-hour free window
 * an ad conversation gets. Once, ever: `attribution.reminderSentAt` is the
 * lock; "stop" sets `attribution.reminderOptOut`. Meta's automatic follow-up
 * is switched off in the ad, so this is the only reminder there is.
 *
 * Scheduling: the daily cron runs the sweep, and the processor runs it
 * best-effort at the end of a turn (one reminder, throttled) so the window is
 * not missed on quiet days. Reads the customer's own last message from
 * conversation_turns (role user).
 */

import prismaDefault from './prisma.js';
import { mergeProfileSubkeyAtomic } from './profile-merge.js';
import { reminderCopy, firstNameFrom } from './ad-flow.js';

const HOUR = 3600 * 1000;
export const REMINDER_AFTER_MS = 20 * HOUR;
export const REMINDER_LATEST_MS = 23.5 * HOUR; // still inside the 24h window when sent

/** Accounts due a reminder right now. Pure SQL + a small filter; no sends. */
export async function dueAdReminders({ prisma = prismaDefault, now = new Date(), limit = 20 } = {}) {
  const newest = new Date(now.getTime() - REMINDER_AFTER_MS);
  const oldest = new Date(now.getTime() - REMINDER_LATEST_MS);
  const rows = await prisma.$queryRaw`
    SELECT a.id, a."waId" AS wa_id, a."displayName" AS display_name, a."onboardingState" AS state,
           t.last_user_at,
           (SELECT count(*)::int FROM payment_requests pr WHERE pr."accountId" = a.id) AS links
    FROM "Account" a
    JOIN (SELECT "accountId", max("createdAt") AS last_user_at FROM conversation_turns WHERE role = 'user' GROUP BY 1) t ON t."accountId" = a.id
    WHERE a."profile"->>'acquisitionSource' = 'ad'
      AND (a."profile"->'attribution'->>'reminderSentAt') IS NULL
      AND coalesce(a."profile"->'attribution'->>'reminderOptOut', 'false') <> 'true'
      AND t.last_user_at BETWEEN ${oldest} AND ${newest}
    ORDER BY t.last_user_at ASC
    LIMIT ${limit}`;
  return (rows || [])
    .map((r) => ({
      id: r.id,
      waId: r.wa_id,
      firstName: firstNameFrom(r.display_name),
      kind: r.state === 'S5_COMPLETED' ? (Number(r.links) > 0 ? null : 'no_link') : 'mid_onboarding',
      lastUserAt: r.last_user_at,
    }))
    .filter((r) => r.kind);
}

export async function markReminderSent({ prisma = prismaDefault, accountId, now = new Date() } = {}) {
  return mergeProfileSubkeyAtomic({ prisma, accountId, key: 'attribution', patch: { reminderSentAt: now.toISOString() } });
}

export async function markReminderOptOut({ prisma = prismaDefault, accountId, now = new Date() } = {}) {
  return mergeProfileSubkeyAtomic({ prisma, accountId, key: 'attribution', patch: { reminderOptOut: true, reminderOptOutAt: now.toISOString() } });
}

/**
 * Send what is due. `send` is the text sender ({ to, text, kind }) so the
 * processor can pass say() and the cron notifyCustomer(). Never throws.
 */
export async function sendAdReminders({ prisma = prismaDefault, now = new Date(), limit = 20, send } = {}) {
  const out = { due: 0, sent: 0, failed: 0 };
  try {
    const due = await dueAdReminders({ prisma, now, limit });
    out.due = due.length;
    for (const r of due) {
      // Lock first: a concurrent sweep must not send twice.
      const locked = await markReminderSent({ prisma, accountId: r.id, now });
      if (!locked) continue;
      const res = await send({ to: r.waId, text: reminderCopy(r.kind, r.firstName), kind: 'ad_reminder' });
      if (res?.ok) out.sent += 1;
      else out.failed += 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ type: 'ad_reminders_error', error: error?.message }));
    out.error = error?.message || 'sweep failed';
  }
  return out;
}

let lastTurnSweepAt = 0;
/** The per-turn piggyback: at most one reminder, at most every ten minutes per instance. */
export async function sweepOnTurn({ prisma = prismaDefault, now = new Date(), send } = {}) {
  if (now.getTime() - lastTurnSweepAt < 10 * 60 * 1000) return { skipped: 'THROTTLED' };
  lastTurnSweepAt = now.getTime();
  return sendAdReminders({ prisma, now, limit: 1, send });
}
