/**
 * Two speeds for a pay-out to a bank account (founder 2026-11-07, confirmed 2026-11-11):
 * "payout to your bank is R12 for all payouts, and if you want a same-day payout, it's R20 ... if it's cleared."
 *
 *   NEXT_DAY  R12 (FEES.cashout[method].nextDayFeeCents): sent on the next South African business day, never
 *             before 08:00 SAST that day. The default whenever a caller does not name a speed.
 *   SAME_DAY  R20 (the method's bands): sent as soon as it is approved, like every pay-out before.
 *
 * "If it's cleared": money that reached the balance less than 2 hours ago (lib/payout-express.js, the same
 * receipts and the same oldest-first ageing as the express fee) can only go on the next business day. Same day
 * opens again once the pay-out no longer needs that money (`clearedFromAt`). This replaces the doubled fee for
 * bank pay-outs; cash keeps its fees and its express rule.
 *
 * Only PayShap and RTC have speeds. Weekends are not business days; there is no public holiday list in the
 * code, so a public holiday on a weekday counts as a business day (PayShap runs every day).
 */
import { freshNeed } from './payout-express.js';

export const SPEED = Object.freeze({ NEXT_DAY: 'NEXT_DAY', SAME_DAY: 'SAME_DAY' });
export const SPEED_METHODS = Object.freeze(['PAYSHAP', 'RTC']);
export const RELEASE_HOUR_SAST = 8;
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000; // South Africa has no daylight saving.
const DAY_MS = 24 * 60 * 60 * 1000;

export const hasSpeeds = (method) => SPEED_METHODS.includes(method);

/** The speed a pay-out carries: null for cash, else SAME_DAY only when asked for by name. */
export function speedFor(method, speed) {
  if (!hasSpeeds(method)) return null;
  return String(speed || '').toUpperCase() === SPEED.SAME_DAY ? SPEED.SAME_DAY : SPEED.NEXT_DAY;
}

/**
 * 08:00 SAST on the first Monday to Friday after the day `now` falls on in South Africa (epoch ms).
 * Asked on Monday at 07:00 or at 23:00: Tuesday 08:00. Friday evening, Saturday or Sunday: Monday 08:00.
 */
export function nextBusinessDayAt(now = Date.now()) {
  const local = new Date(Number(now) + SAST_OFFSET_MS);
  let day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  do { day += DAY_MS; } while ([0, 6].includes(new Date(day).getUTCDay()));
  return day + RELEASE_HOUR_SAST * 60 * 60 * 1000 - SAST_OFFSET_MS;
}

/**
 * May this pay-out go the same day? Not when the amount plus the same-day fee needs money that reached the
 * balance less than 2 hours ago. `clearedFromAt` (epoch ms) is when it can, or null when the balance alone
 * never covers it. Never throws; an unreadable history counts as cleared (the triage still sees the money).
 */
export function sameDayCheck({ balanceCents, receipts = [], amountCents, feeCents, now = Date.now(), env = process.env }) {
  const f = freshNeed({ balanceCents, receipts, amountCents, feeCents, now, env });
  return { cleared: !f.needsFresh, clearedFromAt: f.needsFresh ? f.clearAt : null, freshCents: f.freshCents };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Thursday 12 November" in SAST. */
export function sastDay(ms) {
  const d = new Date(Number(ms) + SAST_OFFSET_MS);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Thursday 12 November, from 08:00": when a next-business-day pay-out goes. */
export function releaseWhen(releaseAt) {
  const ms = typeof releaseAt === 'number' ? releaseAt : Date.parse(releaseAt || '');
  if (!Number.isFinite(ms)) return 'the next business day';
  return `${sastDay(ms)}, from ${String(RELEASE_HOUR_SAST).padStart(2, '0')}:00`;
}

/** A pay-out row (or its metadata) that is set to go on the next business day and is not due yet. */
export function releasePending(meta, now = Date.now()) {
  if (meta?.speed !== SPEED.NEXT_DAY) return false;
  const at = Date.parse(meta?.releaseAt || '');
  return Number.isFinite(at) && now < at;
}

/** The two words a customer reads for a speed. */
export const speedWords = (speed) => (speed === SPEED.SAME_DAY ? 'same day' : speed === SPEED.NEXT_DAY ? 'next business day' : null);
