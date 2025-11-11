import { requireEnv } from '@wapay/utils';
import { z } from 'zod';
import { request } from 'undici';

const TokenResponse = z.object({ token: z.string(), type: z.literal('WICODE') });

export class YoyoClient {
  private base = requireEnv('YOYO_BASE_URL');
  private clientId = requireEnv('YOYO_CLIENT_ID');
  private clientSecret = requireEnv('YOYO_CLIENT_SECRET');
  private merchantId = requireEnv('YOYO_MERCHANT_ID');

  private headers() {
    return { 'Content-Type': 'application/json' } as Record<string, string>;
  }

  // CVS Issuer / Gift issue
  async issueGift(accountRef: string, openingBalanceCents: number): Promise<{ yoyoAccountId: string; cardId: string }>{
    const url = `${this.base}/cvs/giftcards`;
    const body = { apiId: this.clientId, apiPassword: this.clientSecret, userRef: accountRef, balance: Math.round(openingBalanceCents / 100) };
    const res = await request(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), bodyTimeout: 10000, headersTimeout: 10000 });
    if (res.statusCode === 200 || res.statusCode === 201) {
      const data = (await res.body.json()) as any;
      return { yoyoAccountId: String(data.userRef ?? accountRef), cardId: String(data.giftcardId ?? data.id) };
    }
    if (res.statusCode === 401 || res.statusCode === 403) throw new Error('AUTH');
    throw new Error('RETRYABLE');
  }

  // CVS topup
  async topupGift(cardId: string, amountCents: number, idemKey: string): Promise<{ providerRef: string }>{
    const url = `${this.base}/cvs/giftcards/${encodeURIComponent(cardId)}/topup`;
    const body = { apiId: this.clientId, apiPassword: this.clientSecret, reference: idemKey, amount: Math.round(amountCents / 100) };
    for (let i = 1; i <= 3; i++) {
      try {
        const res = await request(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), bodyTimeout: 10000, headersTimeout: 10000 });
        if (res.statusCode === 200 || res.statusCode === 201) {
          const data = (await res.body.json()) as any;
          return { providerRef: String(data.reference || data.ref || idemKey) };
        }
        if (res.statusCode === 401 || res.statusCode === 403) throw new Error('AUTH');
        if (res.statusCode === 400) throw new Error('USER_INPUT');
        throw new Error('RETRYABLE');
      } catch (e: any) {
        if (e.message === 'AUTH' || e.message === 'USER_INPUT') throw e;
        if (i === 3) throw new Error('RETRYABLE');
        await new Promise((r) => setTimeout(r, 250 * i));
      }
    }
    throw new Error('RETRYABLE');
  }

  // CVS balance
  async giftBalance(cardId: string): Promise<{ balanceCents: number }>{
    const url = `${this.base}/cvs/giftcards/${encodeURIComponent(cardId)}`;
    const res = await request(url, { method: 'GET', headers: this.headers(), bodyTimeout: 8000, headersTimeout: 8000 });
    if (res.statusCode === 200) {
      const data = (await res.body.json()) as any;
      return { balanceCents: Math.round((data.balance || 0) * 100) };
    }
    if (res.statusCode === 401 || res.statusCode === 403) throw new Error('AUTH');
    throw new Error('RETRYABLE');
  }

  // Token issuance for POS payments
  async issueTokenForGift({ accountId }: { accountId: string }): Promise<{ token: string; type: 'WICODE' }>{
    const url = `${this.base}/token-manager/tokens`;
    const body = { apiId: this.clientId, apiPassword: this.clientSecret, userRef: accountId, type: 'GIFT' };
    const res = await request(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), bodyTimeout: 8000, headersTimeout: 8000 });
    if (res.statusCode === 200 || res.statusCode === 201) {
      const data = (await res.body.json()) as any;
      return TokenResponse.parse({ token: String(data.token || data.id || `WIC-${Date.now()}`), type: 'WICODE' });
    }
    if (res.statusCode === 401 || res.statusCode === 403) throw new Error('AUTH');
    throw new Error('RETRYABLE');
  }

  async isRetailerSupported(retailer: string): Promise<boolean> {
    const allow = ['checkers', 'shoprite', 'pick n pay', 'spar'];
    return allow.includes(retailer.toLowerCase());
  }
}


