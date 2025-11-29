export type VoucherStatus = 'ACTIVE' | 'USED' | 'EXPIRED' | 'UNKNOWN';

export interface VoucherRedeemResult {
  providerRef: string;
  amount_cents: number;
}

export interface VoucherRail {
  redeem(pin: string, idemKey: string, amountCents: number): Promise<VoucherRedeemResult>;
}

// Core Blu clients
export * from './client.js';
export * from './vas.js';

// Extended VAS client and types (all VAS products)
// Note: Don't re-export types from vas-types.js to avoid conflicts with vas.js
// Import specific types from vas-types.js if needed
export { BluVasClientExtended } from './vas-extended.js';


