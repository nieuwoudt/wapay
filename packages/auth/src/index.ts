/**
 * @wapay/auth
 * 
 * Authentication and authorization services for WaPay
 * - OTP generation and verification
 * - PIN creation and verification (Argon2id)
 * - Consent management (POPIA compliance)
 * - Audit logging
 * - Onboarding state machine (S0 → S5)
 */

export * from './otp.js';
export * from './pin.js';
export * from './consent.js';
export * from './audit.js';
export * from './onboarding.js';

