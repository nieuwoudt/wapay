/**
 * Global pay-out hold (founder 2026-10-24, after the stolen-card cash-out of BUGLOG #140: "don't do any
 * more payouts until I say we can").
 *
 * The switch is one row in processed_messages, waMessageId 'payout-hold:global': present = held. No job
 * purges that table by age (only releaseClaim deletes, by exact id), so the hold stays until it is lifted
 * on purpose. Every switch also writes a log row, 'payout-hold:log:<iso>|on|<by>|<reason>', so who paused
 * or reopened pay-outs, and why, is kept in the database rather than in short-lived function logs.
 *
 * Read fresh (5-second cache per database client) by requestPayout, the one function every real pay-out
 * goes through (chat, web app, operator link, business portal), by the chat's withdraw flow before it asks
 * anything, by the web app's pay-out screen and by the operator dry run. It fails CLOSED: if the hold
 * cannot be read, pay-outs are held. Getting paid and sends between WaPay users stay open.
 *
 * Lift it only on the founder's word: POST /api/internal/payout-hold { held: false, by, reason }.
 */
import prismaDefault from './prisma.js';

export const PAYOUT_HOLD_KEY = 'payout-hold:global';
export const PAYOUT_HOLD_LOG_PREFIX = 'payout-hold:log:';
// No time promise: nobody knows when the founder will reopen pay-outs, and WaPay never messages first.
export const PAYOUT_HOLD_COPY = '⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.';

// One cache per database client, so a test stub never sees another stub's answer.
let caches = new WeakMap();
export function _resetPayoutHoldCache() { caches = new WeakMap(); }

// Tests only: Prisma reads the fast copy's .env on its own, so a test that uses the default client
// would otherwise see production's hold. true/false pins the answer for this process; null reads again.
// Never called by application code, and no environment variable can reach it.
let pinned = null;
export function _pinPayoutHoldForTests(value) { pinned = value === null ? null : !!value; }

const hasModel = (prisma) => typeof prisma?.processedMessage?.findUnique === 'function';
const clean = (s, max) => String(s || '').replace(/[|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Parses one log row id back into { at, held, by, reason }; null when it is not a hold log row. */
export function parseHoldLog(waMessageId) {
  const s = String(waMessageId || '');
  if (!s.startsWith(PAYOUT_HOLD_LOG_PREFIX)) return null;
  const [at, onOff, by = '', ...rest] = s.slice(PAYOUT_HOLD_LOG_PREFIX.length).split('|');
  if (!at || (onOff !== 'on' && onOff !== 'off')) return null;
  return { at, held: onOff === 'on', by, reason: rest.join('|') };
}

/**
 * { held, since, last, readable }: the switch read fresh, when it went on, and the latest log row.
 * A failed read answers held (fail closed) with readable false.
 */
export async function readPayoutHold({ prisma = prismaDefault } = {}) {
  if (!hasModel(prisma)) return { held: false, since: null, last: null, readable: false };
  try {
    const row = await prisma.processedMessage.findUnique({ where: { waMessageId: PAYOUT_HOLD_KEY }, select: { processedAt: true } });
    let last = null;
    if (typeof prisma.processedMessage.findFirst === 'function') {
      const log = await prisma.processedMessage
        .findFirst({ where: { waMessageId: { startsWith: PAYOUT_HOLD_LOG_PREFIX } }, orderBy: { processedAt: 'desc' }, select: { waMessageId: true } })
        .catch(() => null);
      last = log ? parseHoldLog(log.waMessageId) : null;
    }
    return { held: !!row, since: row?.processedAt ? new Date(row.processedAt).toISOString() : null, last, readable: true };
  } catch {
    return { held: true, since: null, last: null, readable: false };
  }
}

/** True while pay-outs are held. Fails closed. A client without the table (a unit-test stub) is never held. */
export async function isPayoutHeld({ prisma = prismaDefault, now = Date.now(), ttlMs = 5000 } = {}) {
  if (pinned !== null) return pinned;
  if (!hasModel(prisma)) return false;
  const hit = caches.get(prisma);
  if (hit && now - hit.at < ttlMs) return hit.held;
  let held;
  try {
    held = !!(await prisma.processedMessage.findUnique({ where: { waMessageId: PAYOUT_HOLD_KEY }, select: { id: true } }));
  } catch {
    held = true;
  }
  caches.set(prisma, { at: now, held });
  return held;
}

/**
 * Test numbers (founder 2026-10-25: "how can I test this?"): WAPAY_PAYOUT_TEST_NUMBERS, a comma-separated
 * list in any spelling (0…, 27…, +27…). A test number goes through the whole withdrawal, the pause included:
 * the amount, the fees with the express fee, the ID check, the cap, the confirmation, the PIN, the fraud
 * triage and the founder's alert. requestPayout then stops before any row, hold, ledger move or rail call
 * (TEST_RUN), so no money ever moves for a test number, paused or not. A frozen account stays frozen.
 */
const last9 = (n) => String(n || '').replace(/\D/g, '').slice(-9);
export function payoutTestNumbers(env = process.env) {
  return String(env.WAPAY_PAYOUT_TEST_NUMBERS || '').split(',').map(last9).filter((n) => n.length === 9);
}
export function isPayoutTestNumber(account, env = process.env) {
  const list = payoutTestNumbers(env);
  if (!list.length || !account) return false;
  return [account.waId, account.msisdn].some((n) => n && list.includes(last9(n)));
}
/** The hold as it applies to this account: a test number passes it (and then never moves money). */
export async function isPayoutHeldFor({ prisma = prismaDefault, account = null, env = process.env } = {}) {
  if (isPayoutTestNumber(account, env)) return false;
  return isPayoutHeld({ prisma });
}

/** Turns the hold on or off and logs who and why. `by` and `reason` are required. */
export async function setPayoutHold({ prisma = prismaDefault, held, by, reason, now = new Date() }) {
  if (typeof held !== 'boolean') throw Object.assign(new Error('held must be true or false'), { code: 'BAD_HELD' });
  const who = clean(by, 60);
  const why = clean(reason, 200);
  if (!who || !why) throw Object.assign(new Error('by and reason are required'), { code: 'NEED_REASON' });
  if (held) await prisma.processedMessage.upsert({ where: { waMessageId: PAYOUT_HOLD_KEY }, create: { waMessageId: PAYOUT_HOLD_KEY }, update: {} });
  else await prisma.processedMessage.deleteMany({ where: { waMessageId: PAYOUT_HOLD_KEY } });
  const at = new Date(now).toISOString();
  await prisma.processedMessage
    .create({ data: { waMessageId: `${PAYOUT_HOLD_LOG_PREFIX}${at}|${held ? 'on' : 'off'}|${who}|${why}` } })
    .catch(() => null);
  caches.delete(prisma);
  return readPayoutHold({ prisma });
}
