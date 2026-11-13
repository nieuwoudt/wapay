/**
 * The PIN lockout holds under simultaneous guesses (security sweep 2026-11-13).
 *
 * Before: verifyPIN checked the PIN and then wrote "the count I read, plus
 * one". A burst of wrong PINs sent together all read the same count, were all
 * checked, and together cost one attempt, so the five-try lock did not hold on
 * any surface (chat, web portal, business portal).
 *
 * What these lock:
 * - an attempt is spent BEFORE the PIN is checked, as a compare-and-set on the
 *   count the request read: of any number of simultaneous requests exactly one
 *   wins, and the lock is written by the attempt that reaches it;
 * - a burst of 200 wrong PINs gets at most five checked before the 15-minute
 *   lock, and at most ten before the hard lock, however it is timed;
 * - an honest double submit of the right PIN still goes through.
 *
 * Needs the auth package built (pnpm build:packages) after packages/auth/src changes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const auth = await import('@wapay/auth');
const { claimPinAttempt, pinLockFor } = auth;
const src = readFileSync(fileURLToPath(new URL('../packages/auth/src/pin.ts', import.meta.url)), 'utf8');

/** One auth_factors row. updateMany is one statement: the filter and the write cannot be interleaved. */
function table(row) {
  const r = { id: 'f1', attempts: 0, lockedUntil: null, ...row };
  const matches = (w, now) => r.id === w.id && r.attempts === w.attempts
    && w.OR.some((o) => (o.lockedUntil === null ? r.lockedUntil === null : r.lockedUntil !== null && r.lockedUntil <= o.lockedUntil.lte));
  return {
    row: r,
    authFactor: {
      async read() { await null; return { id: r.id, attempts: r.attempts, lockedUntil: r.lockedUntil }; },
      async updateMany({ where, data }) { await null; if (!matches(where)) return { count: 0 }; Object.assign(r, data); return { count: 1 }; },
    },
  };
}

test('built: the auth package exports the claim (run pnpm build:packages if this fails)', () => {
  assert.equal(typeof claimPinAttempt, 'function');
  assert.equal(typeof pinLockFor, 'function');
});

test('the lock follows the count after the attempt: 15 minutes from the 5th, a hard lock from the 10th', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  for (const n of [1, 2, 3, 4]) assert.equal(pinLockFor(n, now), null);
  for (const n of [5, 6, 9]) assert.equal(pinLockFor(n, now).toISOString(), '2026-11-13T12:15:00.000Z');
  assert.ok(pinLockFor(10, now) - now > 300 * 86400 * 1000, 'the 10th is the hard lock');
});

test('of any number of requests holding the same count, exactly one spends the attempt', async () => {
  const db = table();
  const read = await db.authFactor.read();
  const out = await Promise.all(Array.from({ length: 200 }, () => claimPinAttempt(db, read)));
  assert.equal(out.filter((c) => c.ok).length, 1);
  assert.equal(db.row.attempts, 1);
  // A locked row cannot be claimed; an expired lock can.
  const locked = table({ attempts: 5, lockedUntil: new Date(Date.now() + 60000) });
  assert.equal((await claimPinAttempt(locked, { id: 'f1', attempts: 5 })).ok, false);
  const expired = table({ attempts: 5, lockedUntil: new Date(Date.now() - 1000) });
  const c = await claimPinAttempt(expired, { id: 'f1', attempts: 5 });
  assert.equal(c.ok, true); assert.equal(c.attempts, 6); assert.ok(c.lockedUntil > new Date(), 'the 6th wrong try locks again');
});

test('a burst of 200 wrong PINs: five are checked, then the lock; never more than ten in all', async () => {
  // The sequence verifyPIN runs: read, refuse if locked, claim (re-reading twice on a lost claim), then check.
  const guess = async (db, counter) => {
    let f = await db.authFactor.read();
    if (f.lockedUntil && f.lockedUntil > new Date()) return 'LOCKED';
    let c = await claimPinAttempt(db, f);
    for (let i = 0; !c.ok && i < 2; i++) {
      f = await db.authFactor.read();
      if (f.lockedUntil && f.lockedUntil > new Date()) return 'LOCKED';
      c = await claimPinAttempt(db, f);
    }
    if (!c.ok) return 'BUSY';
    counter.checked += 1;
    return 'WRONG';
  };
  const db = table(); const counter = { checked: 0 };
  const first = await Promise.all(Array.from({ length: 200 }, () => guess(db, counter)));
  assert.ok(counter.checked <= 5, `${counter.checked} PINs were checked in the first burst`);
  assert.ok(counter.checked >= 1);
  assert.ok(db.row.lockedUntil === null || db.row.attempts >= 5, 'a lock is only ever written with the attempt that reaches it');
  assert.equal(first.filter((x) => x === 'WRONG').length, counter.checked);

  // Keep bursting, letting every 15-minute lock expire: the hard lock stops it at ten.
  for (let round = 0; round < 30 && db.row.attempts < 10; round++) {
    if (db.row.lockedUntil) db.row.lockedUntil = new Date(Date.now() - 1);
    await Promise.all(Array.from({ length: 200 }, () => guess(db, counter)));
  }
  assert.equal(db.row.attempts, 10);
  assert.equal(counter.checked, 10, 'ten wrong PINs in all, then the hard lock');
  assert.ok(db.row.lockedUntil - new Date() > 300 * 86400 * 1000);
  db.row.lockedUntil = new Date(Date.now() + 1000);
  assert.deepEqual(await Promise.all(Array.from({ length: 50 }, () => guess(db, counter))), Array(50).fill('LOCKED'));

  // The old write, for contrast: every request in the burst is checked and the count moves by one.
  const old = table(); let oldChecked = 0;
  await Promise.all(Array.from({ length: 200 }, async () => { const f = await old.authFactor.read(); oldChecked += 1; await null; old.row.attempts = f.attempts + 1; }));
  assert.equal(oldChecked, 200); assert.equal(old.row.attempts, 1);
});

test('an honest double submit of the right PIN goes through twice', async () => {
  const db = table();
  const submit = async () => {
    let f = await db.authFactor.read();
    let c = await claimPinAttempt(db, f);
    for (let i = 0; !c.ok && i < 2; i++) { f = await db.authFactor.read(); c = await claimPinAttempt(db, f); }
    if (!c.ok) return false;
    await null; db.row.attempts = 0; db.row.lockedUntil = null; // the right PIN resets the count
    return true;
  };
  assert.deepEqual(await Promise.all([submit(), submit()]), [true, true]);
  assert.equal(db.row.attempts, 0);
});

test('verifyPIN spends the attempt before it checks the PIN, and no stale count is written', () => {
  const body = src.slice(src.indexOf('export async function verifyPIN('), src.indexOf('export async function', src.indexOf('export async function verifyPIN(') + 10));
  const claim = body.indexOf('await claimPinAttempt(prisma, factor)');
  const check = body.indexOf('await verifyPINHash(');
  assert.ok(claim > -1 && check > -1 && claim < check, 'claim, then check');
  assert.ok(body.indexOf("if (!claim.ok)") < check, 'a request that could not claim checks nothing');
  assert.ok(!/authFactor\.attempts \+ 1|factor\.attempts \+ 1/.test(body), 'the count is never computed from a stale read inside verifyPIN');
  assert.match(body, /verifyPINHash\(factor\.secretHash, pin\)/, 'the hash checked is the row that was claimed');
  const fail = body.slice(body.indexOf('if (!isValid) {'), body.indexOf('// Reset attempts on successful verification'));
  assert.ok(!/authFactor\.update\(/.test(fail), 'a wrong PIN writes nothing more: the claim already did');
  assert.match(src, /where: \{ id: factor\.id, attempts: factor\.attempts, OR: \[\{ lockedUntil: null \}, \{ lockedUntil: \{ lte: now \} \}\] \}/);
});
