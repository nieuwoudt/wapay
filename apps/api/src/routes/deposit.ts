import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { upsertProviderRequest, getCachedResponseByIdemKey } from '@wapay/domain/src/providerRequests';
import { BluClient } from '@wapay/providers-blu';
import { postBluDeposit, topupYoyoGift, ensureYoyoInstrument } from '@wapay/domain';

const redeemBody = z.object({ pin: z.string().min(4), accountId: z.string().optional() });

export async function registerDepositRoutes(app: FastifyInstance) {
  app.post('/deposit/blu/redeem', async (req, reply) => {
    const parse = redeemBody.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ ok: false, error: 'USER_INPUT', details: parse.error.errors });
    }
    const { pin } = parse.data;
    const accountId = parse.data.accountId ?? 'stub-account';
    const idemKey = (req.headers['x-idempotency-key'] as string | undefined) ?? '';
    if (!idemKey) return reply.code(400).send({ ok: false, error: 'MISSING_IDEMPOTENCY' });

    // Return cached response if available
    const cached = await getCachedResponseByIdemKey<{ ok: boolean; reference: string; amount_cents: number }>(idemKey);
    if (cached?.response) {
      return reply.send(cached.response);
    }

    await upsertProviderRequest({ idemKey, provider: 'blu', route: 'redeem', status: 'PENDING' });

    try {
      const blu = new BluClient();
      const result = await blu.redeem(pin, idemKey);

      // Post to ledger and update wallet
      const { journalEntryId } = await postBluDeposit({ accountId, amountCents: result.amount_cents, providerRef: result.providerRef, idemKey });

      // Optional wallet → Yoyo gift auto-top-up
      if (process.env.FEATURE_ENABLE_YOYO === 'true') {
        try {
          const yoyoInstrument = await ensureYoyoInstrument(accountId);
          await topupYoyoGift(accountId, yoyoInstrument.yoyoAccountId, result.amount_cents, journalEntryId);
        } catch (e) {
          app.log.warn({ err: e }, 'yoyo topup failed');
        }
      }

      const response = { ok: true, reference: result.providerRef, amount_cents: result.amount_cents } as const;

      await upsertProviderRequest({
        idemKey,
        provider: 'blu',
        route: 'redeem',
        status: 'SUCCESS',
        providerRef: result.providerRef,
        redactedPayload: 'pin=****',
        responseJson: response,
      });

      return reply.send(response);
    } catch (err: any) {
      await upsertProviderRequest({ idemKey, provider: 'blu', route: 'redeem', status: 'FAILED' });
      const code = err?.message;
      if (code === 'USER_INPUT') return reply.code(400).send({ ok: false, error: 'USER_INPUT' });
      if (code === 'AUTH') return reply.code(502).send({ ok: false, error: 'AUTH' });
      return reply.code(502).send({ ok: false, error: 'RETRYABLE' });
    }
  });
}


