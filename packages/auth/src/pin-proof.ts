/**
 * The PIN proof (BUGLOG #112; founder 2026-10-16: safeguards so that no one
 * can move money out of a customer's account without them).
 *
 * Money leaves a customer's balance for the outside world only with a proof
 * that THIS customer typed THEIR PIN for THIS withdrawal, moments ago:
 *
 *   - verifyPIN (pin.ts) issues it, and only on a correct PIN, and only when
 *     told what the PIN approves ({ intentId, amountCents });
 *   - executeWithdraw (lib/payout-chat.js) verifies it before it reads a
 *     saved destination, and requestPayout (lib/payouts.js), the one door
 *     to the rail for every caller, verifies it again before it writes a
 *     row, moves a cent, reserves a hold or calls the rail;
 *   - the business portal's step-up (password or one-time code) issues the
 *     same proof for the owner's wallet ('STEP_UP');
 *   - it is bound to the account, the withdrawal's intent id and the exact
 *     amount, and lives two minutes: a proof for R50 never executes R500,
 *     and a proof for one withdrawal never executes another;
 *   - single use: the intent id it is bound to executes at most once
 *     (requestPayout is idempotent on the intent id, one PerformPayout per
 *     intent, ever);
 *   - keyed by a deployment secret with NO default in source: no secret, no
 *     proof, no withdrawal (fail closed).
 *
 * tests/money-out-safeguards.test.mjs fails the build if anything other than
 * verifyPIN issues a proof, or if executeWithdraw stops checking one.
 */

import crypto from 'node:crypto';

export const PIN_PROOF_TTL_MS = 120_000;

function proofKey(): Buffer | null {
  const secret = process.env.WAPAY_PIN_PROOF_SECRET || process.env.PIN_PEPPER || process.env.WAPAY_INTERNAL_API_KEY;
  return secret ? crypto.createHash('sha256').update(`wapay-pin-proof:v1:${secret}`).digest() : null;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function sign(payload: string, key: Buffer): string {
  return b64(crypto.createHmac('sha256', key).update(payload).digest());
}

export interface PinApproval {
  intentId: string;
  amountCents: number;
}

/**
 * Issue a proof. Called by verifyPIN after a correct PIN ('PIN'), and by
 * the business portal's step-up after a correct password or one-time code
 * ('STEP_UP', lib/business-auth.js verifyStepUp), nowhere else.
 * Returns null when no secret is configured or the approval is malformed.
 */
export function issuePinProof(args: { accountId: string; intentId: string; amountCents: number; via?: 'PIN' | 'STEP_UP'; now?: number }): string | null {
  const key = proofKey();
  const { accountId, intentId, amountCents } = args;
  if (!key || !accountId || !intentId || !Number.isInteger(amountCents) || amountCents <= 0) return null;
  const body = JSON.stringify({ a: accountId, i: String(intentId), c: amountCents, v: args.via || 'PIN', t: args.now ?? Date.now(), n: crypto.randomBytes(9).toString('base64url') });
  const payload = b64(body);
  return `${payload}.${sign(payload, key)}`;
}

/** Check a proof against what is about to be executed. Never throws. */
export function verifyPinProof(
  proof: unknown,
  expect: { accountId: string; intentId: string; amountCents: number; now?: number }
): { ok: true; via: string } | { ok: false; reason: string } {
  const key = proofKey();
  if (!key) return { ok: false, reason: 'NO_SECRET' };
  if (typeof proof !== 'string' || !proof.includes('.')) return { ok: false, reason: 'MISSING' };
  const [payload, sig] = proof.split('.');
  const want = sign(payload, key);
  const a = Buffer.from(sig || '');
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'BAD_SIGNATURE' };
  let body: { a?: string; i?: string; c?: number; v?: string; t?: number };
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  const now = expect.now ?? Date.now();
  if (body.a !== expect.accountId) return { ok: false, reason: 'WRONG_ACCOUNT' };
  if (body.i !== String(expect.intentId)) return { ok: false, reason: 'WRONG_INTENT' };
  if (body.c !== expect.amountCents) return { ok: false, reason: 'WRONG_AMOUNT' };
  if (typeof body.t !== 'number' || now - body.t > PIN_PROOF_TTL_MS || body.t - now > 5_000) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, via: body.v || 'PIN' };
}
