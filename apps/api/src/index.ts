import Fastify from 'fastify';
import idempotencyPlugin from './plugins/idempotency';
import { registerDepositRoutes } from './routes/deposit';
import { registerYoyoRoutes } from './routes/yoyo';

const app = Fastify({ logger: true });
await app.register(idempotencyPlugin);
await registerDepositRoutes(app);
await registerYoyoRoutes(app);

app.get('/health', async () => ({ ok: true }));

const port = Number(process.env.PORT || 3000);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => {
    app.log.info(`api listening on ${port}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });


