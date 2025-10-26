import Fastify from 'fastify';
import idempotencyPlugin from '../apps/api/src/plugins/idempotency';
import { registerDepositRoutes } from '../apps/api/src/routes/deposit';
import { registerYoyoRoutes } from '../apps/api/src/routes/yoyo';

let app: any = null;

async function build() {
  if (app) return app;
  
  app = Fastify({ logger: true });
  
  // Register plugins and routes
  await app.register(idempotencyPlugin);
  await registerDepositRoutes(app);
  await registerYoyoRoutes(app);
  
  app.get('/health', async () => ({ ok: true }));
  
  await app.ready();
  return app;
}

// Export for Vercel serverless
export default async (req: any, res: any) => {
  const fastify = await build();
  fastify.server.emit('request', req, res);
};

