export function maskVoucherPin(pin: string): string {
  if (!pin) return '';
  const last4 = pin.slice(-4);
  return `****${last4}`;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

  // Network inference utilities
export * from './network.js';

/**
 * Environment variable helper with type-safe access
 */
export const env = {
  // Database
  get DATABASE_URL() { return requireEnv('DATABASE_URL'); },
  
  // Blu Voucher
  get BLU_BASE_URL() { return process.env.BLU_BASE_URL || 'https://api.bluvoucher.com/v1'; },
  get BLU_BASIC_USER() { return requireEnv('BLU_BASIC_USER'); },
  get BLU_BASIC_PASS() { return requireEnv('BLU_BASIC_PASS'); },
  get BLU_API_KEY() { return requireEnv('BLU_API_KEY'); },
  
  // Yoyo/wiGroup
  get YOYO_BASE_URL() { return process.env.YOYO_BASE_URL || 'https://api.yoyo.co.za/v1'; },
  get YOYO_CLIENT_ID() { return requireEnv('YOYO_CLIENT_ID'); },
  get YOYO_CLIENT_SECRET() { return requireEnv('YOYO_CLIENT_SECRET'); },
  get YOYO_MERCHANT_ID() { return requireEnv('YOYO_MERCHANT_ID'); },
  
  // Feature Flags
  get FEATURE_ENABLE_YOYO() { return process.env.FEATURE_ENABLE_YOYO === 'true'; },
  
  // Observability
  get SENTRY_DSN() { return process.env.SENTRY_DSN || ''; },
  get LOG_LEVEL() { return process.env.LOG_LEVEL || 'info'; },
  
  // WhatsApp (Meta)
  get META_WHATSAPP_TOKEN() { return requireEnv('META_WHATSAPP_TOKEN'); },
  get META_WHATSAPP_PHONE_NUMBER_ID() { return requireEnv('META_WHATSAPP_PHONE_NUMBER_ID'); },
  get META_WHATSAPP_BUSINESS_ACCOUNT_ID() { return process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || ''; },
  get META_WEBHOOK_VERIFY_TOKEN() { return requireEnv('META_WEBHOOK_VERIFY_TOKEN'); },
}


