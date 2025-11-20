export type VoucherStatus = 'ACTIVE' | 'USED' | 'EXPIRED' | 'UNKNOWN';

export interface VoucherRedeemResult {
  providerRef: string;
  amount_cents: number;
}

export interface VoucherRail {
  redeem(pin: string, idemKey: string, amountCents: number): Promise<VoucherRedeemResult>;
}
export * from './client.js';
export * from './vas.js';


