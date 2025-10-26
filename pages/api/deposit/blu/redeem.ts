import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { upsertProviderRequest, getCachedResponseByIdemKey } from '@wapay/domain/src/providerRequests';
import { BluClient } from '@wapay/providers-blu';
import { postBluDeposit, topupYoyoGift, ensureYoyoInstrument } from '@wapay/domain';
import { WhatsAppClient, Templates } from '@wapay/whatsapp';
import { env } from '@wapay/utils';

const redeemBody = z.object({
  pin: z.string().min(4),
  accountId: z.string().optional(),
  waId: z.string().optional(), // WhatsApp ID for sending notifications
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  try {
    // Validate request body
    const parse = redeemBody.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ 
        ok: false, 
        error: 'USER_INPUT', 
        details: parse.error.errors 
      });
    }

    const { pin, waId } = parse.data;
    const accountId = parse.data.accountId ?? 'stub-account';
    const idemKey = (req.headers['x-idempotency-key'] as string | undefined) ?? '';

    if (!idemKey) {
      return res.status(400).json({ ok: false, error: 'MISSING_IDEMPOTENCY' });
    }

    // Return cached response if available
    const cached = await getCachedResponseByIdemKey<{ 
      ok: boolean; 
      reference: string; 
      amount_cents: number 
    }>(idemKey);
    
    if (cached?.response) {
      return res.status(200).json(cached.response);
    }

    // Mark request as pending
    await upsertProviderRequest({ 
      idemKey, 
      provider: 'blu', 
      route: 'redeem', 
      status: 'PENDING' 
    });

    // Initialize WhatsApp client
    const whatsapp = new WhatsAppClient({
      accessToken: env.META_WHATSAPP_TOKEN,
      phoneNumberId: env.META_WHATSAPP_PHONE_NUMBER_ID,
    });

    try {
      // Redeem voucher via Blu
      const blu = new BluClient(
        env.BLU_BASE_URL,
        env.BLU_BASIC_USER,
        env.BLU_BASIC_PASS,
        env.BLU_API_KEY
      );
      const result = await blu.redeem(pin, idemKey);

      // Post to ledger and update wallet
      const { journalEntryId } = await postBluDeposit({ 
        accountId, 
        amountCents: result.amount_cents, 
        providerRef: result.providerRef, 
        idemKey 
      });

      // Optional wallet → Yoyo gift auto-top-up
      if (env.FEATURE_ENABLE_YOYO) {
        try {
          const yoyoInstrument = await ensureYoyoInstrument(accountId);
          await topupYoyoGift(
            accountId, 
            yoyoInstrument.yoyoAccountId, 
            result.amount_cents, 
            journalEntryId
          );
        } catch (e) {
          console.warn('Yoyo topup failed:', e);
        }
      }

      const response = { 
        ok: true, 
        reference: result.providerRef, 
        amount_cents: result.amount_cents 
      } as const;

      // Store successful response
      await upsertProviderRequest({
        idemKey,
        provider: 'blu',
        route: 'redeem',
        status: 'SUCCESS',
        providerRef: result.providerRef,
        redactedPayload: 'pin=****',
        responseJson: JSON.stringify(response),
      });

      // Send WhatsApp receipt notification
      if (waId) {
        try {
          await whatsapp.sendTemplate(
            Templates.depositReceipt(waId, result.amount_cents, result.providerRef)
          );
          console.log('WhatsApp receipt sent:', { waId, reference: result.providerRef });
        } catch (whatsappErr: any) {
          console.error('Failed to send WhatsApp receipt:', whatsappErr);
          // Don't fail the deposit if WhatsApp fails
        }
      }

      return res.status(200).json(response);

    } catch (err: any) {
      await upsertProviderRequest({ 
        idemKey, 
        provider: 'blu', 
        route: 'redeem', 
        status: 'FAILED' 
      });

      // Send WhatsApp failure notification
      if (waId) {
        try {
          const reason = err?.message === 'USER_INPUT'
            ? 'Invalid voucher PIN'
            : 'Voucher redemption failed. Please try again.';
          await whatsapp.sendTemplate(Templates.depositFailed(waId, reason));
          console.log('WhatsApp failure notification sent:', { waId });
        } catch (whatsappErr: any) {
          console.error('Failed to send WhatsApp failure notification:', whatsappErr);
        }
      }

      const code = err?.message;
      if (code === 'USER_INPUT') {
        return res.status(400).json({ ok: false, error: 'USER_INPUT' });
      }
      if (code === 'AUTH') {
        return res.status(502).json({ ok: false, error: 'AUTH' });
      }
      return res.status(502).json({ ok: false, error: 'RETRYABLE' });
    }

  } catch (error: any) {
    console.error('Unexpected error in deposit/blu/redeem:', error);
    return res.status(500).json({ 
      ok: false, 
      error: 'INTERNAL_ERROR',
      message: error.message 
    });
  }
}

