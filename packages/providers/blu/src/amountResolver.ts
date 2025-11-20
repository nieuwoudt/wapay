/**
 * Temporary amount resolver for Blu voucher redemption
 * 
 * Since Blu requires an amount but doesn't provide a status API,
 * we use a configurable default for testing until we determine
 * the correct pattern from Blu support.
 */

export function resolveBluVoucherAmountCents(pin: string): number {
  // TEMPORARY: use a fixed QA amount until Blu clarifies the correct pattern.
  // Can be overridden via BLU_TEST_DEFAULT_AMOUNT_CENTS env var
  const defaultAmount = Number(process.env.BLU_TEST_DEFAULT_AMOUNT_CENTS ?? '1000');
  return defaultAmount > 0 ? defaultAmount : 1000;
}

