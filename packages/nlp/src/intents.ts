/**
 * NLP Intent Classification
 * 
 * Classifies user messages into structured intents
 */

import { z } from 'zod';
import { extractAllEntities } from './entities.js';

/**
 * Supported intent types
 */
export type IntentType =
  | 'CHECK_BALANCE'
  | 'BUY_AIRTIME'
  | 'BUY_DATA'
  | 'BETTING_TOPUP'
  | 'P2P_SEND'
  | 'REDEEM_VOUCHER'
  | 'PAY_AT_STORE'
  | 'UNKNOWN';

/**
 * Base intent schema
 */
export const BaseIntentSchema = z.object({
  intent: z.string(),
  confidence: z.number().min(0).max(1),
  raw: z.string(),
});

/**
 * Check Balance Intent
 * 
 * Note: Customer only sees ONE balance (WaPay balance).
 * Internal accounting (wallet vs gift) is hidden from customer.
 */
export const CheckBalanceIntentSchema = BaseIntentSchema.extend({
  intent: z.literal('CHECK_BALANCE'),
});

export type CheckBalanceIntent = z.infer<typeof CheckBalanceIntentSchema>;

/**
 * Buy Airtime Intent
 */
export const BuyAirtimeIntentSchema = BaseIntentSchema.extend({
  intent: z.literal('BUY_AIRTIME'),
  amountCents: z.number().optional(),
  networkCode: z.string().optional(), // vodacom, mtn, cellc, telkom
  targetMsisdn: z.string().optional(),
});

export type BuyAirtimeIntent = z.infer<typeof BuyAirtimeIntentSchema>;

/**
 * Buy Data Intent
 */
export const BuyDataIntentSchema = BaseIntentSchema.extend({
  intent: z.literal('BUY_DATA'),
  dataMb: z.number().optional(),
  networkCode: z.string().optional(), // vodacom, mtn, cellc, telkom
  targetMsisdn: z.string().optional(),
  productId: z.string().optional(), // Bundle product ID from catalog
  bundlePreference: z.string().optional(), // "daily", "weekly", "monthly"
});

export type BuyDataIntent = z.infer<typeof BuyDataIntentSchema>;

/**
 * Betting Top-up Intent
 */
export const BettingTopupIntentSchema = BaseIntentSchema.extend({
  intent: z.literal('BETTING_TOPUP'),
  operatorCode: z.string().optional(),
  amountCents: z.number().optional(),
});

export type BettingTopupIntent = z.infer<typeof BettingTopupIntentSchema>;

/**
 * P2P Send Intent
 */
export const P2PSendIntentSchema = BaseIntentSchema.extend({
  intent: z.literal('P2P_SEND'),
  amountCents: z.number().optional(),
  targetMsisdn: z.string().optional(),
  contactName: z.string().optional(),
  note: z.string().optional(),
});

export type P2PSendIntent = z.infer<typeof P2PSendIntentSchema>;

/**
 * Redeem Voucher Intent
 */
export const RedeemVoucherIntentSchema = BaseIntentSchema.extend({
  intent: z.literal('REDEEM_VOUCHER'),
  pin: z.string().optional(),
});

export type RedeemVoucherIntent = z.infer<typeof RedeemVoucherIntentSchema>;

/**
 * Pay at Store Intent (Yoyo wiCode)
 */
export const PayAtStoreIntentSchema = BaseIntentSchema.extend({
  intent: z.literal('PAY_AT_STORE'),
  amountCents: z.number().optional(),
  merchantName: z.string().optional(),
});

export type PayAtStoreIntent = z.infer<typeof PayAtStoreIntentSchema>;

/**
 * Unknown Intent
 */
export const UnknownIntentSchema = BaseIntentSchema.extend({
  intent: z.literal('UNKNOWN'),
  reason: z.string().optional(),
});

export type UnknownIntent = z.infer<typeof UnknownIntentSchema>;

/**
 * Union of all intent types
 */
export type Intent =
  | CheckBalanceIntent
  | BuyAirtimeIntent
  | BuyDataIntent
  | BettingTopupIntent
  | P2PSendIntent
  | RedeemVoucherIntent
  | PayAtStoreIntent
  | UnknownIntent;

/**
 * Intent classification keywords
 */
const INTENT_PATTERNS: Array<{
  intent: IntentType;
  keywords: string[];
  patterns: RegExp[];
}> = [
  {
    intent: 'CHECK_BALANCE',
    keywords: ['balance', 'wallet', 'money', 'how much'],
    patterns: [
      /\b(check|what|show|my)\s+(balance|wallet|money)\b/i,
      /how\s+much\s+(do\s+i\s+have|money)/i,
      /\bbalance\b/i,
    ],
  },
  {
    intent: 'BUY_AIRTIME',
    keywords: ['airtime', 'recharge', 'top up', 'topup'],
    patterns: [
      /\b(buy|purchase|get|need)\s+(airtime|recharge)/i,
      /\b(recharge|top\s*up|topup)\b/i,
      /\bairtime\b/i,
    ],
  },
  {
    intent: 'BUY_DATA',
    keywords: ['data', 'bundle', 'gb', 'mb', 'gig'],
    patterns: [
      /\b(buy|purchase|get|need)\s+(data|bundle)/i,
      /\b\d+\s*(gb|mb|gig)/i,
      /\bdata\b/i,
      /\bbundle\b/i,
    ],
  },
  {
    intent: 'BETTING_TOPUP',
    keywords: ['bet', 'betting', 'hollywoodbets', 'betway', 'lottostar'],
    patterns: [
      /\b(top\s*up|topup|deposit)\s+(hollywoodbets|betway|lottostar)/i,
      /\bhollywoodbets\b/i,
      /\bbetway\b/i,
      /\blottostar\b/i,
    ],
  },
  {
    intent: 'P2P_SEND',
    keywords: ['send', 'transfer', 'pay'],
    patterns: [
      /\b(send|transfer|pay)\s+(money|r\d+|\d+\s*rand)/i,
      /\bsend\s+.+\s+to\s+/i,
    ],
  },
  {
    intent: 'REDEEM_VOUCHER',
    keywords: ['redeem', 'voucher', 'pin', 'code'],
    patterns: [
      /\b(redeem|use)\s+(voucher|pin|code)/i,
      /\bvoucher\b/i,
      /\bpin\b/i,
    ],
  },
  {
    intent: 'PAY_AT_STORE',
    keywords: ['pay at', 'store', 'checkers', 'shoprite', 'pnp', 'till'],
    patterns: [
      /\bpay\s+at\s+/i,
      /\b(checkers|shoprite|pnp|pick\s*n\s*pay|spar)\b/i,
      /\bstore\b/i,
      /\btill\b/i,
    ],
  },
];

/**
 * Classify user message into intent
 * 
 * @param text - User message
 * @returns Classified intent with extracted entities
 */
export function classifyIntent(text: string): Intent {
  const normalizedText = text.toLowerCase().trim();
  
  // Extract entities first
  const entities = extractAllEntities(text);
  
  // Check each intent pattern
  for (const { intent, keywords, patterns } of INTENT_PATTERNS) {
    // Check keywords
    const hasKeyword = keywords.some((keyword) =>
      normalizedText.includes(keyword.toLowerCase())
    );
    
    // Check regex patterns
    const hasPattern = patterns.some((pattern) => pattern.test(text));
    
    if (hasKeyword || hasPattern) {
      // Build intent object based on type
      switch (intent) {
        case 'CHECK_BALANCE':
          return {
            intent: 'CHECK_BALANCE',
            confidence: hasPattern ? 0.9 : 0.7,
            raw: text,
          };
          
        case 'BUY_AIRTIME':
          return {
            intent: 'BUY_AIRTIME',
            confidence: hasPattern ? 0.9 : 0.7,
            raw: text,
            amountCents: entities.amount?.cents,
            networkCode: entities.network?.code,
            targetMsisdn: entities.msisdn?.normalized,
          };
          
        case 'BUY_DATA':
          return {
            intent: 'BUY_DATA',
            confidence: hasPattern ? 0.9 : 0.7,
            raw: text,
            dataMb: entities.dataQuantity?.mb,
            networkCode: entities.network?.code,
            targetMsisdn: entities.msisdn?.normalized,
            bundlePreference: extractBundlePreference(text),
          };
          
        case 'BETTING_TOPUP':
          return {
            intent: 'BETTING_TOPUP',
            confidence: hasPattern ? 0.9 : 0.7,
            raw: text,
            operatorCode: entities.bettingOperator?.code,
            amountCents: entities.amount?.cents,
          };
          
        case 'P2P_SEND':
          return {
            intent: 'P2P_SEND',
            confidence: hasPattern ? 0.9 : 0.7,
            raw: text,
            amountCents: entities.amount?.cents,
            targetMsisdn: entities.msisdn?.normalized,
            contactName: extractContactName(text),
          };
          
        case 'REDEEM_VOUCHER':
          return {
            intent: 'REDEEM_VOUCHER',
            confidence: hasPattern ? 0.9 : 0.7,
            raw: text,
            pin: extractVoucherPin(text),
          };
          
        case 'PAY_AT_STORE':
          return {
            intent: 'PAY_AT_STORE',
            confidence: hasPattern ? 0.9 : 0.7,
            raw: text,
            amountCents: entities.amount?.cents,
            merchantName: extractMerchantName(text),
          };
      }
    }
  }
  
  // No intent matched
  return {
    intent: 'UNKNOWN',
    confidence: 0,
    raw: text,
    reason: 'No matching intent pattern found',
  };
}

/**
 * Helper: Extract bundle preference (daily, weekly, monthly)
 */
function extractBundlePreference(text: string): string | undefined {
  if (/\b(daily|day|1\s*day)\b/i.test(text)) return 'daily';
  if (/\b(weekly|week|7\s*days?)\b/i.test(text)) return 'weekly';
  if (/\b(monthly|month|30\s*days?)\b/i.test(text)) return 'monthly';
  return undefined;
}

/**
 * Helper: Extract contact name from "send to X"
 */
function extractContactName(text: string): string | undefined {
  const match = text.match(/\bto\s+([a-z]+)\b/i);
  return match ? match[1] : undefined;
}

/**
 * Helper: Extract voucher PIN (16 digits with optional spaces)
 */
function extractVoucherPin(text: string): string | undefined {
  // Match 16 digits with optional spaces/dashes
  const match = text.match(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/);
  return match ? match[0].replace(/[\s-]/g, '') : undefined;
}

/**
 * Helper: Extract merchant name
 */
function extractMerchantName(text: string): string | undefined {
  const merchants = [
    'checkers',
    'shoprite',
    'pnp',
    'pick n pay',
    'spar',
    'woolworths',
    'makro',
  ];
  
  for (const merchant of merchants) {
    if (new RegExp(`\\b${merchant}\\b`, 'i').test(text)) {
      return merchant;
    }
  }
  
  return undefined;
}

/**
 * Check if intent has all required entities
 * 
 * @param intent - Classified intent
 * @returns Missing entity names, or empty array if complete
 */
export function getMissingEntities(intent: Intent): string[] {
  const missing: string[] = [];
  
  switch (intent.intent) {
    case 'BUY_AIRTIME':
      if (!intent.amountCents) missing.push('amount');
      if (!intent.targetMsisdn) missing.push('phone number');
      break;
      
    case 'BUY_DATA':
      if (!intent.dataMb) missing.push('data amount');
      if (!intent.targetMsisdn) missing.push('phone number');
      break;
      
    case 'BETTING_TOPUP':
      if (!intent.operatorCode) missing.push('betting operator');
      if (!intent.amountCents) missing.push('amount');
      break;
      
    case 'P2P_SEND':
      if (!intent.amountCents) missing.push('amount');
      if (!intent.targetMsisdn) missing.push('phone number');
      break;
      
    case 'REDEEM_VOUCHER':
      if (!intent.pin) missing.push('voucher PIN');
      break;
      
    case 'PAY_AT_STORE':
      if (!intent.amountCents) missing.push('amount');
      if (!intent.merchantName) missing.push('store name');
      break;
  }
  
  return missing;
}

