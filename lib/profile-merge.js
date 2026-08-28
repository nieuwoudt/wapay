/**
 * Atomic profile-JSON merges (review 2026-08-28: read-modify-write on the
 * whole profile column raced — a KYC webhook merge and a language write on
 * the next inbound message clobbered each other, and the backfill reverted
 * concurrent writes).
 *
 * These do the merge IN Postgres with jsonb `||`, so concurrent writers to
 * DIFFERENT keys never lose each other's updates. Account.profile is a
 * Prisma `Json?` → Postgres `jsonb` column on table "Account".
 *
 * Best-effort by design: a balance/menu surface must never fail on a
 * profile write. Callers that need the merged value re-read it.
 */

import prisma from './prisma.js';

/** Shallow-merge `patch` into profile top-level, atomically. */
export async function mergeProfileAtomic({ prisma: prismaClient = prisma, accountId, patch }) {
  if (!accountId || !patch || typeof patch !== 'object') return false;
  try {
    const json = JSON.stringify({ ...patch, updatedAt: new Date().toISOString() });
    await prismaClient.$executeRaw`
      UPDATE "Account"
      SET profile = coalesce(profile, '{}'::jsonb) || ${json}::jsonb
      WHERE id = ${accountId}`;
    return true;
  } catch (error) {
    console.error(JSON.stringify({ type: 'profile_merge_error', accountId, error: error?.message }));
    return false;
  }
}

/** Merge `patch` into profile.<key> (nested object), atomically. */
export async function mergeProfileSubkeyAtomic({ prisma: prismaClient = prisma, accountId, key, patch }) {
  if (!accountId || !key || !patch || typeof patch !== 'object') return false;
  try {
    const json = JSON.stringify(patch);
    // jsonb_set with create_missing=true; merge onto whatever is already there.
    await prismaClient.$executeRaw`
      UPDATE "Account"
      SET profile = jsonb_set(
        coalesce(profile, '{}'::jsonb),
        ${`{${key}}`}::text[],
        coalesce(profile -> ${key}, '{}'::jsonb) || ${json}::jsonb,
        true
      )
      WHERE id = ${accountId}`;
    return true;
  } catch (error) {
    console.error(JSON.stringify({ type: 'profile_subkey_merge_error', accountId, key, error: error?.message }));
    return false;
  }
}
