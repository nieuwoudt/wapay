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
  private apiKey = process.env.BLU_API_KEY;
  private vendChannel = process.env.BLU_VEND_CHANNEL || 'API';

  constructor() {
    console.log('[Blu] Initialized with base URL:', this.base, 'vendChannel:', this.vendChannel);
  }

  private headers(extra: Record<string, string> = {}) {
    const basic = Buffer.from(`${this.user}:${this.pass}`).toString('base64');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Basic ${basic}`,
      'Trade-Vend-Channel': this.vendChannel,
      ...extra,
    };
    
    if (this.apiKey) {
      headers.apikey = this.apiKey;
    }
    
    return headers;
  }

  async checkStatus(pin: string): Promise<BluVoucherStatus> {
    // Blu Swagger: GET /voucher/variable/vouchers?token={PIN}
    const url = `${this.base}/voucher/variable/vouchers?token=${encodeURIComponent(pin)}`;

    try {
      console.log('[Blu] Status check request', {
        url,
        method: 'GET',
        pin: maskVoucherPin(pin),
      });

      const res = await request(url, {
        method: 'GET',
        headers: this.headers(),
        bodyTimeout: 8000,
        headersTimeout: 8000,
      });

      if (res.statusCode === 200) {
        const data = (await res.body.json()) as any;

        console.log('[Blu] Status check success', {
          pin: maskVoucherPin(pin),
          status: data.status,
          amount: data.amount,
        });

        const statusRaw = (data.status as string | undefined)?.toUpperCase() || '';
        const map: Record<string, BluVoucherStatus['status']> = {
          ACTIVE: 'ACTIVE',
          VALID: 'ACTIVE',
          USED: 'USED',
          REDEEMED: 'USED',
          EXPIRED: 'EXPIRED',
        };

        const amount_cents = typeof data.amount === 'number' ? data.amount : undefined;

        return {
          status: map[statusRaw] ?? 'UNKNOWN',
          amount_cents,
        };
      }

      let errorBody: any;
      try {
        errorBody = await res.body.json();
      } catch {
        errorBody = await res.body.text();
      }

      console.error('[Blu] Status check failed', {
        url,
        method: 'GET',
        pin: maskVoucherPin(pin),
        statusCode: res.statusCode,
        responseBody: errorBody,
      });

      if (res.statusCode === 401 || res.statusCode === 403) {
        throw new Error('AUTH');
      }
      if (res.statusCode === 400 || res.statusCode === 404) {
        return { status: 'UNKNOWN' };
      }

      throw new Error('RETRYABLE');
    } catch (e: any) {
      if (e.message === 'AUTH') {
        throw e;
      }
      console.error('[Blu] Status check error', {
        pin: maskVoucherPin(pin),
        error: e?.message || e,
      });
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
      amount: amountCents, // Amount in cents, per Swagger
    };
    const masked = maskVoucherPin(pin);
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log('[Blu] Redeem request', { 
          url,
          requestId: idemKey, 
          pin: masked, 
          amount: amountCents, 
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
          let errorData: BluErrorPayload | undefined;
          try {
            errorData = (await res.body.json()) as BluErrorPayload;
          } catch {
            const textBody = await res.body.text();
            errorData = { message: textBody };
          }
          const message = this.extractErrorMessage(errorData, res.statusCode);
          console.error('[Blu] Redeem error response', {
            url,
            method: 'POST',
            requestBody: { requestId: idemKey, token: masked, amount: amountCents },
            statusCode: res.statusCode,
            responseBody: errorData,
            extractedMessage: message,
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


