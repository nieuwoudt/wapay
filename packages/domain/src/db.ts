import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  if (!prisma) {
    // Initialize Prisma with connection string
    // The pgbouncer=true parameter in DATABASE_URL tells Prisma to use simple queries
    // instead of prepared statements, which fixes serverless issues
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: process.env.DATABASE_URL,
        },
      },
    });
  }
  return prisma;
}


