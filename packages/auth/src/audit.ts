/**
 * Audit Service
 * 
 * Handles audit logging for compliance and debugging
 */

import { getPrisma } from '@wapay/domain';

export type AuditEvent =
  | 'OTP_SENT'
  | 'OTP_VERIFIED'
  | 'OTP_VERIFY_FAILED'
  | 'PIN_SET'
  | 'PIN_VERIFIED'
  | 'PIN_VERIFY_FAILED'
  | 'PIN_RESET'
  | 'PIN_RESET_INITIATED'
  | 'CONSENT_RECORDED'
  | 'CONSENT_REVOKED'
  | 'ONBOARDING_STARTED'
  | 'ONBOARDING_COMPLETED'
  | 'ONBOARDING_ABANDONED'
  | 'STATE_TRANSITION'
  | 'TRANSACTION_INITIATED'
  | 'TRANSACTION_COMPLETED'
  | 'TRANSACTION_FAILED';

/**
 * Log audit event
 */
export async function logAuditEvent(args: {
  accountId: string;
  event: AuditEvent;
  metadata?: Record<string, any>;
  waMessageId?: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<{ ok: boolean; auditId?: string; error?: string }> {
  const { accountId, event, metadata, waMessageId, ipAddress, userAgent } = args;
  const prisma = getPrisma();
  
  try {
    const auditLog = await prisma.auditLog.create({
      data: {
        id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        accountId,
        event,
        metadata: metadata || {},
        waMessageId,
        ipAddress,
        userAgent,
      },
    });
    
    console.log(`📝 Audit log: ${event} for account ${accountId}`);
    
    return {
      ok: true,
      auditId: auditLog.id,
    };
    
  } catch (error) {
    console.error('❌ Error logging audit event:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
    };
  }
}

/**
 * Get audit trail for account
 */
export async function getAuditTrail(args: {
  accountId: string;
  limit?: number;
  events?: AuditEvent[];
}): Promise<Array<{
  id: string;
  event: string;
  timestamp: Date;
  metadata: any;
  waMessageId?: string;
}>> {
  const { accountId, limit = 50, events } = args;
  const prisma = getPrisma();
  
  try {
    const logs = await prisma.auditLog.findMany({
      where: {
        accountId,
        ...(events && events.length > 0 ? { event: { in: events } } : {}),
      },
      orderBy: {
        timestamp: 'desc',
      },
      take: limit,
    });
    
    return logs.map((log: any) => ({
      id: log.id,
      event: log.event,
      timestamp: log.timestamp,
      metadata: log.metadata,
      waMessageId: log.waMessageId || undefined,
    }));
    
  } catch (error) {
    console.error('❌ Error getting audit trail:', error);
    return [];
  }
}

/**
 * Get recent failed PIN attempts
 */
export async function getRecentFailedPINAttempts(accountId: string): Promise<number> {
  const prisma = getPrisma();
  
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    const count = await prisma.auditLog.count({
      where: {
        accountId,
        event: 'PIN_VERIFY_FAILED',
        timestamp: {
          gte: fiveMinutesAgo,
        },
      },
    });
    
    return count;
    
  } catch (error) {
    console.error('❌ Error getting failed PIN attempts:', error);
    return 0;
  }
}

