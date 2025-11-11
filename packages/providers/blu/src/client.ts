import { maskVoucherPin, requireEnv } from '@wapay/utils';
import { request } from 'undici';

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
          return { providerRef: ref, amount_cents };
        }
        
        // Parse error response
        if (res.statusCode >= 400) {
          const errorData = (await res.body.json()) as any;
          const message = errorData.message || errorData.error || 'Unknown error';
          
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
        if (attempt === 3) throw new Error('RETRYABLE');
        await new Promise((r) => setTimeout(r, 500 * attempt)); // Exponential backoff
      }
    }
    throw new Error(`redeem failed for ${masked}`);
  }
}


