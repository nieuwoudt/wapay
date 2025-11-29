/**
 * Extended VAS Intent Classification
 * 
 * Adds support for ALL Blu VAS products:
 * - Electricity (STS)
 * - DStv/PayTV
 * - OTT (Showmax, BoxOffice)
 * - Retail Vouchers (Pick n Pay, Shoprite)
 * - Betting (Hollywoodbets, Betway)
 * 
 * Integrates with Mem0 for contextual memory
 * 
 * @see packages/providers/blu/src/vas-types.ts
 */

import { z } from 'zod';
import { extractAllEntities } from './entities.js';

// ============================================================================
// Extended Intent Types
// ============================================================================

export type ExtendedIntentType =
  // Existing
  | 'CHECK_BALANCE'
  | 'BUY_AIRTIME'
  | 'BUY_DATA'
  | 'BETTING_TOPUP'
  | 'P2P_SEND'
  | 'REDEEM_VOUCHER'
  | 'PAY_AT_STORE'
  // New VAS
  | 'BUY_ELECTRICITY'
  | 'PAY_DSTV'
  | 'BUY_SHOWMAX'
  | 'BUY_OTT_VOUCHER'
  | 'BUY_RETAIL_VOUCHER'
  // Unknown
  | 'UNKNOWN';

// ============================================================================
// New VAS Intent Schemas
// ============================================================================

export const BaseIntentSchema = z.object({
  intent: z.string(),
  confidence: z.number().min(0).max(1),
  raw: z.string(),
});

/**
 * Buy Electricity Intent
 * 
 * User says things like:
 * - "Buy R50 electricity"
 * - "Recharge my meter"
 * - "Get electricity token"
 * - "Power for 1234567890123"
 */
export const BuyElectricityIntentSchema = BaseIntentSchema.extend({
  intent: z.literal('BUY_ELECTRICITY'),
  amountCents: z.number().optional(),
  meterNumber: z.string().optional(),
  municipalityCode: z.string().optional(),
});

export type BuyElectricityIntent = z.infer<typeof BuyElectricityIntentSchema>;

/**
 * Pay DStv Intent
 * 
 * User says things like:
 * - "Pay my DStv"
 * - "Top up DStv R299"
 * - "DStv for smartcard 1234567890"
 * - "Reconnect my DStv"
 */
export const PayDstvIntentSchema = BaseIntentSchema.extend({
  intent: z.literal('PAY_DSTV'),
  amountCents: z.number().optional(),
  smartcardNumber: z.string().optional(),
  paymentType: z.enum(['SUBSCRIPTION', 'BALANCE', 'RECONNECT']).optional(),
});

export type PayDstvIntent = z.infer<typeof PayDstvIntentSchema>;

/**
 * Buy Showmax Intent
 * 
 * User says things like:
 * - "Get R50 Showmax"
 * - "Buy Showmax voucher"
 * - "Showmax monthly subscription"
 */
export const BuyShowmaxIntentSchema = BaseIntentSchema.extend({
  intent: z.literal('BUY_SHOWMAX'),
  productId: z.string().optional(), // e.g., "showmax_1month"
  amountCents: z.number().optional(),
});

export type BuyShowmaxIntent = z.infer<typeof BuyShowmaxIntentSchema>;

/**
 * Buy OTT Voucher Intent (Generic OTT)
 * 
 * User says things like:
 * - "Buy Netflix voucher"
 * - "Disney+ subscription"
 * - "BoxOffice R50"
 */
export const BuyOttVoucherIntentSchema = BaseIntentSchema.extend({
  intent: z.literal('BUY_OTT_VOUCHER'),
  providerId: z.string().optional(), // showmax, netflix_pin, disney_plus, boxoffice
  productId: z.string().optional(),
  amountCents: z.number().optional(),
});

export type BuyOttVoucherIntent = z.infer<typeof BuyOttVoucherIntentSchema>;

/**
 * Buy Retail Voucher Intent
 * 
 * User says things like:
 * - "Buy R100 Pick n Pay voucher"
 * - "Shoprite gift card R50"
 * - "Checkers voucher"
 */
export const BuyRetailVoucherIntentSchema = BaseIntentSchema.extend({
  intent: z.literal('BUY_RETAIL_VOUCHER'),
  retailerId: z.string().optional(), // picknpay, shoprite, checkers, woolworths
  amountCents: z.number().optional(),
});

export type BuyRetailVoucherIntent = z.infer<typeof BuyRetailVoucherIntentSchema>;

/**
 * Extended Betting Topup Intent (enhanced from base)
 * 
 * User says things like:
 * - "Top up Hollywoodbets R100"
 * - "Put R50 on my Betway"
 * - "Fund my Sportingbet account"
 */
export const ExtendedBettingTopupIntentSchema = BaseIntentSchema.extend({
  intent: z.literal('BETTING_TOPUP'),
  providerId: z.string().optional(), // hollywoodbets, betway, sportingbet
  amountCents: z.number().optional(),
  accountId: z.string().optional(), // User's betting account ID
  accountMsisdn: z.string().optional(), // Phone linked to account
});

export type ExtendedBettingTopupIntent = z.infer<typeof ExtendedBettingTopupIntentSchema>;

/**
 * Union of all extended VAS intents
 */
export type ExtendedVasIntent =
  | BuyElectricityIntent
  | PayDstvIntent
  | BuyShowmaxIntent
  | BuyOttVoucherIntent
  | BuyRetailVoucherIntent
  | ExtendedBettingTopupIntent;

// ============================================================================
// Extended Intent Patterns
// ============================================================================

export const EXTENDED_INTENT_PATTERNS: Array<{
  intent: ExtendedIntentType;
  keywords: string[];
  patterns: RegExp[];
}> = [
  // Electricity
  {
    intent: 'BUY_ELECTRICITY',
    keywords: ['electricity', 'power', 'prepaid', 'meter', 'token', 'eskom', 'units'],
    patterns: [
      /\b(buy|get|purchase|need)\s+(electricity|power|prepaid)\b/i,
      /\b(recharge|top\s*up)\s+(my\s+)?(meter|electricity)\b/i,
      /\belectricity\s+(token|voucher)\b/i,
      /\bprepaid\s+(electricity|power)\b/i,
      /\bmeter\s+number\b/i,
      /\beskom\b/i,
      /\bkwh?\b/i, // kilowatt-hours
    ],
  },
  
  // DStv / PayTV
  {
    intent: 'PAY_DSTV',
    keywords: ['dstv', 'gotv', 'multichoice', 'smartcard', 'decoder', 'subscription'],
    patterns: [
      /\b(pay|top\s*up|renew|recharge)\s+(my\s+)?dstv\b/i,
      /\bdstv\s+(payment|subscription|bouquet)\b/i,
      /\b(reconnect|activate)\s+(my\s+)?dstv\b/i,
      /\bgotv\b/i,
      /\bsmartcard\b/i,
      /\bdecoder\b/i,
      /\bmultichoice\b/i,
    ],
  },
  
  // Showmax (specific OTT)
  {
    intent: 'BUY_SHOWMAX',
    keywords: ['showmax'],
    patterns: [
      /\b(buy|get|purchase)\s+(showmax|show\s*max)\b/i,
      /\bshowmax\s+(voucher|subscription|monthly)\b/i,
    ],
  },
  
  // Other OTT (Netflix, Disney+, BoxOffice, etc.)
  {
    intent: 'BUY_OTT_VOUCHER',
    keywords: ['netflix', 'disney', 'disney+', 'boxoffice', 'prime', 'amazon', 'streaming'],
    patterns: [
      /\b(buy|get|purchase)\s+(netflix|disney|amazon\s*prime)\b/i,
      /\bnetflix\s+(voucher|pin|card)\b/i,
      /\bdisney\s*\+?\s*(voucher|subscription)\b/i,
      /\bbox\s*office\b/i,
      /\bstreaming\s+(voucher|subscription)\b/i,
    ],
  },
  
  // Retail Vouchers
  {
    intent: 'BUY_RETAIL_VOUCHER',
    keywords: ['voucher', 'gift card', 'gift voucher', 'shopping voucher'],
    patterns: [
      /\b(buy|get|purchase)\s+(pick\s*n\s*pay|pnp|shoprite|checkers|woolworths|spar|game)\s+(voucher|gift\s*card)\b/i,
      /\b(pick\s*n\s*pay|pnp|shoprite|checkers|woolworths|spar)\s+(voucher|gift\s*card)\b/i,
      /\bgift\s*(card|voucher)\s+for\s+(pick\s*n\s*pay|shoprite|checkers)\b/i,
      /\bshopping\s+(voucher|gift\s*card)\b/i,
    ],
  },
  
  // Enhanced Betting patterns
  {
    intent: 'BETTING_TOPUP',
    keywords: ['hollywoodbets', 'betway', 'sportingbet', 'sunbet', 'supabets', 'playabets', 'bet'],
    patterns: [
      /\b(top\s*up|fund|deposit|put)\s+(hollywoodbets|betway|sportingbet|sunbet|supabets|playabets)\b/i,
      /\bhollywoodbets?\b/i,
      /\bbetway\b/i,
      /\bsportingbet\b/i,
      /\bsunbet\b/i,
      /\bsupabets\b/i,
      /\bplayabets\b/i,
      /\b(bet|betting)\s+account\b/i,
      /\bfund\s+(my\s+)?bet\b/i,
    ],
  },
];

// ============================================================================
// Entity Extractors
// ============================================================================

/**
 * Extract meter number from text
 * STS meter numbers are typically 11-13 digits
 */
export function extractMeterNumber(text: string): string | undefined {
  // Match 11-13 consecutive digits (STS meter number format)
  const match = text.match(/\b\d{11,13}\b/);
  return match ? match[0] : undefined;
}

/**
 * Extract DStv smartcard number from text
 * Smartcard numbers are typically 10 digits starting with 1, 2, 3, or 7
 */
export function extractSmartcardNumber(text: string): string | undefined {
  const match = text.match(/\b[1237]\d{9}\b/);
  return match ? match[0] : undefined;
}

/**
 * Extract OTT provider from text
 */
export function extractOttProvider(text: string): string | undefined {
  const providers: Record<string, string[]> = {
    'showmax': ['showmax', 'show max'],
    'netflix_pin': ['netflix'],
    'disney_plus': ['disney', 'disney+', 'disneyplus'],
    'boxoffice': ['boxoffice', 'box office'],
    'amazon_prime': ['amazon', 'prime', 'amazon prime'],
  };
  
  const lowerText = text.toLowerCase();
  for (const [id, keywords] of Object.entries(providers)) {
    if (keywords.some(k => lowerText.includes(k))) {
      return id;
    }
  }
  return undefined;
}

/**
 * Extract retail voucher provider from text
 */
export function extractRetailProvider(text: string): string | undefined {
  const providers: Record<string, string[]> = {
    'picknpay': ['pick n pay', 'pick and pay', 'pnp'],
    'shoprite': ['shoprite'],
    'checkers': ['checkers'],
    'woolworths': ['woolworths', 'woolies'],
    'spar': ['spar'],
    'game': ['game'],
  };
  
  const lowerText = text.toLowerCase();
  for (const [id, keywords] of Object.entries(providers)) {
    if (keywords.some(k => lowerText.includes(k))) {
      return id;
    }
  }
  return undefined;
}

/**
 * Extract betting provider from text
 */
export function extractBettingProvider(text: string): string | undefined {
  const providers: Record<string, string[]> = {
    'hollywoodbets': ['hollywoodbets', 'hollywood bets', 'hollywood'],
    'betway': ['betway'],
    'sportingbet': ['sportingbet', 'sporting bet'],
    'sunbet': ['sunbet', 'sun bet'],
    'supabets': ['supabets', 'supa bets'],
    'playabets': ['playabets', 'playa bets'],
  };
  
  const lowerText = text.toLowerCase();
  for (const [id, keywords] of Object.entries(providers)) {
    if (keywords.some(k => lowerText.includes(k))) {
      return id;
    }
  }
  return undefined;
}

/**
 * Extract DStv payment type from text
 */
export function extractDstvPaymentType(text: string): 'SUBSCRIPTION' | 'BALANCE' | 'RECONNECT' | undefined {
  const lowerText = text.toLowerCase();
  if (/\b(reconnect|activate|reactivate)\b/.test(lowerText)) return 'RECONNECT';
  if (/\b(arrears?|balance|owe|debt|pay\s+off)\b/.test(lowerText)) return 'BALANCE';
  if (/\b(subscription|bouquet|package|renew|monthly)\b/.test(lowerText)) return 'SUBSCRIPTION';
  return 'SUBSCRIPTION'; // Default to subscription
}

// ============================================================================
// Extended Intent Classification
// ============================================================================

/**
 * Classify user message with extended VAS intents
 * 
 * @param text - User message
 * @param mem0Context - Context from Mem0 (saved preferences, recent transactions)
 * @returns Classified intent with extracted entities
 */
export function classifyExtendedIntent(
  text: string,
  mem0Context?: {
    savedMeterNumber?: string;
    savedSmartcard?: string;
    defaultBettingAccount?: string;
    defaultBettingProvider?: string;
    lastPurchaseType?: string;
  }
): ExtendedVasIntent | null {
  const normalizedText = text.toLowerCase().trim();
  const entities = extractAllEntities(text);
  
  // Check extended patterns
  for (const { intent, keywords, patterns } of EXTENDED_INTENT_PATTERNS) {
    const hasKeyword = keywords.some(k => normalizedText.includes(k.toLowerCase()));
    const hasPattern = patterns.some(p => p.test(text));
    
    if (hasKeyword || hasPattern) {
      switch (intent) {
        case 'BUY_ELECTRICITY':
          return {
            intent: 'BUY_ELECTRICITY',
            confidence: hasPattern ? 0.9 : 0.7,
            raw: text,
            amountCents: entities.amount?.cents,
            meterNumber: extractMeterNumber(text) || mem0Context?.savedMeterNumber,
          };
          
        case 'PAY_DSTV':
          return {
            intent: 'PAY_DSTV',
            confidence: hasPattern ? 0.9 : 0.7,
            raw: text,
            amountCents: entities.amount?.cents,
            smartcardNumber: extractSmartcardNumber(text) || mem0Context?.savedSmartcard,
            paymentType: extractDstvPaymentType(text),
          };
          
        case 'BUY_SHOWMAX':
          return {
            intent: 'BUY_SHOWMAX',
            confidence: hasPattern ? 0.95 : 0.8, // High confidence for specific brand
            raw: text,
            amountCents: entities.amount?.cents,
          };
          
        case 'BUY_OTT_VOUCHER':
          return {
            intent: 'BUY_OTT_VOUCHER',
            confidence: hasPattern ? 0.9 : 0.7,
            raw: text,
            providerId: extractOttProvider(text),
            amountCents: entities.amount?.cents,
          };
          
        case 'BUY_RETAIL_VOUCHER':
          return {
            intent: 'BUY_RETAIL_VOUCHER',
            confidence: hasPattern ? 0.9 : 0.7,
            raw: text,
            retailerId: extractRetailProvider(text),
            amountCents: entities.amount?.cents,
          };
          
        case 'BETTING_TOPUP':
          return {
            intent: 'BETTING_TOPUP',
            confidence: hasPattern ? 0.9 : 0.7,
            raw: text,
            providerId: extractBettingProvider(text) || mem0Context?.defaultBettingProvider,
            amountCents: entities.amount?.cents,
            accountId: mem0Context?.defaultBettingAccount,
          };
      }
    }
  }
  
  return null; // No extended intent matched
}

/**
 * Get missing entities for extended VAS intents
 */
export function getExtendedMissingEntities(intent: ExtendedVasIntent): string[] {
  const missing: string[] = [];
  
  switch (intent.intent) {
    case 'BUY_ELECTRICITY':
      if (!intent.amountCents) missing.push('amount');
      if (!intent.meterNumber) missing.push('meter number');
      break;
      
    case 'PAY_DSTV':
      if (!intent.smartcardNumber) missing.push('smartcard number');
      // Amount is optional for subscription payments (will use package price)
      break;
      
    case 'BUY_SHOWMAX':
    case 'BUY_OTT_VOUCHER':
      if (!intent.amountCents && !intent.productId) missing.push('amount or package');
      break;
      
    case 'BUY_RETAIL_VOUCHER':
      if (!intent.retailerId) missing.push('store name');
      if (!intent.amountCents) missing.push('amount');
      break;
      
    case 'BETTING_TOPUP':
      if (!intent.providerId) missing.push('betting operator');
      if (!intent.amountCents) missing.push('amount');
      break;
  }
  
  return missing;
}

// ============================================================================
// Disambiguation Templates
// ============================================================================

/**
 * Generate disambiguation question for missing entities
 */
export function generateDisambiguationQuestion(
  intent: ExtendedVasIntent,
  missing: string[]
): string {
  switch (intent.intent) {
    case 'BUY_ELECTRICITY':
      if (missing.includes('meter number')) {
        return 'Please enter your 11 to 13 digit prepaid meter number.';
      }
      if (missing.includes('amount')) {
        return 'How much electricity would you like to buy? (e.g., R50, R100, R200)';
      }
      break;
      
    case 'PAY_DSTV':
      if (missing.includes('smartcard number')) {
        return 'Please enter your 10-digit DStv smartcard number.';
      }
      break;
      
    case 'BUY_SHOWMAX':
    case 'BUY_OTT_VOUCHER':
      if (missing.includes('amount or package')) {
        return 'Which package would you like?\n\n• 1 Month - R99\n• 3 Months - R249\n\nOr enter an amount.';
      }
      break;
      
    case 'BUY_RETAIL_VOUCHER':
      if (missing.includes('store name')) {
        return 'Which store voucher would you like?\n\n• Pick n Pay\n• Shoprite\n• Checkers\n• Woolworths';
      }
      if (missing.includes('amount')) {
        return 'How much would you like on the voucher? (R50, R100, R200, R500)';
      }
      break;
      
    case 'BETTING_TOPUP':
      if (missing.includes('betting operator')) {
        return 'Which betting account would you like to top up?\n\n• Hollywoodbets\n• Betway\n• Sportingbet\n• Sunbet';
      }
      if (missing.includes('amount')) {
        return 'How much would you like to deposit?';
      }
      break;
  }
  
  return `Please provide the following: ${missing.join(', ')}`;
}

// ============================================================================
// Mem0 Integration Types
// ============================================================================

/**
 * User preferences to store in Mem0
 */
export interface VasUserPreferences {
  // Electricity
  savedMeterNumbers: Array<{
    meterNumber: string;
    nickname?: string; // "Home", "Mom's place"
    lastUsed: string;
  }>;
  
  // DStv
  savedSmartcards: Array<{
    smartcardNumber: string;
    customerName?: string;
    lastUsed: string;
  }>;
  
  // Betting
  bettingAccounts: Array<{
    providerId: string;
    accountId?: string;
    msisdn?: string;
    lastUsed: string;
  }>;
  
  // General preferences
  preferredNetwork?: string;
  preferredAmounts?: Record<string, number>; // e.g., { "electricity": 10000 }
}

/**
 * Extract preferences from conversation for Mem0 storage
 */
export function extractPreferencesForMem0(
  intent: ExtendedVasIntent,
  result: { success: boolean }
): Partial<VasUserPreferences> {
  const preferences: Partial<VasUserPreferences> = {};
  
  if (!result.success) return preferences;
  
  switch (intent.intent) {
    case 'BUY_ELECTRICITY':
      if (intent.meterNumber) {
        preferences.savedMeterNumbers = [{
          meterNumber: intent.meterNumber,
          lastUsed: new Date().toISOString(),
        }];
      }
      break;
      
    case 'PAY_DSTV':
      if (intent.smartcardNumber) {
        preferences.savedSmartcards = [{
          smartcardNumber: intent.smartcardNumber,
          lastUsed: new Date().toISOString(),
        }];
      }
      break;
      
    case 'BETTING_TOPUP':
      if (intent.providerId) {
        preferences.bettingAccounts = [{
          providerId: intent.providerId,
          accountId: intent.accountId,
          lastUsed: new Date().toISOString(),
        }];
      }
      break;
  }
  
  return preferences;
}

