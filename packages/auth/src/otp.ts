/**
 * OTP Service
 * 
 * Handles OTP generation, sending via WhatsApp, and verification
 * - 6-digit numeric codes
 * - 5-minute TTL
 * - Rate limiting (max 3 per 5 minutes)
 */

import { getPrisma } from '@wapay/domain';
import { sendWhatsAppTemplate } from '@wapay/whatsapp';

const OTP_LENGTH = 6;
const OTP_TTL_MINUTES = 5;
const MAX_OTP_ATTEMPTS = 3;
const RATE_LIMIT_WINDOW_MINUTES = 5;

/**
 * Generate a 6-digit numeric OTP
 */
export function generateOTP(): string {
  const min = 100000;
  const max = 999999;
  return Math.floor(Math.random() * (max - min + 1) + min).toString();
}

/**
 * Check if account has exceeded OTP rate limit
 */
async function checkRateLimit(accountId: string): Promise<boolean> {
  const prisma = getPrisma();
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60 * 1000);
  
  const recentOTPs = await prisma.otpCode.count({
    where: {
      accountId,
      createdAt: {
        gte: windowStart,
      },
    },
  });
  
  return recentOTPs >= MAX_OTP_ATTEMPTS;
}

/**
 * Send OTP via WhatsApp template
 */
export async function sendOTP(args: {
  accountId: string;
  msisdn: string;
  displayName?: string;
}): Promise<{ ok: boolean; otpId?: string; error?: string }> {
  const { accountId, msisdn, displayName } = args;
  const prisma = getPrisma();
  
  try {
    // Check rate limit
    const isRateLimited = await checkRateLimit(accountId);
    if (isRateLimited) {
      console.log(`⚠️ OTP rate limit exceeded for account ${accountId}`);
      return {
        ok: false,
        error: 'TOO_MANY_REQUESTS',
      };
    }
    
    // Generate OTP
    const code = generateOTP();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
    
    // Store OTP in database
    const otpRecord = await prisma.otpCode.create({
      data: {
        id: `otp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        accountId,
        code,
        expiresAt,
      },
    });
    
    console.log(`📧 Generated OTP for account ${accountId}: ${code.substring(0, 2)}****`);
    
    // Send via WhatsApp template (otp_register)
    const result = await sendWhatsAppTemplate({
      to: msisdn,
      templateName: 'otp_register',
      language: 'en',
      components: [
        {
          type: 'body',
          parameters: [
            {
              type: 'text',
              text: code,
            },
          ],
        },
      ],
    });
    
    if (!result.ok) {
      console.error('❌ Failed to send OTP via WhatsApp:', result.error);
      return {
        ok: false,
        error: 'SEND_FAILED',
      };
    }
    
    // Log audit event
    await prisma.auditLog.create({
      data: {
        id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        accountId,
        event: 'OTP_SENT',
        metadata: {
          otpId: otpRecord.id,
          msisdn,
          expiresAt: expiresAt.toISOString(),
        },
        waMessageId: result.data?.messages?.[0]?.id,
      },
    });
    
    console.log(`✅ OTP sent successfully to ${msisdn}`);
    
    return {
      ok: true,
      otpId: otpRecord.id,
    };
    
  } catch (error) {
    console.error('❌ Error sending OTP:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
    };
  }
}

/**
 * Verify OTP code
 */
export async function verifyOTP(args: {
  accountId: string;
  code: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { accountId, code } = args;
  const prisma = getPrisma();
  
  try {
    // Find valid OTP
    const otpRecord = await prisma.otpCode.findFirst({
      where: {
        accountId,
        code,
        consumedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
    
    if (!otpRecord) {
      console.log(`❌ Invalid or expired OTP for account ${accountId}`);
      
      // Log failed attempt
      await prisma.auditLog.create({
        data: {
          id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          accountId,
          event: 'OTP_VERIFY_FAILED',
          metadata: {
            reason: 'INVALID_OR_EXPIRED',
            code: code.substring(0, 2) + '****',
          },
        },
      });
      
      return {
        ok: false,
        error: 'INVALID_OR_EXPIRED',
      };
    }
    
    // Mark OTP as consumed
    await prisma.otpCode.update({
      where: { id: otpRecord.id },
      data: { consumedAt: new Date() },
    });
    
    // Log successful verification
    await prisma.auditLog.create({
      data: {
        id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        accountId,
        event: 'OTP_VERIFIED',
        metadata: {
          otpId: otpRecord.id,
        },
      },
    });
    
    console.log(`✅ OTP verified successfully for account ${accountId}`);
    
    return { ok: true };
    
  } catch (error) {
    console.error('❌ Error verifying OTP:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
    };
  }
}

/**
 * Clean up expired OTPs (should be run periodically)
 */
export async function cleanupExpiredOTPs(): Promise<number> {
  const prisma = getPrisma();
  
  try {
    const result = await prisma.otpCode.deleteMany({
      where: {
        expiresAt: {
          lt: new Date(),
        },
        consumedAt: null,
      },
    });
    
    console.log(`🧹 Cleaned up ${result.count} expired OTPs`);
    return result.count;
    
  } catch (error) {
    console.error('❌ Error cleaning up OTPs:', error);
    return 0;
  }
}

