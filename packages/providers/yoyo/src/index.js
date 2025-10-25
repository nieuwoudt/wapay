import { requireEnv } from '@wapay/utils/src/index';
import { z } from 'zod';
import { request } from 'undici';
const TokenResponse = z.object({ token: z.string(), type: z.literal('WICODE') });
export class YoyoClient {
    base = requireEnv('YOYO_BASE_URL');
    clientId = requireEnv('YOYO_CLIENT_ID');
    clientSecret = requireEnv('YOYO_CLIENT_SECRET');
    merchantId = requireEnv('YOYO_MERCHANT_ID');
    headers() {
        return { 'Content-Type': 'application/json' };
    }
    // CVS Issuer / Gift issue
    async issueGift(accountRef, openingBalanceCents) {
        const url = `${this.base}/cvs/giftcards`;
        const body = { apiId: this.clientId, apiPassword: this.clientSecret, userRef: accountRef, balance: Math.round(openingBalanceCents / 100) };
        const res = await request(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), bodyTimeout: 10000, headersTimeout: 10000 });
        if (res.statusCode === 200 || res.statusCode === 201) {
            const data = (await res.body.json());
            return { yoyoAccountId: String(data.userRef ?? accountRef), cardId: String(data.giftcardId ?? data.id) };
        }
        if (res.statusCode === 401 || res.statusCode === 403)
            throw new Error('AUTH');
        throw new Error('RETRYABLE');
    }
    // CVS topup
    async topupGift(cardId, amountCents, idemKey) {
        const url = `${this.base}/cvs/giftcards/${encodeURIComponent(cardId)}/topup`;
        const body = { apiId: this.clientId, apiPassword: this.clientSecret, reference: idemKey, amount: Math.round(amountCents / 100) };
        for (let i = 1; i <= 3; i++) {
            try {
                const res = await request(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), bodyTimeout: 10000, headersTimeout: 10000 });
                if (res.statusCode === 200 || res.statusCode === 201) {
                    const data = (await res.body.json());
                    return { providerRef: String(data.reference || data.ref || idemKey) };
                }
                if (res.statusCode === 401 || res.statusCode === 403)
                    throw new Error('AUTH');
                if (res.statusCode === 400)
                    throw new Error('USER_INPUT');
                throw new Error('RETRYABLE');
            }
            catch (e) {
                if (e.message === 'AUTH' || e.message === 'USER_INPUT')
                    throw e;
                if (i === 3)
                    throw new Error('RETRYABLE');
                await new Promise((r) => setTimeout(r, 250 * i));
            }
        }
        throw new Error('RETRYABLE');
    }
    // CVS balance
    async giftBalance(cardId) {
        const url = `${this.base}/cvs/giftcards/${encodeURIComponent(cardId)}`;
        const res = await request(url, { method: 'GET', headers: this.headers(), bodyTimeout: 8000, headersTimeout: 8000 });
        if (res.statusCode === 200) {
            const data = (await res.body.json());
            return { balanceCents: Math.round((data.balance || 0) * 100) };
        }
        if (res.statusCode === 401 || res.statusCode === 403)
            throw new Error('AUTH');
        throw new Error('RETRYABLE');
    }
    // Token issuance for POS payments
    async issueTokenForGift({ accountId }) {
        const url = `${this.base}/token-manager/tokens`;
        const body = { apiId: this.clientId, apiPassword: this.clientSecret, userRef: accountId, type: 'GIFT' };
        const res = await request(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), bodyTimeout: 8000, headersTimeout: 8000 });
        if (res.statusCode === 200 || res.statusCode === 201) {
            const data = (await res.body.json());
            return TokenResponse.parse({ token: String(data.token || data.id || `WIC-${Date.now()}`), type: 'WICODE' });
        }
        if (res.statusCode === 401 || res.statusCode === 403)
            throw new Error('AUTH');
        throw new Error('RETRYABLE');
    }
    async isRetailerSupported(retailer) {
        const allow = ['checkers', 'shoprite', 'pick n pay', 'spar'];
        return allow.includes(retailer.toLowerCase());
    }
}
