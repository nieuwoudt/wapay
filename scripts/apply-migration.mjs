/**
 * Apply ONE idempotent migration folder to the DATABASE_URL target, statement
 * by statement inside a transaction, then read back the catalog for the tables
 * it names. `prisma migrate deploy` does not work on this (unbaselined)
 * database — CLAUDE.md: migrations are applied as raw SQL over the session
 * pooler — and Prisma cannot run a multi-statement script in one call, so this
 * splits on `;` and skips BEGIN/COMMIT (the transaction wraps everything).
 *
 *   node --env-file=.env scripts/apply-migration.mjs 20260904_business
 *
 * Only migrations written to be idempotent (IF NOT EXISTS / ADD COLUMN IF NOT
 * EXISTS) belong here. Re-running is safe by construction.
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const name = process.argv[2];
if (!name || !/^[0-9]{8}_[a-z0-9_]+$/.test(name)) {
  console.error('Usage: node --env-file=.env scripts/apply-migration.mjs <YYYYMMDD_name>');
  process.exit(1);
}
const sql = readFileSync(new URL(`../packages/domain/prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8');
const statements = sql
  .split(/;\s*\n/)
  .map((s) => s.replace(/^\s*--[^\n]*\n?/gm, '').trim())
  .filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));
const tables = [...new Set([...sql.matchAll(/(?:CREATE TABLE IF NOT EXISTS|ALTER TABLE)\s+"([^"]+)"/g)].map((m) => m[1]))];
const schema = (process.env.DATABASE_URL || '').match(/schema=([a-z0-9_]+)/)?.[1] || 'public';

const prisma = new PrismaClient();
console.log(`applying ${name} → schema "${schema}" · ${statements.length} statements`);
// The pooler adds latency per statement; the default 5s interactive-transaction
// budget is too tight for a dozen DDL statements (seen 2026-09-04).
await prisma.$transaction(async (tx) => {
  for (const st of statements) await tx.$executeRawUnsafe(st);
}, { timeout: 120000, maxWait: 30000 });
for (const t of tables) {
  const cols = await prisma.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
    t
  );
  console.log(`${t}: ${cols.map((c) => c.column_name).join(', ') || 'MISSING'}`);
}
await prisma.$disconnect();
console.log('done');
