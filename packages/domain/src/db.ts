import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  if (!prisma) {
    // Check if we're using pgbouncer (connection pooling)
    const isPgBouncer = process.env.DATABASE_URL?.includes('pgbouncer=true');
    
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: process.env.DATABASE_URL,
        },
      },
      // Use simple query mode for pgbouncer/direct connections to avoid prepared statement issues
      ...(isPgBouncer && {
        // @ts-ignore - This is a valid Prisma option for connection pooling
        __internal: {
          engine: {
            protocol: 'graphql',
          },
        },
      }),
    });
  }
  return prisma;
}


