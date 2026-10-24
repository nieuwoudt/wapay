import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  if (!prisma) {
    // Initialize Prisma with connection string
    // The pgbouncer=true parameter in DATABASE_URL tells Prisma to use simple queries
    // instead of prepared statements, which fixes serverless issues
    // Under `node --test` never the .env database (founder 2026-10-24; same guard as lib/prisma.js):
    // TEST_DATABASE_URL when one is named, otherwise a closed local port that refuses at once.
    const underTest = !!process.env.NODE_TEST_CONTEXT;
    const url = underTest
      ? String(process.env.TEST_DATABASE_URL || '').trim() || 'postgresql://wapay_tests@127.0.0.1:1/no_database'
      : process.env.DATABASE_URL;
    prisma = new PrismaClient({
      datasources: {
        db: {
          url,
        },
      },
    });
  }
  return prisma;
}


