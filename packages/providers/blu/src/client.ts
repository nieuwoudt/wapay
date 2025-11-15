import { maskVoucherPin, requireEnv } from '@wapay/utils';
import { request } from 'undici';

type BluErrorPayload = {
  message?: string;
  error?: string | { message?: string };
  errors?: Array<{ message?: string; detail?: string; description?: string }>;
  reason?: string;
  description?: string;
  detail?: string;
};

export class BluClient {
  private base = requireEnv('BLU_BASE_URL');
  private user = requireEnv('BLU_BASIC_USER');
  private pass = requireEnv('BLU_BASIC_PASS');
  private apiKey = process.env.BLU_API_KEY; // Optional - may not be required

  private headers() {
    const basic = Buffer.from(`${this.user}:${this.pass}`).toString('base64');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Basic ${basic}`,
    };
    
    // Only add apikey header if provided (may be optional)
    if (this.apiKey) {
      headers.apikey = this.apiKey;
    }
    
    return headers;
  }

  async checkStatus(pin: string): Promise<{ status: 'ACTIVE' | 'USED' | 'EXPIRED' | 'UNKNOWN'; amount_cents?: number }> {
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
        const data = (await res.body.json()) as any;
        // map provider fields → normalized
        const status = (data.status as string)?.toUpperCase();
        const map: Record<string, 'ACTIVE' | 'USED' | 'EXPIRED' | 'UNKNOWN'> = {
          ACTIVE: 'ACTIVE',
          VALID: 'ACTIVE',
          USED: 'USED',
          EXPIRED: 'EXPIRED',
        };
        return { status: map[status] ?? 'UNKNOWN', amount_cents: Math.round((data.amount || 0) * 100) };
      }
      if (res.statusCode === 401 || res.statusCode === 403) throw new Error('AUTH');
      if (res.statusCode === 400) return { status: 'UNKNOWN' };
      throw new Error('RETRYABLE');
    } catch (e: any) {
      if (e.message === 'AUTH') throw e;
      throw new Error('RETRYABLE');
    }
  }

  private extractErrorMessage(payload: BluErrorPayload | undefined, statusCode: number): string {
    if (!payload) return `Blu returned HTTP ${statusCode}`;
    const candidates = [
      payload.reason,
      typeof payload.error === 'string' ? payload.error : payload.error?.message,
      payload.message,
      payload.description,
      payload.detail,
      payload.errors?.map((err) => err?.message || err?.detail || err?.description).filter(Boolean).join(' · '),
    ].filter(Boolean);
    return candidates[0] || `Blu returned HTTP ${statusCode}`;
  }

  async redeem(pin: string, idemKey: string): Promise<{ providerRef: string; amount_cents: number }> {
    const url = `${this.base}/voucher/variable/redemptions`;
    const body = {
      requestId: idemKey,
      token: pin,
      amount: 0, // 0 = redeem full voucher balance
    };
    const masked = maskVoucherPin(pin);
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log('[Blu] Redeem request', { requestId: idemKey, pin: masked, attempt });
        const res = await request(url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          bodyTimeout: 30000, // Blu recommends 60s timeout
          headersTimeout: 30000,
        });
        
        // Success: 201 Created
        if (res.statusCode === 201 || res.statusCode === 200) {
          const data = (await res.body.json()) as any;
          const ref = String(data.reference || `BLU-${Date.now()}`);
          const amount_cents = data.amount; // Blu returns amount in cents
          console.log('[Blu] Redeem success', { requestId: idemKey, pin: masked, amount_cents, ref });
          return { providerRef: ref, amount_cents };
        }
        
        // Parse error response
        if (res.statusCode >= 400) {
          const errorData = (await res.body.json()) as BluErrorPayload;
          const message = this.extractErrorMessage(errorData, res.statusCode);
          console.error('[Blu] Redeem error response', {
            requestId: idemKey,
            pin: masked,
            status: res.statusCode,
            message,
            raw: errorData,
          });
          
          // User input errors (400, 404, 409)
          if (res.statusCode === 400 || res.statusCode === 404 || res.statusCode === 409) {
            const err = new Error('USER_INPUT');
            (err as any).reason = message;
            throw err;
          }
          
          // Auth errors
          if (res.statusCode === 401 || res.statusCode === 403) {
            const err = new Error('AUTH');
            (err as any).reason = message;
            throw err;
          }
          
          // Server errors (500, 502, 503) - retryable
          throw new Error('RETRYABLE');
        }
        
        throw new Error('RETRYABLE');
      } catch (e: any) {
        if (e.message === 'USER_INPUT' || e.message === 'AUTH') throw e;
        console.error('[Blu] Redeem attempt failed', {
          requestId: idemKey,
          pin: masked,
          attempt,
          error: e?.message || e,
        });
        if (attempt === 3) throw new Error('RETRYABLE');
        await new Promise((r) => setTimeout(r, 500 * attempt)); // Exponential backoff
      }
    }
    throw new Error(`redeem failed for ${masked}`);
  }
}


