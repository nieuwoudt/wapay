import Fastify from 'fastify';
import idempotencyPlugin from '../apps/api/src/plugins/idempotency';
import { registerDepositRoutes } from '../apps/api/src/routes/deposit';
import { registerYoyoRoutes } from '../apps/api/src/routes/yoyo';

const app = Fastify({ logger: true });

// Register plugins and routes
await app.register(idempotencyPlugin);
await registerDepositRoutes(app);
await registerYoyoRoutes(app);

app.get('/health', async () => ({ ok: true }));

// Export for Vercel serverless
export default async (req: any, res: any) => {
  await app.ready();
  app.server.emit('request', req, res);
};

