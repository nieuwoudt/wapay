/**
 * Blu VAS (Value Added Services) Client
 * 
 * Provides Mobile Airtime and Mobile Data Bundle purchasing services.
 * 
 * Note: Blu Voucher + Blu VAS share the same BLT Trade API key (apikey header).
 * Use BLU_TRADE_API_KEY for all trade/v2 endpoints.
 * 
 * Environment Variables:
 * - BLU_BASE_URL: API base URL - MUST be set to https://api.qa.bltelecoms.net/v2/trade for QA
 * - BLU_BASIC_USER: Basic auth username (not used for VAS, but kept for voucher compatibility)
 * - BLU_BASIC_PASS: Basic auth password (not used for VAS, but kept for voucher compatibility)
 * - BLU_TRADE_API_KEY: API key for Blu Trade API (e.g., 5135ae7a-3d92-44ff-86bb-89c401722221 for QA)
 * - BLU_VAS_STUB_MODE: When 'true', returns simulated success without calling Blu (QA only!)
 * 
 * ⚠️ WARNING: BLU_VAS_STUB_MODE must NEVER be enabled in production with real money.
 * It is only for testing the WaPay UX flow when Blu QA rejects test phone numbers.
 * 
 * Blu QA Test MSISDNs (for testing with real Blu QA):
 * - 0840012300 (Cell C)
 * - 0720012345 (Vodacom)
 * - 0830012300 (MTN)
 * - 0850012345 (Telkom)
 * 
 * @see docs/providers/blu-vas-integration.md
 */

import { request } from 'undici';
import { requireEnv } from '@wapay/utils';

// ============================================================================
// Blu QA Test MSISDNs - Only work with Blu QA environment
// ============================================================================
export const BLU_QA_TEST_MSISDNS = {
  CELLC: '0840012300',
  VODACOM: '0720012345',
  MTN: '0830012300',
  TELKOM: '0850012345',
} as const;

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
  // Shared API key for Blu Voucher + VAS (same BLT Trade API)
  // Falls back to BLU_API_KEY for backward compatibility
  private apiKey = process.env.BLU_TRADE_API_KEY || requireEnv('BLU_API_KEY');

  /**
   * Build HTTP headers for Blu API requests
   * 
   * Note: For VAS endpoints, only 'apikey' header is required (no Basic auth).
   * Basic auth is included for backward compatibility with voucher endpoints.
   */
  private headers(): Record<string, string> {
    return {
      'accept': 'application/json',
      'Content-Type': 'application/json',
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
  private handleError(statusCode: number, errorData: any, msisdn?: string): never {
    const message = errorData?.message || errorData?.error || 'Unknown error';
    
    // Check for "Invalid phone number" specifically
    const isInvalidPhoneNumber = message.toLowerCase().includes('invalid phone number') ||
                                  message.toLowerCase().includes('invalid mobile number') ||
                                  message.toLowerCase().includes('invalid msisdn');
    
    if (isInvalidPhoneNumber) {
      // Structured logging for invalid MSISDN
      console.log(JSON.stringify({
        type: 'blu_vas_invalid_msisdn',
        msisdn: msisdn || 'unknown',
        provider_error: statusCode,
        provider_message: message,
        timestamp: new Date().toISOString(),
      }));
      
      const err = new Error('INVALID_PHONE_NUMBER');
      (err as any).reason = 'The phone number is not valid or not supported in this environment.';
      (err as any).userMessage = "Sorry, I couldn't process that purchase. The network is rejecting this phone number. Please try with a different number or contact support.";
      (err as any).statusCode = statusCode;
      (err as any).providerMessage = message;
      throw err;
    }
    
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
   * @throws Error with message 'USER_INPUT', 'AUTH', 'RETRYABLE', or 'INVALID_PHONE_NUMBER'
   */
  async purchaseAirtime(params: AirtimePurchaseParams): Promise<AirtimePurchaseResult> {
    // =========================================================================
    // STUB MODE - For QA testing when Blu rejects phone numbers
    // ⚠️ WARNING: Must NEVER be enabled in production with real money!
    // =========================================================================
    if (process.env.BLU_VAS_STUB_MODE === 'true') {
      console.warn('⚠️ BLU_VAS_STUB_MODE enabled - returning stub response for airtime purchase');
      console.log(JSON.stringify({
        type: 'blu_vas_stub_airtime',
        msisdn: params.msisdn,
        amountCents: params.amountCents,
        vendorId: params.vendorId,
        idemKey: params.idemKey,
        timestamp: new Date().toISOString(),
      }));
      
      return {
        providerRef: `STUB-AIR-${Date.now()}`,
        amountCents: params.amountCents,
        vendorName: this.vendorIdToName(params.vendorId),
        dateTime: new Date().toISOString(),
      };
    }
    
    const url = `${this.base}/mobile/airtime/sales`;
    const bluMsisdn = this.toBluFormat(params.msisdn);
    
    const body = {
      requestId: params.idemKey,
      vendorId: params.vendorId,
      mobileNumber: bluMsisdn,
      amount: params.amountCents,
      vendMetaData: this.buildVendMetaData({
        accountId: params.accountId,
        journalEntryId: params.journalEntryId,
        msisdn: params.msisdn,
      }),
    };

    // Log the request for debugging
    console.log(JSON.stringify({
      type: 'blu_vas_airtime_request',
      url,
      vendorId: params.vendorId,
      mobileNumber: bluMsisdn,
      amount: params.amountCents,
      requestId: params.idemKey,
      timestamp: new Date().toISOString(),
    }));

    return this.callWithRetry(async () => {
      const res = await request(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        bodyTimeout: 60000,
        headersTimeout: 60000,
      });

      const responseText = await res.body.text();
      
      // Log the response for debugging
      console.log(JSON.stringify({
        type: 'blu_vas_airtime_response',
        statusCode: res.statusCode,
        response: responseText.substring(0, 500), // Truncate long responses
        timestamp: new Date().toISOString(),
      }));

      if (res.statusCode === 200 || res.statusCode === 201) {
        const data = JSON.parse(responseText);
        return {
          providerRef: String(data.reference),
          amountCents: data.amount,
          vendorName: data.vendorName,
          dateTime: data.dateTime,
        };
      }

      // Handle error - pass msisdn for better logging
      let errorData;
      try {
        errorData = JSON.parse(responseText);
      } catch {
        errorData = { message: responseText };
      }
      this.handleError(res.statusCode, errorData, params.msisdn);
    });
  }

  /**
   * Check which network a mobile number belongs to
   * 
   * @param msisdn Phone number (WaPay format: +27821234567)
   * @returns Network detection result
   * @throws Error with message 'USER_INPUT', 'AUTH', 'RETRYABLE', or 'INVALID_PHONE_NUMBER'
   */
  async checkMobileNumber(msisdn: string): Promise<NetworkDetectionResult> {
    // =========================================================================
    // STUB MODE - For QA testing when Blu rejects phone numbers
    // ⚠️ WARNING: Must NEVER be enabled in production!
    // =========================================================================
    if (process.env.BLU_VAS_STUB_MODE === 'true') {
      console.warn('⚠️ BLU_VAS_STUB_MODE enabled - returning stub network detection');
      
      // Simulate network detection based on prefix
      const normalized = this.toBluFormat(msisdn);
      let vendorName = 'Vodacom'; // Default
      
      if (normalized.startsWith('083') || normalized.startsWith('073')) {
        vendorName = 'MTN';
      } else if (normalized.startsWith('084') || normalized.startsWith('074')) {
        vendorName = 'Cell C';
      } else if (normalized.startsWith('081') || normalized.startsWith('071')) {
        vendorName = 'Vodacom';
      } else if (normalized.startsWith('082') || normalized.startsWith('072')) {
        vendorName = 'Vodacom';
      } else if (normalized.startsWith('060') || normalized.startsWith('061')) {
        vendorName = 'Telkom';
      }
      
      console.log(JSON.stringify({
        type: 'blu_vas_stub_network_detection',
        msisdn,
        detectedVendor: vendorName,
        timestamp: new Date().toISOString(),
      }));
      
      return {
        vendorName,
        mobileNumber: normalized,
      };
    }
    
    const bluNumber = this.toBluFormat(msisdn);
    // Blu QA expects query param "mobile-number" (with dash) per swagger
    const url = `${this.base}/mobile/airtime/mobile-number/check?mobile-number=${encodeURIComponent(bluNumber)}`;

    return this.callWithRetry(async () => {
      const headers = this.headers();
      // Log request metadata without api key
      console.log(JSON.stringify({
        type: 'blu_vas_network_request',
        url,
        headers: Object.keys(headers).filter((k) => k.toLowerCase() !== 'authorization'),
        msisdn: bluNumber,
        timestamp: new Date().toISOString(),
      }));

      const res = await request(url, {
        method: 'GET',
        headers,
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

      // Handle error - pass msisdn for better logging
      let errorData: any;
      try {
        errorData = (await res.body.json()) as any;
      } catch {
        const text = await res.body.text();
        errorData = { message: text };
      }
      console.log(JSON.stringify({
        type: 'blu_vas_network_response_error',
        statusCode: res.statusCode,
        body: errorData,
        msisdn: bluNumber,
        timestamp: new Date().toISOString(),
      }));
      this.handleError(res.statusCode, errorData, msisdn);
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
   * @throws Error with message 'USER_INPUT', 'AUTH', 'RETRYABLE', or 'INVALID_PHONE_NUMBER'
   */
  async purchaseDataBundle(params: DataPurchaseParams): Promise<DataPurchaseResult> {
    // =========================================================================
    // STUB MODE - For QA testing when Blu rejects phone numbers
    // ⚠️ WARNING: Must NEVER be enabled in production with real money!
    // =========================================================================
    if (process.env.BLU_VAS_STUB_MODE === 'true') {
      console.warn('⚠️ BLU_VAS_STUB_MODE enabled - returning stub response for data purchase');
      console.log(JSON.stringify({
        type: 'blu_vas_stub_data',
        msisdn: params.msisdn,
        productId: params.productId,
        vendorId: params.vendorId,
        idemKey: params.idemKey,
        timestamp: new Date().toISOString(),
      }));
      
      return {
        providerRef: `STUB-DATA-${Date.now()}`,
        amountCents: 2900, // Simulated bundle price
        productName: `Simulated ${params.vendorId} Bundle`,
        vendorName: this.vendorIdToName(params.vendorId),
        dateTime: new Date().toISOString(),
      };
    }
    
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

      // Handle error - pass msisdn for better logging
      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData, params.msisdn);
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

