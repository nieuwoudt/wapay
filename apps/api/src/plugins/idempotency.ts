import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getPrisma } from '@wapay/domain/src/db';

declare module 'fastify' {
  interface FastifyRequest {
    idemKey?: string;
  }
}

export default fp(async function idempotencyPlugin(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    const key = req.headers['x-idempotency-key'];
    if (typeof key !== 'string') return;
    req.idemKey = key;
    // Optionally, check if request already exists for read-fast path
    const prisma = getPrisma();
    const existing = await prisma.providerRequest.findUnique({ where: { idemKey: key } });
    if (existing && existing.providerRef) {
      // We only short-circuit here for routes that implement retrieval by idemKey
      // Actual handlers will decide whether to return cached responses
      req.headers['x-wapay-idem-hit'] = '1';
    }
  });
});


