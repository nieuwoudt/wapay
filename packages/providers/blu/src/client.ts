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

export type BluVoucherStatus = {
  status: 'ACTIVE' | 'USED' | 'EXPIRED' | 'UNKNOWN';
  amount_cents?: number;
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

  async checkStatus(pin: string): Promise<BluVoucherStatus> {
    // Blu Swagger: GET /voucher/variable/vouchers?token={pin}
    const url = `${this.base}/voucher/variable/vouchers?token=${encodeURIComponent(pin)}`;
    try {
      const res = await request(url, {
        method: 'GET',
        headers: this.headers(),
        bodyTimeout: 8000,
        headersTimeout: 8000,
      });
      
      if (res.statusCode === 200) {
        const data = (await res.body.json()) as any;
        console.log('[Blu] Status check success', { pin: maskVoucherPin(pin), status: data.status, amount: data.amount });
        
        // Map provider status strings to normalized values
        const status = (data.status as string)?.toUpperCase();
        const map: Record<string, 'ACTIVE' | 'USED' | 'EXPIRED' | 'UNKNOWN'> = {
          ACTIVE: 'ACTIVE',
          VALID: 'ACTIVE',
          USED: 'USED',
          REDEEMED: 'USED',
          EXPIRED: 'EXPIRED',
        };
        
        // Blu returns amount in cents according to docs
        const amount_cents = typeof data.amount === 'number' ? data.amount : undefined;
        
        return { 
          status: map[status] ?? 'UNKNOWN', 
          amount_cents 
        };
      }
      
      // Log full error response for debugging
      const errorBody = await res.body.text();
      console.error('[Blu] Status check failed', {
        pin: maskVoucherPin(pin),
        status: res.statusCode,
        body: errorBody,
      });
      
      if (res.statusCode === 401 || res.statusCode === 403) throw new Error('AUTH');
      if (res.statusCode === 400 || res.statusCode === 404) return { status: 'UNKNOWN' };
      throw new Error('RETRYABLE');
    } catch (e: any) {
      if (e.message === 'AUTH') throw e;
      console.error('[Blu] Status check error', { pin: maskVoucherPin(pin), error: e.message });
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

  async redeem(pin: string, idemKey: string, amountCents: number): Promise<{ providerRef: string; amount_cents: number }> {
    // Validate required amountCents parameter
    if (typeof amountCents !== 'number' || amountCents <= 0) {
      throw new Error('amountCents required for Blu variable voucher redemption');
    }
    
    // Blu Swagger: POST /voucher/variable/redemptions
    // Body: { requestId, token, amount (in cents) }
    const url = `${this.base}/voucher/variable/redemptions`;
    const body = {
      requestId: idemKey,
      token: pin,
      amount: amountCents, // Blu expects amount in cents
    };
    const masked = maskVoucherPin(pin);
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log('[Blu] Redeem request', { 
          requestId: idemKey, 
          pin: masked, 
          amountCents, 
          attempt 
        });
        
        const res = await request(url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          bodyTimeout: 30000,
          headersTimeout: 30000,
        });
        
        // Success: 201 Created or 200 OK
        if (res.statusCode === 201 || res.statusCode === 200) {
          const data = (await res.body.json()) as any;
          
          // Blu response fields per Swagger:
          // - reference: unique transaction reference (our providerRef)
          // - amount: retail amount in cents including VAT
          const providerRef = String(data.reference || `BLU-${Date.now()}`);
          const amount_cents = typeof data.amount === 'number' ? data.amount : amountCents;
          
          console.log('[Blu] Redeem success', { 
            requestId: idemKey, 
            pin: masked, 
            amount_cents, 
            providerRef 
          });
          
          return { providerRef, amount_cents };
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

  // TODO: implement once we wire Blu issuance
  async issueVoucher(params: { amount_cents: number; idemKey: string }): Promise<{ providerRef: string; amount_cents: number }> {
    throw new Error('Blu voucher issuance not implemented yet');
  }
}


