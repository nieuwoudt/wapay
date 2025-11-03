/**
 * NLP Intent Router
 * 
 * Maps classified intents to API endpoint calls
 */

import type { Intent } from './intents';

/**
 * API route configuration
 */
export interface RouteConfig {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, any>;
  queryParams?: Record<string, string>;
}

/**
 * Routing result
 */
export interface RoutingResult {
  success: boolean;
  route?: RouteConfig;
  disambiguationNeeded?: {
    entity: string;
    prompt: string;
    quickReplies?: string[];
  };
  error?: string;
}

/**
 * Route an intent to an API endpoint
 * 
 * @param intent - Classified intent
 * @param accountId - User's account ID
 * @returns Routing configuration or disambiguation request
 */
export function routeIntent(
  intent: Intent,
  accountId: string
): RoutingResult {
  switch (intent.intent) {
    case 'CHECK_BALANCE':
      return {
        success: true,
        route: {
          method: 'GET',
          path: '/api/wallet/balance',
          queryParams: {
            accountId,
          },
        },
      };
      
    case 'BUY_AIRTIME':
      // Check for missing entities
      if (!intent.amountCents) {
        return {
          success: false,
          disambiguationNeeded: {
            entity: 'amount',
            prompt: 'How much airtime would you like to buy?',
            quickReplies: ['R10', 'R20', 'R50', 'R100'],
          },
        };
      }
      
      if (!intent.targetMsisdn) {
        return {
          success: false,
          disambiguationNeeded: {
            entity: 'phone_number',
            prompt: 'Which phone number should receive the airtime?',
          },
        };
      }
      
      // Network will be auto-detected by BFF if not provided
      return {
        success: true,
        route: {
          method: 'POST',
          path: '/api/vas/airtime/preview',
          body: {
            accountId,
            msisdn: intent.targetMsisdn,
            amountCents: intent.amountCents,
            vendorId: intent.networkCode, // Optional - BFF will auto-detect
          },
        },
      };
      
    case 'BUY_DATA':
      if (!intent.targetMsisdn) {
        return {
          success: false,
          disambiguationNeeded: {
            entity: 'phone_number',
            prompt: 'Which phone number should receive the data?',
          },
        };
      }
      
      // For data, we need to show bundles first
      // User needs to select a specific bundle (productId)
      if (!intent.productId) {
        // If we have network, show bundles for that network
        if (intent.networkCode) {
          return {
            success: true,
            route: {
              method: 'GET',
              path: `/api/vas/bundles/${intent.networkCode}`,
            },
          };
        }
        
        // Otherwise, ask for network first
        return {
          success: false,
          disambiguationNeeded: {
            entity: 'network',
            prompt: 'Which network?',
            quickReplies: ['Vodacom', 'MTN', 'Cell C', 'Telkom'],
          },
        };
      }
      
      // Have all required info - create preview
      return {
        success: true,
        route: {
          method: 'POST',
          path: '/api/vas/data/preview',
          body: {
            accountId,
            msisdn: intent.targetMsisdn,
            productId: intent.productId,
            vendorId: intent.networkCode,
          },
        },
      };
      
    case 'BETTING_TOPUP':
      if (!intent.operatorCode) {
        return {
          success: false,
          disambiguationNeeded: {
            entity: 'operator',
            prompt: 'Which betting site would you like to top up?',
            quickReplies: [
              'Hollywoodbets',
              'Betway',
              'LottoStar',
              'Supabets',
            ],
          },
        };
      }
      
      if (!intent.amountCents) {
        return {
          success: false,
          disambiguationNeeded: {
            entity: 'amount',
            prompt: 'How much would you like to deposit?',
            quickReplies: ['R50', 'R100', 'R200', 'R500'],
          },
        };
      }
      
      return {
        success: true,
        route: {
          method: 'POST',
          path: '/api/betting/topup/preview',
          body: {
            accountId,
            operatorCode: intent.operatorCode,
            amountCents: intent.amountCents,
          },
        },
      };
      
    case 'P2P_SEND':
      if (!intent.amountCents) {
        return {
          success: false,
          disambiguationNeeded: {
            entity: 'amount',
            prompt: 'How much would you like to send?',
          },
        };
      }
      
      if (!intent.targetMsisdn) {
        return {
          success: false,
          disambiguationNeeded: {
            entity: 'phone_number',
            prompt: 'Who would you like to send money to? (phone number)',
          },
        };
      }
      
      return {
        success: true,
        route: {
          method: 'POST',
          path: '/api/p2p/preview',
          body: {
            accountId,
            targetMsisdn: intent.targetMsisdn,
            amountCents: intent.amountCents,
            note: intent.note,
          },
        },
      };
      
    case 'REDEEM_VOUCHER':
      if (!intent.pin) {
        return {
          success: false,
          disambiguationNeeded: {
            entity: 'pin',
            prompt: 'Please enter your voucher PIN (16 digits):',
          },
        };
      }
      
      return {
        success: true,
        route: {
          method: 'POST',
          path: '/api/deposit/blu/redeem',
          body: {
            accountId,
            pin: intent.pin,
          },
        },
      };
      
    case 'PAY_AT_STORE':
      // Check if asking about eligibility first
      if (!intent.amountCents) {
        // User might be asking "Can I pay at Checkers?"
        if (intent.merchantName) {
          return {
            success: true,
            route: {
              method: 'GET',
              path: '/api/yoyo/eligible',
              queryParams: {
                merchantName: intent.merchantName,
              },
            },
          };
        }
        
        return {
          success: false,
          disambiguationNeeded: {
            entity: 'amount',
            prompt: 'How much do you need to pay?',
          },
        };
      }
      
      return {
        success: true,
        route: {
          method: 'POST',
          path: '/api/yoyo/token/issue',
          body: {
            accountId,
            amountCents: intent.amountCents,
          },
        },
      };
      
    case 'UNKNOWN':
      return {
        success: false,
        error: "I didn't quite understand that. You can:\n" +
               "• Check your balance\n" +
               "• Buy airtime or data\n" +
               "• Redeem a voucher\n" +
               "• Pay at a store\n" +
               "• Send money to someone",
      };
      
    default:
      return {
        success: false,
        error: 'This feature is not yet available.',
      };
  }
}

/**
 * Generate disambiguation prompt with quick replies
 * 
 * @param entity - Missing entity name
 * @param intentType - Type of intent
 * @returns Prompt and quick replies
 */
export function generateDisambiguationPrompt(
  entity: string,
  intentType: string
): { prompt: string; quickReplies?: string[] } {
  switch (entity) {
    case 'amount':
      if (intentType === 'BUY_AIRTIME') {
        return {
          prompt: 'How much airtime would you like to buy?',
          quickReplies: ['R10', 'R20', 'R50', 'R100'],
        };
      }
      if (intentType === 'BETTING_TOPUP') {
        return {
          prompt: 'How much would you like to deposit?',
          quickReplies: ['R50', 'R100', 'R200', 'R500'],
        };
      }
      return {
        prompt: 'How much?',
      };
      
    case 'phone_number':
      return {
        prompt: 'Which phone number? (e.g., 0821234567)',
      };
      
    case 'data_amount':
      return {
        prompt: 'How much data would you like?',
        quickReplies: ['500MB', '1GB', '2GB', '5GB'],
      };
      
    case 'network':
      return {
        prompt: 'Which network?',
        quickReplies: ['Vodacom', 'MTN', 'Cell C', 'Telkom'],
      };
      
    case 'operator':
      return {
        prompt: 'Which betting site?',
        quickReplies: ['Hollywoodbets', 'Betway', 'LottoStar', 'Supabets'],
      };
      
    default:
      return {
        prompt: `Please provide: ${entity}`,
      };
  }
}

