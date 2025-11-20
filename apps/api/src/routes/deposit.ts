import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { upsertProviderRequest, getCachedResponseByIdemKey } from '@wapay/domain/src/providerRequests';
import { BluClient, resolveBluVoucherAmountCents } from '@wapay/providers-blu';
import { postBluDeposit, topupYoyoGift, ensureYoyoInstrument } from '@wapay/domain';
import { WhatsAppClient, Templates } from '@wapay/whatsapp';
import { env } from '@wapay/utils';

const redeemBody = z.object({ 
  pin: z.string().min(4), 
  amountCents: z.number().int().positive().optional(), // Amount in cents (optional - resolved internally if not provided)
  accountId: z.string().optional(),
  waId: z.string().optional() // WhatsApp ID for sending notifications
});

// Initialize WhatsApp client
const whatsapp = new WhatsAppClient({
  accessToken: env.META_WHATSAPP_TOKEN,
  phoneNumberId: env.META_WHATSAPP_PHONE_NUMBER_ID,
});

export async function registerDepositRoutes(app: FastifyInstance) {
  app.post('/deposit/blu/redeem', async (req, reply) => {
    const parse = redeemBody.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ ok: false, error: 'USER_INPUT', details: parse.error.errors });
    }
    const { pin, waId } = parse.data;
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
      
      // Resolve amount internally (temporary until Blu clarifies correct pattern)
      const amountCents = parse.data.amountCents ?? resolveBluVoucherAmountCents(pin);
      const result = await blu.redeem(pin, idemKey, amountCents);

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

      // Send WhatsApp receipt notification
      if (waId) {
        try {
          await whatsapp.sendTemplate(
            Templates.depositReceipt(waId, result.amount_cents, result.providerRef)
          );
          app.log.info({ waId, reference: result.providerRef }, 'WhatsApp receipt sent');
        } catch (whatsappErr: any) {
          app.log.error({ err: whatsappErr, waId }, 'Failed to send WhatsApp receipt');
          // Don't fail the deposit if WhatsApp fails
        }
      }

      return reply.send(response);
    } catch (err: any) {
      await upsertProviderRequest({ idemKey, provider: 'blu', route: 'redeem', status: 'FAILED' });
      
      // Send WhatsApp failure notification
      if (waId) {
        try {
          const reason = err?.message === 'USER_INPUT' 
            ? 'Invalid voucher PIN' 
            : 'Voucher redemption failed. Please try again.';
          await whatsapp.sendTemplate(Templates.depositFailed(waId, reason));
          app.log.info({ waId }, 'WhatsApp failure notification sent');
        } catch (whatsappErr: any) {
          app.log.error({ err: whatsappErr, waId }, 'Failed to send WhatsApp failure notification');
        }
      }

      const code = err?.message;
      if (code === 'USER_INPUT') return reply.code(400).send({ ok: false, error: 'USER_INPUT' });
      if (code === 'AUTH') return reply.code(502).send({ ok: false, error: 'AUTH' });
      return reply.code(502).send({ ok: false, error: 'RETRYABLE' });
    }
  });
}


