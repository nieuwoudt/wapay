export declare function maskVoucherPin(pin: string): string;
export declare function requireEnv(name: string): string;
export * from './network';
/**
 * Environment variable helper with type-safe access
 */
export declare const env: {
    readonly DATABASE_URL: string;
    readonly BLU_BASE_URL: string;
    readonly BLU_BASIC_USER: string;
    readonly BLU_BASIC_PASS: string;
    readonly BLU_API_KEY: string;
    readonly YOYO_BASE_URL: string;
    readonly YOYO_CLIENT_ID: string;
    readonly YOYO_CLIENT_SECRET: string;
    readonly YOYO_MERCHANT_ID: string;
    readonly FEATURE_ENABLE_YOYO: boolean;
    readonly SENTRY_DSN: string;
    readonly LOG_LEVEL: string;
    readonly META_WHATSAPP_TOKEN: string;
    readonly META_WHATSAPP_PHONE_NUMBER_ID: string;
    readonly META_WHATSAPP_BUSINESS_ACCOUNT_ID: string;
    readonly META_WEBHOOK_VERIFY_TOKEN: string;
};
