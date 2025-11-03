export type VoucherStatus = 'ACTIVE' | 'USED' | 'EXPIRED' | 'UNKNOWN';

export interface VoucherRedeemResult {
  providerRef: string;
  amount_cents: number;
}

export interface VoucherRail {
  checkStatus(pin: string): Promise<{ status: VoucherStatus; amount_cents?: number }>;
  redeem(pin: string, idemKey: string): Promise<VoucherRedeemResult>;
}
export * from './client';
export * from './vas';


