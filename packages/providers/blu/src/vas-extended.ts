/**
 * Blu VAS Extended Client
 * 
 * Full VAS integration covering:
 * - Mobile Airtime & Data (existing)
 * - Prepaid Electricity (STS)
 * - PayTV (DStv, GOtv)
 * - OTT Vouchers (Showmax, BoxOffice)
 * - Retail Vouchers (Pick n Pay, Shoprite)
 * - Betting & Gaming (Hollywoodbets, Betway)
 * - Generic Vouchers (1Voucher, Flash)
 * 
 * @see docs/providers/blu-vas-complete.md
 */

import { request } from 'undici';
import { requireEnv } from '@wapay/utils';
import type {
  VendMetaData,
  VasCategory,
  PurchaseType,
  
  // Airtime & Data
  AirtimePurchaseParams,
  AirtimePurchaseResult,
  DataPurchaseParams,
  DataPurchaseResult,
  DataProduct,
  
  // Electricity
  ElectricityInfoResult,
  ElectricitySaleParams,
  ElectricityPurchaseResult,
  
  // PayTV
  DstvPaymentParams,
  DstvPaymentResult,
  DstvAccountInfo,
  
  // OTT
  OttVoucherPurchaseParams,
  OttVoucherPurchaseResult,
  OttProduct,
  
  // Retail
  RetailVoucherPurchaseParams,
  RetailVoucherPurchaseResult,
  RetailVoucherProduct,
  
  // Betting
  BettingTopUpParams,
  BettingTopUpResult,
  BettingAccountValidation,
  
  // Generic
  GenericVoucherPurchaseParams,
  GenericVoucherPurchaseResult,
} from './vas-types.js';

// Re-export types
export * from './vas-types.js';

// ============================================================================
// Electricity timing (2026-10-06)
// ============================================================================
// Blu answers electricity slowly (QA took more than 30 s on a meter lookup;
// the sale is documented at up to ~90 s) while the Vercel function waiting
// for it is capped (vercel.json: 60 s for pages/api/vas/**). A retry after a
// timeout can never fit that cap, so both electricity calls are single
// attempt and bounded well inside it, and a transport timeout is surfaced as
// its own error, 'TIMEOUT'. For the SALE that outcome is indeterminate (Blu
// may have vended): the execute route keeps the hold and marks the row
// RECONCILE, and lib/electricity-settlement.js re-sends the same requestId
// later (Blu caches by requestId, so a vended sale replays its result).
const ELEC_INFO_TIMEOUT_MS = Number(process.env.BLU_ELEC_INFO_TIMEOUT_MS) || 40000;
const ELEC_SALE_TIMEOUT_MS = Number(process.env.BLU_ELEC_SALE_TIMEOUT_MS) || 50000;

function isTransportTimeout(error: any): boolean {
  const code = String(error?.code || '');
  const name = String(error?.name || '');
  return /UND_ERR_(HEADERS|BODY|CONNECT)_TIMEOUT/.test(code) || /TimeoutError$/.test(name) || code === 'ETIMEDOUT';
}

/** Blu's gateway sometimes answers with a bare text page ("error code: 520"); never let a JSON parse error stand in for the supplier's answer. */
async function readBody(res: { body: { text: () => Promise<string> } }): Promise<any> {
  const text = await res.body.text();
  try {
    return JSON.parse(text);
  } catch {
    return { message: `Non-JSON answer from the supplier: ${String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120)}` };
  }
}

function asTimeout(error: any, what: string): Error {
  const err = new Error('TIMEOUT');
  (err as any).reason = `${what} did not answer within the time allowed`;
  (err as any).cause = error;
  return err;
}

// ============================================================================
// Extended VAS Client
// ============================================================================

export class BluVasExtendedClient {
  private base = requireEnv('BLU_BASE_URL');
  private user = requireEnv('BLU_BASIC_USER');
  private pass = requireEnv('BLU_BASIC_PASS');
  private apiKey = requireEnv('BLU_API_KEY');

  // ==========================================================================
  // HTTP Helpers
  // ==========================================================================

  private headers(): Record<string, string> {
    const basic = Buffer.from(`${this.user}:${this.pass}`).toString('base64');
    return {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${basic}`,
      'apikey': this.apiKey,
    };
  }

  private toBluFormat(msisdn: string): string {
    if (msisdn.startsWith('+27')) {
      return '0' + msisdn.substring(3);
    }
    if (msisdn.startsWith('27')) {
      return '0' + msisdn.substring(2);
    }
    return msisdn;
  }

  private buildVendMetaData(params: {
    accountId: string;
    journalEntryId: string;
    msisdn?: string;
    meterNumber?: string;
  }): VendMetaData {
    return {
      transactionRequestDateTime: new Date().toISOString(),
      transactionReference: `WAPAY-${params.journalEntryId}`,
      vendorId: 'WAPAY-001',
      deviceId: 'WHATSAPP-BOT',
      consumerAccountNumber: params.accountId,
      cellphoneNumber: params.msisdn ? this.toBluFormat(params.msisdn) : '',
    };
  }

  private handleError(statusCode: number, errorData: any): never {
    const message = errorData?.message || errorData?.error || 'Unknown error';
    
    if (statusCode === 400 || statusCode === 404 || statusCode === 409) {
      const err = new Error('USER_INPUT');
      (err as any).reason = message;
      (err as any).statusCode = statusCode;
      throw err;
    }
    
    if (statusCode === 401 || statusCode === 403) {
      const err = new Error('AUTH');
      (err as any).reason = message;
      (err as any).statusCode = statusCode;
      throw err;
    }
    
    if (statusCode === 429) {
      const err = new Error('RETRYABLE');
      (err as any).reason = 'Rate limit exceeded';
      (err as any).statusCode = statusCode;
      throw err;
    }
    
    const err = new Error('RETRYABLE');
    (err as any).reason = message;
    (err as any).statusCode = statusCode;
    throw err;
  }

  private async callWithRetry<T>(
    fn: () => Promise<T>,
    maxAttempts = 3
  ): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        // Electricity/info and sales calls often fail due to provider config/enablement
        // or user input; never retry these.
        if (error.message === 'USER_INPUT' || error.message === 'AUTH' || error.message === 'INVALID_PHONE_NUMBER' || error.message === 'TIMEOUT') {
          throw error;
        }
        if (attempt === maxAttempts) {
          throw error;
        }
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
      }
    }
    throw new Error('RETRYABLE');
  }

  // ==========================================================================
  // Mobile Airtime
  // ==========================================================================

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
          mobileNumber: data.mobileNumber,
        };
      }

      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData);
    });
  }

  async checkMobileNumber(msisdn: string): Promise<{ vendorName: string; mobileNumber: string }> {
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

      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData);
    });
  }

  // ==========================================================================
  // Mobile Data
  // ==========================================================================

  async getDataProducts(vendorId?: string): Promise<DataProduct[]> {
    const query = vendorId ? `?vendorId=${encodeURIComponent(vendorId)}` : '';
    // Blu deprecated /mobile/data/products; /mobile/bundle/products is the
    // working catalogue endpoint (same fix vas.ts got in fa457a5 — this
    // client was missed, which silently broke the nightly catalog sync).
    const url = `${this.base}/mobile/bundle/products${query}`;

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
          sizeMb: product.sizeMb,
          validityDays: product.validityDays,
        }));
      }

      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData);
    });
  }

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
          mobileNumber: data.mobileNumber,
        };
      }

      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData);
    });
  }

  // ==========================================================================
  // Prepaid Electricity (STS)
  // ==========================================================================

  /**
   * Confirm meter + get quote/info for electricity purchase.
   *
   * Blu Support confirmed deprecated/non-functional:
   * - POST /electricity/confirmCustomer (do not use)
   *
   * Correct confirm step:
   * - GET /electricity/info?amount={cents}&free-basic-electricity=false&meter-number={meter}
   *
   * Returns a `reference` required for the sale.
   */
  async getElectricityInfo(params: { meterNumber: string; amountCents: number; freeBasicElectricity?: boolean }): Promise<ElectricityInfoResult> {
    const freeBasic = params.freeBasicElectricity === true ? 'true' : 'false';
    const url =
      `${this.base}/electricity/info` +
      `?amount=${encodeURIComponent(String(params.amountCents))}` +
      `&free-basic-electricity=${encodeURIComponent(freeBasic)}` +
      `&meter-number=${encodeURIComponent(params.meterNumber)}`;

    // Single attempt, bounded: see "Electricity timing" above.
    return this.callWithRetry(async () => {
      let res: Awaited<ReturnType<typeof request>>;
      let data: any;
      try {
        res = await request(url, {
          method: 'GET',
          headers: this.headers(),
          bodyTimeout: ELEC_INFO_TIMEOUT_MS,
          headersTimeout: ELEC_INFO_TIMEOUT_MS,
        });
        data = await readBody(res);
      } catch (error: any) {
        if (isTransportTimeout(error)) throw asTimeout(error, 'The meter lookup');
        throw error;
      }

      if (res.statusCode === 200 || res.statusCode === 201) {
        const reference = data.reference || data.vendorReference || data.ref || data.transactionReference;
        return {
          reference: String(reference || ''),
          meterNumber: data.meterNumber || data['meter-number'] || params.meterNumber,
          amountCents: data.amount ?? data.amountCents ?? params.amountCents,
          customerName: data.customerName,
          customerAddress: data.customerAddress,
          municipalityName: data.municipalityName,
          municipalityCode: data.municipalityCode,
          vat: data.vat,
          serviceCharge: data.serviceCharge,
          arrears: data.arrears,
        };
      }

      this.handleError(res.statusCode, data);
    }, 1);
  }

  /**
   * Purchase prepaid electricity token using the reference from `getElectricityInfo`.
   *
   * Blu Endpoint: POST /electricity/sales
   */
  async purchaseElectricity(params: ElectricitySaleParams, opts: { timeoutMs?: number } = {}): Promise<ElectricityPurchaseResult> {
    const url = `${this.base}/electricity/sales`;
    // The route waits the full budget; a re-send on the customer's own turn
    // (lib/electricity-settlement.js, opportunistic) passes a short one so the
    // webhook turn never blows its window. Blu caches by requestId, so a
    // re-send that times out at our end is harmless and the cron finishes it.
    const saleTimeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : ELEC_SALE_TIMEOUT_MS;
    
    const body = {
      requestId: params.idemKey,
      reference: params.reference,
      vendMetaData: this.buildVendMetaData({
        accountId: params.accountId,
        journalEntryId: params.journalEntryId,
      }),
    };

    // Single attempt, bounded; a timeout here is INDETERMINATE (Blu may have
    // vended) and is thrown as 'TIMEOUT' for the route to keep the hold.
    return this.callWithRetry(async () => {
      let res: Awaited<ReturnType<typeof request>>;
      let data: any;
      try {
        res = await request(url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          bodyTimeout: saleTimeoutMs,
          headersTimeout: saleTimeoutMs,
        });
        data = await readBody(res);
      } catch (error: any) {
        if (isTransportTimeout(error)) throw asTimeout(error, 'The electricity sale');
        throw error;
      }

      if (res.statusCode === 200 || res.statusCode === 201) {
        return {
          providerRef: String(data.reference),
          amountCents: data.amount,
          dateTime: data.dateTime,
          token: data.token,
          tokenType: data.tokenType || 'STS_1',
          units: data.units,
          unitRate: data.unitRate,
          meterNumber: data.meterNumber || '',
          municipalityName: data.municipalityName,
          customerName: data.customerName,
          customerAddress: data.customerAddress,
          arrears: data.arrears,
          debt: data.debt,
          vat: data.vat,
          serviceCharge: data.serviceCharge,
        };
      }

      this.handleError(res.statusCode, data);
    }, 1);
  }

  // ==========================================================================
  // PayTV (DStv, GOtv)
  // ==========================================================================

  /**
   * Lookup DStv account by smartcard number
   * 
   * Blu Endpoint: GET /paytv/dstv/account?smartcard=xxx
   */
  async getDstvAccount(smartcardNumber: string): Promise<DstvAccountInfo> {
    const url = `${this.base}/paytv/dstv/account?smartcard=${encodeURIComponent(smartcardNumber)}`;

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
          smartcardNumber: data.smartcardNumber,
          customerName: data.customerName,
          packageName: data.packageName,
          packagePrice: data.packagePrice,
          status: data.status,
          expiryDate: data.expiryDate,
          balance: data.balance || 0,
          dueDate: data.dueDate,
        };
      }

      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData);
    });
  }

  /**
   * Pay DStv subscription or balance
   * 
   * Blu Endpoint: POST /paytv/dstv/payments
   */
  async payDstv(params: DstvPaymentParams): Promise<DstvPaymentResult> {
    const url = `${this.base}/paytv/dstv/payments`;
    
    const body = {
      requestId: params.idemKey,
      smartcardNumber: params.smartcardNumber,
      productId: params.productId,
      amount: params.amountCents,
      paymentType: params.paymentType,
      vendMetaData: this.buildVendMetaData({
        accountId: params.accountId,
        journalEntryId: params.journalEntryId,
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
          dateTime: data.dateTime,
          smartcardNumber: data.smartcardNumber,
          customerName: data.customerName,
          packageName: data.packageName,
          expiryDate: data.expiryDate,
          balance: data.balance,
          dueDate: data.dueDate,
        };
      }

      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData);
    });
  }

  /**
   * Get DStv packages/products
   * 
   * Blu Endpoint: GET /paytv/dstv/products
   */
  async getDstvPackages(): Promise<Array<{ id: string; name: string; price: number }>> {
    const url = `${this.base}/paytv/dstv/products`;

    return this.callWithRetry(async () => {
      const res = await request(url, {
        method: 'GET',
        headers: this.headers(),
        bodyTimeout: 30000,
        headersTimeout: 30000,
      });

      if (res.statusCode === 200) {
        const data = (await res.body.json()) as any[];
        return data.map(p => ({
          id: p.id,
          name: p.name,
          price: p.amount,
        }));
      }

      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData);
    });
  }

  // ==========================================================================
  // OTT Vouchers (Showmax, BoxOffice, etc.)
  // ==========================================================================

  /**
   * Get available OTT products
   * 
   * Blu Endpoint: GET /voucher/ott/products?providerId=xxx
   */
  async getOttProducts(providerId?: string): Promise<OttProduct[]> {
    const query = providerId ? `?providerId=${encodeURIComponent(providerId)}` : '';
    const url = `${this.base}/voucher/ott/products${query}`;

    return this.callWithRetry(async () => {
      const res = await request(url, {
        method: 'GET',
        headers: this.headers(),
        bodyTimeout: 30000,
        headersTimeout: 30000,
      });

      if (res.statusCode === 200) {
        const data = (await res.body.json()) as any[];
        return data.map(p => ({
          id: p.id,
          providerId: p.providerId,
          providerName: p.providerName,
          name: p.name,
          amountCents: p.amount,
          validityDays: p.validityDays,
          description: p.description,
          isVariableAmount: p.isVariableAmount,
        }));
      }

      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData);
    });
  }

  /**
   * Purchase OTT voucher
   * 
   * Blu Endpoint: POST /voucher/ott/purchase
   */
  async purchaseOttVoucher(params: OttVoucherPurchaseParams): Promise<OttVoucherPurchaseResult> {
    const url = `${this.base}/voucher/ott/purchase`;
    
    const body = {
      requestId: params.idemKey,
      providerId: params.providerId,
      productId: params.productId,
      amount: params.amountCents,
      recipientEmail: params.recipientEmail,
      recipientMsisdn: params.recipientMsisdn ? this.toBluFormat(params.recipientMsisdn) : undefined,
      vendMetaData: this.buildVendMetaData({
        accountId: params.accountId,
        journalEntryId: params.journalEntryId,
        msisdn: params.recipientMsisdn,
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
          dateTime: data.dateTime,
          voucherCode: data.voucherCode || data.pin,
          voucherSerial: data.voucherSerial || data.serial,
          expiryDate: data.expiryDate,
          productName: data.productName,
          instructions: data.instructions || `Redeem at ${params.providerId}.com`,
        };
      }

      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData);
    });
  }

  // ==========================================================================
  // Retail Vouchers (Pick n Pay, Shoprite, etc.)
  // ==========================================================================

  /**
   * Get available retail voucher products
   * 
   * Blu Endpoint: GET /voucher/retail/products?retailerId=xxx
   */
  async getRetailVoucherProducts(retailerId?: string): Promise<RetailVoucherProduct[]> {
    const query = retailerId ? `?retailerId=${encodeURIComponent(retailerId)}` : '';
    const url = `${this.base}/voucher/retail/products${query}`;

    return this.callWithRetry(async () => {
      const res = await request(url, {
        method: 'GET',
        headers: this.headers(),
        bodyTimeout: 30000,
        headersTimeout: 30000,
      });

      if (res.statusCode === 200) {
        const data = (await res.body.json()) as any[];
        return data.map(p => ({
          id: p.id,
          retailerId: p.retailerId,
          retailerName: p.retailerName,
          name: p.name,
          amountCents: p.amount,
          isVariableAmount: p.isVariableAmount,
          minCents: p.minCents,
          maxCents: p.maxCents,
          validityDays: p.validityDays,
        }));
      }

      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData);
    });
  }

  /**
   * Purchase retail voucher
   * 
   * Blu Endpoint: POST /voucher/retail/purchase
   */
  async purchaseRetailVoucher(params: RetailVoucherPurchaseParams): Promise<RetailVoucherPurchaseResult> {
    const url = `${this.base}/voucher/retail/purchase`;
    
    const body = {
      requestId: params.idemKey,
      retailerId: params.retailerId,
      productId: params.productId,
      amount: params.amountCents,
      recipientMsisdn: params.recipientMsisdn ? this.toBluFormat(params.recipientMsisdn) : undefined,
      vendMetaData: this.buildVendMetaData({
        accountId: params.accountId,
        journalEntryId: params.journalEntryId,
        msisdn: params.recipientMsisdn,
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
          dateTime: data.dateTime,
          voucherCode: data.voucherCode || data.pin,
          voucherSerial: data.voucherSerial,
          barcode: data.barcode,
          barcodeFormat: data.barcodeFormat,
          expiryDate: data.expiryDate,
          retailerName: data.retailerName,
          productName: data.productName,
          instructions: data.instructions || `Present at ${params.retailerId} till`,
        };
      }

      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData);
    });
  }

  // ==========================================================================
  // Betting & Gaming (Hollywoodbets, Betway, etc.)
  // ==========================================================================

  /**
   * Validate betting account
   * 
   * Blu Endpoint: GET /betting/{provider}/validate?accountId=xxx
   */
  async validateBettingAccount(
    providerId: string,
    accountId: string
  ): Promise<BettingAccountValidation> {
    const url = `${this.base}/betting/${providerId}/validate?accountId=${encodeURIComponent(accountId)}`;

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
          providerId,
          accountId: data.accountId,
          valid: true,
          accountHolderName: data.accountHolderName,
          msisdn: data.msisdn,
          currentBalance: data.currentBalance,
        };
      }

      if (res.statusCode === 404) {
        return {
          providerId,
          accountId,
          valid: false,
        };
      }

      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData);
    });
  }

  /**
   * Top up betting account
   * 
   * Blu Endpoint: POST /betting/{provider}/topup
   */
  async topUpBettingAccount(params: BettingTopUpParams): Promise<BettingTopUpResult> {
    const url = `${this.base}/betting/${params.providerId}/topup`;
    
    const body = {
      requestId: params.idemKey,
      accountId: params.accountId,
      accountMsisdn: params.accountMsisdn ? this.toBluFormat(params.accountMsisdn) : undefined,
      amount: params.amountCents,
      vendMetaData: this.buildVendMetaData({
        accountId: params.accountId,
        journalEntryId: params.journalEntryId,
        msisdn: params.accountMsisdn,
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
          dateTime: data.dateTime,
          providerId: params.providerId,
          providerName: data.providerName || params.providerId,
          accountId: params.accountId,
          newBalance: data.newBalance,
          bonusAmount: data.bonusAmount,
        };
      }

      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData);
    });
  }

  /**
   * Get supported betting providers
   * 
   * Blu Endpoint: GET /betting/providers
   */
  async getBettingProviders(): Promise<Array<{ id: string; name: string }>> {
    const url = `${this.base}/betting/providers`;

    return this.callWithRetry(async () => {
      const res = await request(url, {
        method: 'GET',
        headers: this.headers(),
        bodyTimeout: 30000,
        headersTimeout: 30000,
      });

      if (res.statusCode === 200) {
        const data = (await res.body.json()) as any[];
        return data.map(p => ({
          id: p.id,
          name: p.name,
        }));
      }

      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData);
    });
  }

  // ==========================================================================
  // Generic Vouchers (1Voucher, Flash, etc.)
  // ==========================================================================

  /**
   * Purchase generic voucher
   * 
   * Blu Endpoint: POST /voucher/generic/purchase
   */
  async purchaseGenericVoucher(params: GenericVoucherPurchaseParams): Promise<GenericVoucherPurchaseResult> {
    const url = `${this.base}/voucher/generic/purchase`;
    
    const body = {
      requestId: params.idemKey,
      providerId: params.providerId,
      productId: params.productId,
      amount: params.amountCents,
      vendMetaData: this.buildVendMetaData({
        accountId: params.accountId,
        journalEntryId: params.journalEntryId,
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
          dateTime: data.dateTime,
          voucherPin: data.voucherPin || data.pin || data.token,
          voucherSerial: data.voucherSerial || data.serial,
          expiryDate: data.expiryDate,
          productName: data.productName || params.providerId,
          instructions: data.instructions,
        };
      }

      const errorData = (await res.body.json()) as any;
      this.handleError(res.statusCode, errorData);
    });
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  vendorNameToId(vendorName: string): string {
    return vendorName.toLowerCase().replace(/\s+/g, '');
  }

  vendorIdToName(vendorId: string): string {
    const map: Record<string, string> = {
      'vodacom': 'Vodacom',
      'mtn': 'MTN',
      'cellc': 'Cell C',
      'telkom': 'Telkom',
      'dstv': 'DStv',
      'gotv': 'GOtv',
      'showmax': 'Showmax',
      'hollywoodbets': 'Hollywoodbets',
      'betway': 'Betway',
      'sportingbet': 'Sportingbet',
      'picknpay': 'Pick n Pay',
      'shoprite': 'Shoprite',
      'checkers': 'Checkers',
    };
    return map[vendorId] || vendorId;
  }
}

