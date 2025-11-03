/**
 * Blu VAS (Value Added Services) Client
 * 
 * Provides Mobile Airtime and Mobile Data Bundle purchasing services.
 * 
 * @see docs/providers/blu-vas-integration.md
 */

import { request } from 'undici';
import { requireEnv } from '@wapay/utils';

// ============================================================================
// Types
// ============================================================================

export interface VendMetaData {
  transactionRequestDateTime: string;
  transactionReference: string;
  vendorId: string;
  deviceId: string;
  consumerAccountNumber: string;
  cellphoneNumber: string;
  clientId?: string;
  emailAddress?: string;
}

export interface AirtimePurchaseParams {
  msisdn: string;           // WaPay format: +27821234567
  amountCents: number;      // Amount in cents (e.g., 5000 = R50)
  vendorId: string;         // Network: vodacom, mtn, cellc, telkom
  idemKey: string;          // Idempotency key
  accountId: string;        // WaPay customer ID
  journalEntryId: string;   // WaPay journal entry ID
}

export interface DataPurchaseParams {
  msisdn: string;           // WaPay format: +27821234567
  productId: string;        // Bundle ID from catalog
  vendorId: string;         // Network: vodacom, mtn, cellc, telkom
  idemKey: string;          // Idempotency key
  accountId: string;        // WaPay customer ID
  journalEntryId: string;   // WaPay journal entry ID
}

export interface AirtimePurchaseResult {
  providerRef: string;      // Blu transaction reference
  amountCents: number;      // Amount in cents
  vendorName: string;       // Network display name
  dateTime: string;         // ISO 8601 timestamp
}

export interface DataPurchaseResult {
  providerRef: string;      // Blu transaction reference
  amountCents: number;      // Price in cents
  productName: string;      // Bundle name
  vendorName: string;       // Network display name
  dateTime: string;         // ISO 8601 timestamp
}

export interface NetworkDetectionResult {
  vendorName: string;       // Network display name (e.g., "Vodacom")
  mobileNumber: string;     // Phone number
}

export interface DataProduct {
  id: string;               // Product ID (use as productId)
  name: string;             // Display name
  category: string;         // "data", "sms", etc.
  vendorId: string;         // Network identifier
  amountCents: number;      // Price in cents
}

// ============================================================================
// Client
// ============================================================================

export class BluVasClient {
  private base = requireEnv('BLU_BASE_URL');
  private user = requireEnv('BLU_BASIC_USER');
  private pass = requireEnv('BLU_BASIC_PASS');
  private apiKey = requireEnv('BLU_API_KEY');

  /**
   * Build HTTP headers for Blu API requests
   */
  private headers(): Record<string, string> {
    const basic = Buffer.from(`${this.user}:${this.pass}`).toString('base64');
    return {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${basic}`,
      'apikey': this.apiKey,
    };
  }

  /**
   * Convert WaPay phone format to Blu format
   * WaPay: +27821234567
   * Blu: 0821234567
   */
  private toBluFormat(msisdn: string): string {
    if (msisdn.startsWith('+27')) {
      return '0' + msisdn.substring(3);
    }
    if (msisdn.startsWith('27')) {
      return '0' + msisdn.substring(2);
    }
    return msisdn;
  }

  /**
   * Build vendMetaData for transaction tracking
   */
  private buildVendMetaData(params: {
    accountId: string;
    journalEntryId: string;
    msisdn: string;
  }): VendMetaData {
    return {
      transactionRequestDateTime: new Date().toISOString(),
      transactionReference: `WAPAY-${params.journalEntryId}`,
      vendorId: 'WAPAY-001',
      deviceId: 'WHATSAPP-BOT',
      consumerAccountNumber: params.accountId,
      cellphoneNumber: this.toBluFormat(params.msisdn),
    };
  }

  /**
   * Handle Blu API errors and map to WaPay error types
   */
  private handleError(statusCode: number, errorData: any): never {
    const message = errorData?.message || errorData?.error || 'Unknown error';
    
    // User input errors (400, 404, 409)
    if (statusCode === 400 || statusCode === 404 || statusCode === 409) {
      const err = new Error('USER_INPUT');
      (err as any).reason = message;
      (err as any).statusCode = statusCode;
      throw err;
    }
    
    // Auth errors (401, 403)
    if (statusCode === 401 || statusCode === 403) {
      const err = new Error('AUTH');
      (err as any).reason = message;
      (err as any).statusCode = statusCode;
      throw err;
    }
    
    // Rate limit (429)
    if (statusCode === 429) {
      const err = new Error('RETRYABLE');
      (err as any).reason = 'Rate limit exceeded';
      (err as any).statusCode = statusCode;
      throw err;
    }
    
    // Server errors (500, 502, 503)
    const err = new Error('RETRYABLE');
    (err as any).reason = message;
    (err as any).statusCode = statusCode;
    throw err;
  }

  /**
   * Call Blu API with retry logic
   */
  private async callWithRetry<T>(
    fn: () => Promise<T>,
    maxAttempts = 3
  ): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        // Don't retry user errors or auth errors
        if (error.message === 'USER_INPUT' || error.message === 'AUTH') {
          throw error;
        }
        
        // Last attempt - throw error
        if (attempt === maxAttempts) {
          throw error;
        }
        
        // Exponential backoff: 1s, 2s, 4s
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
      }
    }
    throw new Error('RETRYABLE');
  }

  // ==========================================================================
  // Mobile Airtime API
  // ==========================================================================

  /**
   * Purchase airtime for a mobile number
   * 
   * @param params Purchase parameters
   * @returns Transaction result with Blu reference
   * @throws Error with message 'USER_INPUT', 'AUTH', or 'RETRYABLE'
   */
  async purchaseAirtime(params: AirtimePurchaseParams): Promise<AirtimePurchaseResult> {
    const url = `${this.base}/mobile/airtime/sales`;
    
    const body = {
      requestId: params.idemKey,
      vendorId: params.vendorId,
      mobileNumber: this.toBluFormat(params.msisdn),
      amount: params.amountCents,
      vendMetaData: this.buildVendMetaData({
        accountId: params.accountId,
        journalEntryId: params.journalEntryId,
        msisdn: params.msisdn,
      }),
    };

    return this.callWithRetry(async () => {
      const res = await request(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        bodyTimeout: 60000,
        headersTimeout: 60000,
      });

      if (res.statusCode === 200 || res.statusCode === 201) {
        const data = (await res.body.json()) as any;
        return {
          providerRef: String(data.reference),
          amountCents: data.amount,
          vendorName: data.vendorName,
          dateTime: data.dateTime,
        };
      }

      // Handle error
      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData);
    });
  }

  /**
   * Check which network a mobile number belongs to
   * 
   * @param msisdn Phone number (WaPay format: +27821234567)
   * @returns Network detection result
   * @throws Error with message 'USER_INPUT', 'AUTH', or 'RETRYABLE'
   */
  async checkMobileNumber(msisdn: string): Promise<NetworkDetectionResult> {
    const bluNumber = this.toBluFormat(msisdn);
    const url = `${this.base}/mobile/airtime/mobile-number/check?mobileNumber=${encodeURIComponent(bluNumber)}`;

    return this.callWithRetry(async () => {
      const res = await request(url, {
        method: 'GET',
        headers: this.headers(),
        bodyTimeout: 30000,
        headersTimeout: 30000,
      });

      if (res.statusCode === 200) {
        const data = (await res.body.json()) as any;
        return {
          vendorName: data.vendorName,
          mobileNumber: data.mobileNumber,
        };
      }

      // Handle error
      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData);
    });
  }

  // ==========================================================================
  // Mobile Data API
  // ==========================================================================

  /**
   * Get available data products (bundles) for a network
   * 
   * @param vendorId Network identifier (optional, returns all if omitted)
   * @returns List of data products
   * @throws Error with message 'AUTH' or 'RETRYABLE'
   */
  async getDataProducts(vendorId?: string): Promise<DataProduct[]> {
    const query = vendorId ? `?vendorId=${encodeURIComponent(vendorId)}` : '';
    const url = `${this.base}/mobile/data/products${query}`;

    return this.callWithRetry(async () => {
      const res = await request(url, {
        method: 'GET',
        headers: this.headers(),
        bodyTimeout: 30000,
        headersTimeout: 30000,
      });

      if (res.statusCode === 200) {
        const data = (await res.body.json()) as any[];
        return data.map(product => ({
          id: product.id,
          name: product.name,
          category: product.category,
          vendorId: product.vendorId,
          amountCents: product.amount,
        }));
      }

      // Handle error
      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData);
    });
  }

  /**
   * Purchase a data bundle for a mobile number
   * 
   * @param params Purchase parameters
   * @returns Transaction result with Blu reference
   * @throws Error with message 'USER_INPUT', 'AUTH', or 'RETRYABLE'
   */
  async purchaseDataBundle(params: DataPurchaseParams): Promise<DataPurchaseResult> {
    const url = `${this.base}/mobile/data/sales`;
    
    const body = {
      requestId: params.idemKey,
      vendorId: params.vendorId,
      productId: params.productId,
      mobileNumber: this.toBluFormat(params.msisdn),
      vendMetaData: this.buildVendMetaData({
        accountId: params.accountId,
        journalEntryId: params.journalEntryId,
        msisdn: params.msisdn,
      }),
    };

    return this.callWithRetry(async () => {
      const res = await request(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        bodyTimeout: 60000,
        headersTimeout: 60000,
      });

      if (res.statusCode === 200 || res.statusCode === 201) {
        const data = (await res.body.json()) as any;
        return {
          providerRef: String(data.reference),
          amountCents: data.amount,
          productName: data.productName,
          vendorName: data.vendorName,
          dateTime: data.dateTime,
        };
      }

      // Handle error
      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData);
    });
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Map vendorName to vendorId
   * "Vodacom" → "vodacom"
   */
  vendorNameToId(vendorName: string): string {
    return vendorName.toLowerCase().replace(/\s+/g, '');
  }

  /**
   * Map vendorId to display name
   * "vodacom" → "Vodacom"
   */
  vendorIdToName(vendorId: string): string {
    const map: Record<string, string> = {
      'vodacom': 'Vodacom',
      'mtn': 'MTN',
      'cellc': 'Cell C',
      'telkom': 'Telkom',
    };
    return map[vendorId] || vendorId;
  }
}

