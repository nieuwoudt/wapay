/**
 * OTP Service
 * 
 * Handles OTP generation, sending via WhatsApp, and verification
 * - 6-digit numeric codes
 * - 5-minute TTL
 * - Rate limiting (max 3 per 5 minutes)
 */

import { getPrisma } from '@wapay/domain';
import { sendWhatsAppTemplate, sendWhatsAppText } from '@wapay/whatsapp';

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
    
    // Try to send via WhatsApp template (otp_register_step_2)
    let sendResult = await sendWhatsAppTemplate({
      to: msisdn,
      templateName: 'otp_register_step_2',
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
    
    // Fallback to text message if template not found
    if (!sendResult.ok) {
      console.log('⚠️ OTP template not found, sending text message fallback');
      sendResult = await sendWhatsAppText({
        to: msisdn,
        text: `🔐 *WaPay Verification Code*\n\nYour OTP code is: *${code}*\n\n⏰ This code expires in ${OTP_TTL_MINUTES} minutes.\n\n🔒 Never share this code with anyone.`,
      });
      
      if (!sendResult.ok) {
        console.error('❌ Failed to send OTP via text fallback:', sendResult.error);
        return {
          ok: false,
          error: 'SEND_FAILED',
        };
      }
    }
    
    // Log audit event (non-blocking - don't fail if this fails)
    try {
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
          waMessageId: sendResult.data?.messages?.[0]?.id,
        },
      });
      console.log(`✅ Audit log created for OTP send`);
    } catch (auditError) {
      console.error('⚠️ Failed to create audit log (non-critical):', auditError);
      // Don't fail the whole operation if audit log fails
    }
    
    console.log(`✅ OTP sent successfully to ${msisdn} (OTP ID: ${otpRecord.id}, Code: ${code})`);
    
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
    console.log(`🔍 Verifying OTP for account: ${accountId}, code: ${code.substring(0, 2)}****`);
    
    // Debug: Check all OTPs for this account
    const allOtps = await prisma.otpCode.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    console.log(`📊 Found ${allOtps.length} OTPs for account ${accountId}:`);
    allOtps.forEach(otp => {
      console.log(`   - Code: ${otp.code.substring(0, 2)}****, Expires: ${otp.expiresAt}, Consumed: ${otp.consumedAt ? 'YES' : 'NO'}, Match: ${otp.code === code ? 'YES' : 'NO'}`);
    });
    
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
      console.log(`❌ No valid OTP found for account ${accountId} with code ${code.substring(0, 2)}****`);
      
      // Log failed attempt (non-blocking)
      try {
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
      } catch (auditError) {
        console.error('⚠️ Failed to log verify failure (non-critical):', auditError);
      }
      
      return {
        ok: false,
        error: 'INVALID_OR_EXPIRED',
      };
    }
    
    console.log(`✅ Found valid OTP: ${otpRecord.id}, marking as consumed`);
    
    // Mark OTP as consumed
    await prisma.otpCode.update({
      where: { id: otpRecord.id },
      data: { consumedAt: new Date() },
    });
    
    // Log successful verification (non-blocking)
    try {
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
    } catch (auditError) {
      console.error('⚠️ Failed to log verify success (non-critical):', auditError);
    }
    
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

