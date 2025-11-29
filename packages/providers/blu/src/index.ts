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

// Extended VAS types and client (all VAS products)
export * from './vas-types.js';
export * from './vas-extended.js';


