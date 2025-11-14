/**
 * PIN Service
 * 
 * Handles PIN creation, verification, and lockout
 * - 4-6 digit numeric PINs
 * - Argon2id hashing with pepper
 * - Lockout after 5 failed attempts (soft), 10 attempts (hard)
 * - Short-lived PIN tokens (JWT, 5min)
 */

import * as argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import { getPrisma } from '@wapay/domain';

const PIN_REGEX = /^[0-9]{4,6}$/;
const SOFT_LOCKOUT_ATTEMPTS = 5;
const HARD_LOCKOUT_ATTEMPTS = 10;
const SOFT_LOCKOUT_MINUTES = 15;
const HARD_LOCKOUT_DAYS = 365; // 1 year = permanent lock requiring OTP reset
const PIN_TOKEN_EXPIRY_MINUTES = 5;

// Pepper (should be in env var in production)
const PIN_PEPPER = process.env.PIN_PEPPER || 'wapay_pin_pepper_2025_change_in_production';

// JWT secret for PIN tokens
const PIN_TOKEN_SECRET = process.env.PIN_TOKEN_SECRET || 'wapay_pin_token_secret_2025';

// JWT issuer and audience for PIN tokens
const PIN_TOKEN_ISSUER = 'wapay';
const PIN_TOKEN_AUDIENCE = 'pin';

/**
 * Validate PIN format
 */
export function validatePINFormat(pin: string): { valid: boolean; error?: string } {
  if (!pin) {
    return { valid: false, error: 'PIN is required' };
  }
  
  if (!PIN_REGEX.test(pin)) {
    return { valid: false, error: 'PIN must be 4-6 digits' };
  }
  
  // Check for weak PINs
  const weakPatterns = [
    '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
    '1234', '4321', '0123', '3210',
  ];
  
  if (weakPatterns.some(pattern => pin.includes(pattern))) {
    return { valid: false, error: 'PIN is too weak. Avoid simple patterns.' };
  }
  
  return { valid: true };
}

/**
 * Hash PIN with Argon2id + pepper
 */
async function hashPIN(pin: string): Promise<string> {
  const pepperedPIN = pin + PIN_PEPPER;
  
  const hash = await argon2.hash(pepperedPIN, {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MB
    timeCost: 3,
    parallelism: 1, // Single thread for better serverless performance
  });
  
  return hash;
}

/**
 * Verify PIN against hash
 * Note: Silently returns false on error to avoid oracle timing attacks
 */
async function verifyPINHash(hash: string, pin: string): Promise<boolean> {
  const pepperedPIN = pin + PIN_PEPPER;
  
  try {
    return await argon2.verify(hash, pepperedPIN);
  } catch {
    // Treat errors as failure to avoid oracle signals
    return false;
  }
}

/**
 * Check if account is locked
 */
async function checkLockout(accountId: string): Promise<{ locked: boolean; until?: Date; reason?: string }> {
  const prisma = getPrisma();
  
  const authFactor = await prisma.authFactor.findFirst({
    where: {
      accountId,
      type: 'PIN',
    },
  });
  
  if (!authFactor) {
    return { locked: false };
  }
  
  if (authFactor.lockedUntil && authFactor.lockedUntil > new Date()) {
    return {
      locked: true,
      until: authFactor.lockedUntil,
      reason: authFactor.attempts >= HARD_LOCKOUT_ATTEMPTS ? 'HARD_LOCKOUT' : 'SOFT_LOCKOUT',
    };
  }
  
  return { locked: false };
}

/**
 * Set/Create PIN for account
 */
export async function setPIN(args: {
  accountId: string;
  pin: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { accountId, pin } = args;
  const prisma = getPrisma();
  
  try {
    // Validate PIN format
    const validation = validatePINFormat(pin);
    if (!validation.valid) {
      return { ok: false, error: validation.error };
    }
    
    // Hash PIN
    const secretHash = await hashPIN(pin);
    
    // Upsert auth factor
    await prisma.authFactor.upsert({
      where: {
        accountId_type: {
          accountId,
          type: 'PIN',
        },
      },
      create: {
        id: `pin_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        accountId,
        type: 'PIN',
        secretHash,
        attempts: 0,
        setAt: new Date(),
        updatedAt: new Date(),
      },
      update: {
        secretHash,
        attempts: 0,
        lockedUntil: null,
        setAt: new Date(),
        updatedAt: new Date(),
      },
    });
    
    // Log audit event (non-blocking). Some deployments might not yet have the
    // latest audit_log schema (e.g. missing timestamp column) so we treat
    // failures here as non-critical.
    try {
      await prisma.auditLog.create({
        data: {
          id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          accountId,
          event: 'PIN_SET',
          metadata: {
            pinLength: pin.length,
          },
        },
      });
      console.log(`✅ Audit log recorded for PIN_SET (account ${accountId})`);
    } catch (auditError) {
      console.error('⚠️ Failed to log PIN_SET event (non-critical):', auditError);
    }
    
    console.log(`✅ PIN set successfully for account ${accountId}`);
    
    return { ok: true };
    
  } catch (error) {
    console.error('❌ Error setting PIN:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
    };
  }
}

/**
 * Verify PIN and issue token
 */
export async function verifyPIN(args: {
  accountId: string;
  pin: string;
}): Promise<{ ok: boolean; token?: string; error?: string; lockedUntil?: Date }> {
  const { accountId, pin } = args;
  const prisma = getPrisma();
  
  try {
    // Check lockout
    const lockout = await checkLockout(accountId);
    if (lockout.locked) {
      console.log(`🔒 Account ${accountId} is locked until ${lockout.until}`);
      return {
        ok: false,
        error: lockout.reason,
        lockedUntil: lockout.until,
      };
    }
    
    // Get auth factor
    const authFactor = await prisma.authFactor.findFirst({
      where: {
        accountId,
        type: 'PIN',
      },
    });
    
    if (!authFactor) {
      return { ok: false, error: 'PIN_NOT_SET' };
    }
    
    // Verify PIN
    const isValid = await verifyPINHash(authFactor.secretHash, pin);
    
    if (!isValid) {
      // Increment attempts
      const newAttempts = authFactor.attempts + 1;
      let lockedUntil: Date | null = null;
      
      if (newAttempts >= HARD_LOCKOUT_ATTEMPTS) {
        // Hard lock: permanent (1 year) - requires OTP reset to unlock
        lockedUntil = new Date(Date.now() + HARD_LOCKOUT_DAYS * 24 * 60 * 60 * 1000);
      } else if (newAttempts >= SOFT_LOCKOUT_ATTEMPTS) {
        // Soft lock: temporary (15 minutes)
        lockedUntil = new Date(Date.now() + SOFT_LOCKOUT_MINUTES * 60 * 1000);
      }
      
      await prisma.authFactor.update({
        where: { id: authFactor.id },
        data: {
          attempts: newAttempts,
          lockedUntil,
          updatedAt: new Date(),
        },
      });
      
      // Log failed attempt
      await prisma.auditLog.create({
        data: {
          id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          accountId,
          event: 'PIN_VERIFY_FAILED',
          metadata: {
            attempts: newAttempts,
            locked: !!lockedUntil,
            lockedUntil: lockedUntil?.toISOString(),
          },
        },
      });
      
      console.log(`❌ Invalid PIN for account ${accountId} (attempt ${newAttempts})`);
      
      return {
        ok: false,
        error: 'INVALID_PIN',
        lockedUntil: lockedUntil || undefined,
      };
    }
    
    // Reset attempts on successful verification
    await prisma.authFactor.update({
      where: { id: authFactor.id },
      data: {
        attempts: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      },
    });
    
    // Generate PIN token (JWT, 5min expiry) with proper claims
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt(now)
      .setIssuer(PIN_TOKEN_ISSUER)
      .setAudience(PIN_TOKEN_AUDIENCE)
      .setSubject(accountId)
      .setExpirationTime(`${PIN_TOKEN_EXPIRY_MINUTES}m`)
      .sign(new TextEncoder().encode(PIN_TOKEN_SECRET));
    
    // Log successful verification
    await prisma.auditLog.create({
      data: {
        id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        accountId,
        event: 'PIN_VERIFIED',
        metadata: {
          tokenExpiry: PIN_TOKEN_EXPIRY_MINUTES,
        },
      },
    });
    
    console.log(`✅ PIN verified successfully for account ${accountId}`);
    
    return {
      ok: true,
      token,
    };
    
  } catch (error) {
    console.error('❌ Error verifying PIN:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
    };
  }
}

/**
 * Verify PIN token with proper JWT claims validation
 */
export async function verifyPINToken(token: string): Promise<{ valid: boolean; accountId?: string; error?: string }> {
  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(PIN_TOKEN_SECRET),
      {
        issuer: PIN_TOKEN_ISSUER,
        audience: PIN_TOKEN_AUDIENCE,
      }
    );
    
    const accountId = payload.sub;
    
    if (!accountId) {
      return { valid: false, error: 'INVALID_TOKEN' };
    }
    
    return {
      valid: true,
      accountId,
    };
    
  } catch (error) {
    // Don't leak error details
    return { valid: false, error: 'INVALID_TOKEN' };
  }
}

/**
 * Reset PIN after OTP verification (for "forgot PIN" flow)
 * Note: Caller MUST verify OTP before calling this function
 */
export async function resetPIN(args: {
  accountId: string;
  newPin: string;
  otpVerified: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const { accountId, newPin, otpVerified } = args;
  const prisma = getPrisma();
  
  try {
    // Security check: OTP must be verified first
    if (!otpVerified) {
      console.error('❌ Attempted PIN reset without OTP verification');
      return {
        ok: false,
        error: 'OTP_VERIFICATION_REQUIRED',
      };
    }
    
    // Validate new PIN format
    const validation = validatePINFormat(newPin);
    if (!validation.valid) {
      return { ok: false, error: validation.error };
    }
    
    // Hash new PIN
    const secretHash = await hashPIN(newPin);
    
    // Update auth factor (reset attempts and unlock)
    await prisma.authFactor.upsert({
      where: {
        accountId_type: {
          accountId,
          type: 'PIN',
        },
      },
      create: {
        id: `pin_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        accountId,
        type: 'PIN',
        secretHash,
        attempts: 0,
        setAt: new Date(),
        updatedAt: new Date(),
      },
      update: {
        secretHash,
        attempts: 0,
        lockedUntil: null, // Unlock the account
        setAt: new Date(),
        updatedAt: new Date(),
      },
    });
    
    // Log audit event
    await prisma.auditLog.create({
      data: {
        id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        accountId,
        event: 'PIN_RESET',
        metadata: {
          pinLength: newPin.length,
        },
      },
    });
    
    console.log(`✅ PIN reset successfully for account ${accountId}`);
    
    return { ok: true };
    
  } catch (error) {
    console.error('❌ Error resetting PIN:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
    };
  }
}

/**
 * Check if account is locked and needs PIN reset
 */
export async function isPINLocked(accountId: string): Promise<boolean> {
  const lockout = await checkLockout(accountId);
  return lockout.locked && lockout.reason === 'HARD_LOCKOUT';
}

/**
 * Middleware: Require valid PIN token for sensitive operations
 */
export async function requirePinToken(token: string | undefined): Promise<{
  authorized: boolean;
  accountId?: string;
  error?: string;
}> {
  if (!token) {
    return {
      authorized: false,
      error: 'PIN_TOKEN_REQUIRED',
    };
  }
  
  const result = await verifyPINToken(token);
  
  if (!result.valid) {
    return {
      authorized: false,
      error: result.error || 'INVALID_PIN_TOKEN',
    };
  }
  
  return {
    authorized: true,
    accountId: result.accountId,
  };
}

/**
 * Check if PIN is required for action
 */
export function isPINRequired(args: {
  lastPINVerification?: Date;
  amount?: number;
  deviceChanged?: boolean;
}): boolean {
  const { lastPINVerification, amount, deviceChanged } = args;
  
  // Always require PIN if device changed
  if (deviceChanged) {
    return true;
  }
  
  // Require PIN if session idle > 5 minutes
  if (lastPINVerification) {
    const idleMinutes = (Date.now() - lastPINVerification.getTime()) / (60 * 1000);
    if (idleMinutes > 5) {
      return true;
    }
  } else {
    return true; // No previous verification
  }
  
  // Require PIN for amounts > R100
  if (amount && amount > 10000) { // 10000 cents = R100
    return true;
  }
  
  return false;
}

