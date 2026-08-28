/**
 * One-time backfill: stamp profile.acquisitionSource on accounts that predate
 * the stamping (2026-08-28). Money-backed rule, same as creation-time: a
 * number that appears as a captured pay-link payer = 'paylink', else
 * 'organic'. MERGES into profile (never clobbers existing keys), skips
 * accounts already stamped.
 *
 * Run: node --env-file=.env scripts/backfill-acquisition.mjs
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const accounts = await prisma.account.findMany({
  select: { id: true, waId: true, msisdn: true, profile: true },
});

let stamped = 0;
for (const a of accounts) {
  const profile = a.profile && typeof a.profile === 'object' ? a.profile : {};
  if (profile.acquisitionSource) continue;
  const local = String(a.waId || a.msisdn || '').replace(/^27/, '0');
  const paid = local
    ? await prisma.providerRequest.findFirst({
        where: { provider: 'PAYFAST', metadata: { path: ['payerMsisdn'], equals: local } },
        select: { id: true },
      })
    : null;
  const acquisitionSource = paid ? 'paylink' : 'organic';
  // ATOMIC merge — do NOT read-modify-write the whole profile column, which
  // would revert any live profile write (language, kyc) between the snapshot
  // above and this update (review 2026-08-28).
  const patch = JSON.stringify({ acquisitionSource });
  await prisma.$executeRaw`
    UPDATE "Account"
    SET profile = coalesce(profile, '{}'::jsonb) || ${patch}::jsonb
    WHERE id = ${a.id} AND (profile -> 'acquisitionSource') IS NULL`;
  console.log(`stamped ${a.waId}: ${acquisitionSource}`);
  stamped += 1;
}
console.log(`done — ${stamped}/${accounts.length} stamped`);
await prisma.$disconnect();
