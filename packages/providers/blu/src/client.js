import { maskVoucherPin, requireEnv } from '@wapay/utils/src/index';
import { request } from 'undici';
export class BluClient {
    base = requireEnv('BLU_BASE_URL');
    user = requireEnv('BLU_BASIC_USER');
    pass = requireEnv('BLU_BASIC_PASS');
    apiKey = requireEnv('BLU_API_KEY');
    headers() {
        const basic = Buffer.from(`${this.user}:${this.pass}`).toString('base64');
        return {
            'Content-Type': 'application/json',
            Authorization: `Basic ${basic}`,
            'X-API-Key': this.apiKey,
        };
    }
    async checkStatus(pin) {
        const url = `${this.base}/voucher/status`;
        try {
            const res = await request(url, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({ pin }),
                bodyTimeout: 8000,
                headersTimeout: 8000,
            });
            if (res.statusCode === 200) {
                const data = (await res.body.json());
                // map provider fields → normalized
                const status = data.status?.toUpperCase();
                const map = {
                    ACTIVE: 'ACTIVE',
                    VALID: 'ACTIVE',
                    USED: 'USED',
                    EXPIRED: 'EXPIRED',
                };
                return { status: map[status] ?? 'UNKNOWN', amount_cents: Math.round((data.amount || 0) * 100) };
            }
            if (res.statusCode === 401 || res.statusCode === 403)
                throw new Error('AUTH');
            if (res.statusCode === 400)
                return { status: 'UNKNOWN' };
            throw new Error('RETRYABLE');
        }
        catch (e) {
            if (e.message === 'AUTH')
                throw e;
            throw new Error('RETRYABLE');
        }
    }
    async redeem(pin, idemKey) {
        const url = `${this.base}/voucher/redeem`;
        const body = { pin, client_reference: idemKey };
        const masked = maskVoucherPin(pin);
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const res = await request(url, {
                    method: 'POST',
                    headers: this.headers(),
                    body: JSON.stringify(body),
                    bodyTimeout: 10000,
                    headersTimeout: 10000,
                });
                if (res.statusCode === 200) {
                    const data = (await res.body.json());
                    const ref = String(data.reference || data.ref || `BLU-${Date.now()}`);
                    const amount_cents = data.amount_cents ?? Math.round((data.amount || 0) * 100);
                    return { providerRef: ref, amount_cents };
                }
                if (res.statusCode === 400) {
                    const err = new Error('USER_INPUT');
                    err.reason = 'Invalid or used voucher';
                    throw err;
                }
                if (res.statusCode === 401 || res.statusCode === 403)
                    throw new Error('AUTH');
                // fallthrough for retryable
                throw new Error('RETRYABLE');
            }
            catch (e) {
                if (e.message === 'USER_INPUT' || e.message === 'AUTH')
                    throw e;
                if (attempt === 3)
                    throw new Error('RETRYABLE');
                await new Promise((r) => setTimeout(r, 250 * attempt));
            }
        }
        // unreachable
        throw new Error(`redeem failed for ${masked}`);
    }
}
