/**
 * Blu VAS (Value Added Services) - Complete Type Definitions
 * 
 * Covers ALL VAS product categories:
 * - Mobile Airtime
 * - Mobile Data Bundles
 * - Prepaid Electricity (STS)
 * - PayTV (DStv, GOtv)
 * - OTT Vouchers (Showmax, BoxOffice)
 * - Retail Vouchers (Pick n Pay, Shoprite, Checkers)
 * - Betting & Gaming (Hollywoodbets, Betway, Sportingbet)
 * - Generic Vouchers (1Voucher, Flash)
 * 
 * @see docs/providers/blu-vas-complete.md
 */

// ============================================================================
// Base Types
// ============================================================================

/**
 * Transaction metadata for tracking and reconciliation
 */
export interface VendMetaData {
  transactionRequestDateTime: string;  // ISO 8601
  transactionReference: string;        // WaPay journal entry ID
  vendorId: string;                    // "WAPAY-001"
  deviceId: string;                    // "WHATSAPP-BOT"
  consumerAccountNumber: string;       // WaPay customer ID
  cellphoneNumber: string;             // Customer phone
  clientId?: string;                   // WhatsApp ID
  emailAddress?: string;               // Customer email
  latitude?: string;                   // For location-based services
  longitude?: string;                  // For location-based services
}

/**
 * VAS Product Categories
 */
export type VasCategory = 
  | 'AIRTIME'
  | 'DATA'
  | 'ELECTRICITY'
  | 'PAYTV'
  | 'OTT'
  | 'RETAIL_VOUCHER'
  | 'BETTING'
  | 'GAMING'
  | 'VOUCHER';

/**
 * Purchase Types
 */
export type PurchaseType =
  | 'INSTANT_VEND'    // Product delivered immediately (airtime, data)
  | 'PIN_BASED'       // Returns a voucher PIN/code
  | 'REFERENCE_BASED' // Returns a reference for external collection
  | 'TOKEN_BASED';    // Returns a token (electricity)

/**
 * WaPay Error Types
 */
export type WaPayErrorType = 'USER_INPUT' | 'AUTH' | 'RETRYABLE' | 'FATAL';

/**
 * Base VAS product structure
 */
export interface VasProduct {
  id: string;
  name: string;
  category: VasCategory;
  vendorId: string;
  vendorName: string;
  amountCents: number;
  purchaseType: PurchaseType;
  description?: string;
  validityDays?: number;
  metadata?: Record<string, any>;
}

/**
 * Base purchase parameters
 */
export interface BasePurchaseParams {
  idemKey: string;          // Idempotency key
  accountId: string;        // WaPay customer ID
  journalEntryId: string;   // WaPay journal entry ID
}

/**
 * Base purchase result
 */
export interface BasePurchaseResult {
  providerRef: string;      // Blu transaction reference
  amountCents: number;      // Amount charged
  dateTime: string;         // ISO 8601 timestamp
}

// ============================================================================
// Mobile Airtime
// ============================================================================

export interface AirtimePurchaseParams extends BasePurchaseParams {
  msisdn: string;           // Phone number (+27821234567)
  amountCents: number;      // Amount in cents
  vendorId: string;         // Network: vodacom, mtn, cellc, telkom
}

export interface AirtimePurchaseResult extends BasePurchaseResult {
  vendorName: string;       // Network display name
  mobileNumber: string;     // Phone number
}

// ============================================================================
// Mobile Data
// ============================================================================

export interface DataPurchaseParams extends BasePurchaseParams {
  msisdn: string;           // Phone number
  productId: string;        // Bundle ID from catalog
  vendorId: string;         // Network identifier
}

export interface DataPurchaseResult extends BasePurchaseResult {
  productName: string;      // Bundle name
  vendorName: string;       // Network display name
  mobileNumber: string;     // Phone number
}

export interface DataProduct {
  id: string;
  name: string;
  category: string;
  vendorId: string;
  amountCents: number;
  sizeMb?: number;
  validityDays?: number;
}

// ============================================================================
// Prepaid Electricity (STS)
// ============================================================================

/**
 * Electricity purchase request
 * 
 * Endpoint: POST /electricity/sales
 * PurchaseType: TOKEN_BASED
 */
export interface ElectricityPurchaseParams extends BasePurchaseParams {
  meterNumber: string;      // 11-13 digit STS meter number
  amountCents: number;      // Amount in cents (excl. service fees)
  municipalityCode?: string; // Optional: specific utility provider
  vendMetaData?: VendMetaData;
}

export interface ElectricityPurchaseResult extends BasePurchaseResult {
  token: string;            // STS token (20 digits)
  tokenType: 'STS_1' | 'STS_2';
  units: number;            // kWh purchased
  unitRate: number;         // Rate per kWh (cents)
  meterNumber: string;      // Echoed meter number
  municipalityName?: string;// Utility provider name
  customerName?: string;    // Name on meter account
  customerAddress?: string; // Address on meter account
  arrears?: number;         // Outstanding arrears (cents)
  debt?: number;            // Debt collected (cents)
  vat?: number;             // VAT amount (cents)
  serviceCharge?: number;   // Service charge (cents)
}

/**
 * Meter validation response
 * 
 * Endpoint: GET /electricity/meter/validate?meterNumber=xxx
 */
export interface MeterValidationResult {
  meterNumber: string;
  valid: boolean;
  customerName?: string;
  customerAddress?: string;
  municipalityCode?: string;
  municipalityName?: string;
  meterType?: string;
  lastPurchaseDate?: string;
  arrears?: number;
}

// ============================================================================
// PayTV (DStv, GOtv)
// ============================================================================

/**
 * DStv/PayTV payment request
 * 
 * Endpoint: POST /paytv/dstv/payments
 * PurchaseType: INSTANT_VEND
 */
export interface DstvPaymentParams extends BasePurchaseParams {
  smartcardNumber: string;  // 10-digit DStv smartcard number
  productId?: string;       // Subscription package ID (for upgrades)
  amountCents?: number;     // Payment amount (for balance payments)
  paymentType: 'SUBSCRIPTION' | 'BALANCE' | 'RECONNECT';
}

export interface DstvPaymentResult extends BasePurchaseResult {
  smartcardNumber: string;
  customerName: string;
  packageName?: string;
  expiryDate?: string;      // ISO 8601
  balance?: number;         // Account balance (cents)
  dueDate?: string;         // Next payment due
}

/**
 * DStv account lookup
 * 
 * Endpoint: GET /paytv/dstv/account?smartcard=xxx
 */
export interface DstvAccountInfo {
  smartcardNumber: string;
  customerName: string;
  packageName: string;
  packagePrice: number;     // Monthly price (cents)
  status: 'ACTIVE' | 'SUSPENDED' | 'DISCONNECTED';
  expiryDate: string;
  balance: number;          // Outstanding (cents)
  dueDate?: string;
}

// ============================================================================
// OTT Vouchers (Showmax, BoxOffice, etc.)
// ============================================================================

/**
 * OTT voucher purchase request
 * 
 * Endpoint: POST /voucher/ott/purchase
 * PurchaseType: PIN_BASED
 */
export interface OttVoucherPurchaseParams extends BasePurchaseParams {
  providerId: string;       // showmax, boxoffice, netflix_pin, etc.
  productId: string;        // Package ID
  amountCents?: number;     // For variable amount vouchers
  recipientEmail?: string;  // For digital delivery
  recipientMsisdn?: string; // For SMS delivery
}

export interface OttVoucherPurchaseResult extends BasePurchaseResult {
  voucherCode: string;      // Redemption code/PIN
  voucherSerial?: string;   // Serial number
  expiryDate: string;       // ISO 8601
  productName: string;      // Package name
  instructions: string;     // Redemption instructions
}

/**
 * OTT product catalog
 */
export interface OttProduct {
  id: string;
  providerId: string;
  providerName: string;     // "Showmax", "BoxOffice"
  name: string;             // "Showmax 1 Month"
  amountCents: number;
  validityDays: number;
  description?: string;
  isVariableAmount?: boolean;
}

// ============================================================================
// Retail Vouchers (Pick n Pay, Shoprite, Checkers, etc.)
// ============================================================================

/**
 * Retail voucher purchase request
 * 
 * Endpoint: POST /voucher/retail/purchase
 * PurchaseType: PIN_BASED
 */
export interface RetailVoucherPurchaseParams extends BasePurchaseParams {
  retailerId: string;       // picknpay, shoprite, checkers, woolworths
  productId: string;        // Voucher product ID
  amountCents: number;      // Fixed or variable amount
  recipientMsisdn?: string; // For SMS delivery
}

export interface RetailVoucherPurchaseResult extends BasePurchaseResult {
  voucherCode: string;      // Voucher PIN/code
  voucherSerial?: string;   // Serial number
  barcode?: string;         // Barcode data (for scanning)
  barcodeFormat?: string;   // 'CODE128', 'QR', etc.
  expiryDate: string;       // ISO 8601
  retailerName: string;
  productName: string;
  instructions: string;     // Usage instructions
}

/**
 * Retail voucher product
 */
export interface RetailVoucherProduct {
  id: string;
  retailerId: string;
  retailerName: string;
  name: string;
  amountCents: number;
  isVariableAmount?: boolean;
  minCents?: number;
  maxCents?: number;
  validityDays?: number;
}

// ============================================================================
// Betting & Gaming (Hollywoodbets, Betway, Sportingbet, etc.)
// ============================================================================

/**
 * Betting account top-up request
 * 
 * Endpoint: POST /betting/{provider}/topup
 * PurchaseType: INSTANT_VEND
 */
export interface BettingTopUpParams extends BasePurchaseParams {
  providerId: string;           // hollywoodbets, betway, sportingbet
  accountId: string;            // User's betting account ID
  accountMsisdn?: string;       // Phone number linked to account
  amountCents: number;          // Top-up amount
}

export interface BettingTopUpResult extends BasePurchaseResult {
  providerId: string;
  providerName: string;         // "Hollywoodbets"
  accountId: string;
  newBalance?: number;          // Updated balance (cents)
  bonusAmount?: number;         // Any bonus credited (cents)
}

/**
 * Betting account validation
 * 
 * Endpoint: GET /betting/{provider}/validate?accountId=xxx
 */
export interface BettingAccountValidation {
  providerId: string;
  accountId: string;
  valid: boolean;
  accountHolderName?: string;
  msisdn?: string;
  currentBalance?: number;      // Current balance (cents)
}

// ============================================================================
// Generic Vouchers (1Voucher, Flash, etc.)
// ============================================================================

/**
 * Generic voucher purchase request
 * 
 * Endpoint: POST /voucher/generic/purchase
 * PurchaseType: PIN_BASED
 */
export interface GenericVoucherPurchaseParams extends BasePurchaseParams {
  providerId: string;           // 1voucher, flash, blu_voucher
  productId?: string;           // Product ID (if fixed denomination)
  amountCents?: number;         // Amount (if variable)
}

export interface GenericVoucherPurchaseResult extends BasePurchaseResult {
  voucherPin: string;           // Voucher PIN
  voucherSerial?: string;       // Serial number
  expiryDate: string;           // ISO 8601
  productName: string;
  instructions?: string;
}

// ============================================================================
// Universal VAS Response Types
// ============================================================================

/**
 * Generic VAS purchase response that can hold any product type
 */
export interface GenericVasResponse {
  success: boolean;
  providerRef: string;
  amountCents: number;
  dateTime: string;
  category: VasCategory;
  purchaseType: PurchaseType;
  
  // Type-specific fields (only one will be populated)
  airtime?: {
    vendorName: string;
    mobileNumber: string;
  };
  
  data?: {
    productName: string;
    vendorName: string;
    mobileNumber: string;
  };
  
  electricity?: {
    token: string;
    units: number;
    meterNumber: string;
    customerName?: string;
  };
  
  paytv?: {
    smartcardNumber: string;
    customerName: string;
    packageName?: string;
    expiryDate?: string;
  };
  
  voucher?: {
    code: string;
    serial?: string;
    expiryDate: string;
    instructions?: string;
  };
  
  betting?: {
    accountId: string;
    newBalance?: number;
  };
}

// ============================================================================
// NLP Intent Types (for Mem0 integration)
// ============================================================================

/**
 * VAS Intent classification result
 */
export interface VasIntent {
  category: VasCategory;
  confidence: number;
  
  // Extracted entities
  amountCents?: number;
  msisdn?: string;
  meterNumber?: string;
  smartcardNumber?: string;
  bettingAccountId?: string;
  productName?: string;
  networkCode?: string;
  
  // Context from Mem0
  defaultNetwork?: string;      // User's preferred network
  defaultMeterNumber?: string;  // Saved meter number
  savedSmartcard?: string;      // Saved DStv smartcard
  savedBettingAccount?: string; // Saved betting account
}

// ============================================================================
// Provider Mapping
// ============================================================================

/**
 * Supported VAS providers by category
 */
export const VAS_PROVIDERS = {
  AIRTIME: {
    vodacom: { name: 'Vodacom', prefixes: ['082', '072'] },
    mtn: { name: 'MTN', prefixes: ['083', '073', '078'] },
    cellc: { name: 'Cell C', prefixes: ['084', '074'] },
    telkom: { name: 'Telkom', prefixes: ['081', '071'] },
  },
  
  DATA: {
    vodacom: { name: 'Vodacom' },
    mtn: { name: 'MTN' },
    cellc: { name: 'Cell C' },
    telkom: { name: 'Telkom' },
  },
  
  ELECTRICITY: {
    eskom: { name: 'Eskom' },
    city_power: { name: 'City Power' },
    tshwane: { name: 'City of Tshwane' },
    cape_town: { name: 'City of Cape Town' },
    ethekwini: { name: 'eThekwini Electricity' },
    // Blu auto-detects municipality from meter number
  },
  
  PAYTV: {
    dstv: { name: 'DStv' },
    gotv: { name: 'GOtv' },
    starsat: { name: 'StarSat' },
  },
  
  OTT: {
    showmax: { name: 'Showmax' },
    boxoffice: { name: 'BoxOffice' },
    netflix_pin: { name: 'Netflix PIN' },
    amazon_prime: { name: 'Amazon Prime' },
    disney_plus: { name: 'Disney+' },
  },
  
  RETAIL_VOUCHER: {
    picknpay: { name: 'Pick n Pay' },
    shoprite: { name: 'Shoprite' },
    checkers: { name: 'Checkers' },
    woolworths: { name: 'Woolworths' },
    spar: { name: 'Spar' },
    game: { name: 'Game' },
  },
  
  BETTING: {
    hollywoodbets: { name: 'Hollywoodbets' },
    betway: { name: 'Betway' },
    sportingbet: { name: 'Sportingbet' },
    sunbet: { name: 'Sunbet' },
    supabets: { name: 'Supabets' },
    playabets: { name: 'Playabets' },
  },
  
  VOUCHER: {
    '1voucher': { name: '1Voucher' },
    flash: { name: 'Flash' },
    blu_voucher: { name: 'Blu Voucher' },
  },
} as const;

/**
 * Type-safe provider ID extraction
 */
export type AirtimeProviderId = keyof typeof VAS_PROVIDERS.AIRTIME;
export type DataProviderId = keyof typeof VAS_PROVIDERS.DATA;
export type ElectricityProviderId = keyof typeof VAS_PROVIDERS.ELECTRICITY;
export type PayTvProviderId = keyof typeof VAS_PROVIDERS.PAYTV;
export type OttProviderId = keyof typeof VAS_PROVIDERS.OTT;
export type RetailProviderId = keyof typeof VAS_PROVIDERS.RETAIL_VOUCHER;
export type BettingProviderId = keyof typeof VAS_PROVIDERS.BETTING;
export type VoucherProviderId = keyof typeof VAS_PROVIDERS.VOUCHER;

