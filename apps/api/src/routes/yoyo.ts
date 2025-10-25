import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { YoyoClient } from '@wapay/providers-yoyo';

const retailerQuery = z.object({ retailer: z.string().min(2) });

export async function registerYoyoRoutes(app: FastifyInstance) {
  app.get('/yoyo/eligible', async (req, reply) => {
    const parse = retailerQuery.safeParse(req.query);
    if (!parse.success) return reply.code(400).send({ ok: false, error: 'USER_INPUT' });
    const { retailer } = parse.data;
    const isOn = process.env.FEATURE_ENABLE_YOYO === 'true';
    if (!isOn) return reply.code(404).send({ ok: false });
    const yoyo = new YoyoClient();
    const supported = await yoyo.isRetailerSupported(retailer);
    return reply.send({ ok: true, supported });
  });

  app.post('/yoyo/token/issue', async (req, reply) => {
    const isOn = process.env.FEATURE_ENABLE_YOYO === 'true';
    if (!isOn) return reply.code(404).send({ ok: false });
    // TODO: bind to authenticated account in session
    const accountId = 'stub-account';
    const yoyo = new YoyoClient();
    const token = await yoyo.issueTokenForGift({ accountId });
    return reply.send({ ok: true, token });
  });
}


