/**
 * Prisma Client Singleton
 */

import { PrismaClient } from '@prisma/client';

// Tests never reach a real database unless one is named for them (founder 2026-10-24). Prisma loads
// the project's .env by itself, and the fast copy's .env holds PRODUCTION, so under `node --test`
// (which marks every test process with NODE_TEST_CONTEXT) the client is pointed at TEST_DATABASE_URL,
// or at a closed local port that refuses at once. packages/domain/src/db.ts carries the same guard.
export const NO_TEST_DATABASE_URL = 'postgresql://wapay_tests@127.0.0.1:1/no_database';
export function testDatabaseUrl(env = process.env) {
  if (!env.NODE_TEST_CONTEXT) return null;
  return String(env.TEST_DATABASE_URL || '').trim() || NO_TEST_DATABASE_URL;
}
const testUrl = testDatabaseUrl();
const options = testUrl ? { datasources: { db: { url: testUrl } } } : undefined;

let prisma;

if (process.env.NODE_ENV === 'production') {
  prisma = new PrismaClient(options);
} else {
  // In development, use a global variable to prevent multiple instances
  if (!global.prisma) {
    global.prisma = new PrismaClient(options);
  }
  prisma = global.prisma;
}

export default prisma;

