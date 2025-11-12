/**
 * Consent Service
 * 
 * Handles POPIA consent capture and management
 * - Terms & Conditions
 * - Privacy Policy
 * - Marketing consent (optional)
 */

import { getPrisma } from '@wapay/domain';

export type ConsentType = 'TERMS_AND_CONDITIONS' | 'PRIVACY_POLICY' | 'MARKETING';

/**
 * Record consent
 */
export async function recordConsent(args: {
  accountId: string;
  consentType: ConsentType;
  granted: boolean;
  version: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<{ ok: boolean; consentId?: string; error?: string }> {
  const { accountId, consentType, granted, version, ipAddress, userAgent } = args;
  const prisma = getPrisma();
  
  try {
    const consent = await prisma.consent.create({
      data: {
        id: `consent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        accountId,
        consentType,
        granted,
        version,
        ipAddress,
        userAgent,
      },
    });
    
    // Log audit event
    await prisma.auditLog.create({
      data: {
        id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        accountId,
        event: 'CONSENT_RECORDED',
        metadata: {
          consentId: consent.id,
          consentType,
          granted,
          version,
        },
      },
    });
    
    console.log(`✅ Consent recorded: ${consentType} = ${granted} for account ${accountId}`);
    
    return {
      ok: true,
      consentId: consent.id,
    };
    
  } catch (error) {
    console.error('❌ Error recording consent:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
    };
  }
}

/**
 * Check if account has granted required consent
 */
export async function hasRequiredConsents(accountId: string): Promise<boolean> {
  const prisma = getPrisma();
  
  try {
    const requiredConsents: ConsentType[] = ['TERMS_AND_CONDITIONS', 'PRIVACY_POLICY'];
    
    for (const consentType of requiredConsents) {
      const consent = await prisma.consent.findFirst({
        where: {
          accountId,
          consentType,
          granted: true,
        },
        orderBy: {
          grantedAt: 'desc',
        },
      });
      
      if (!consent) {
        console.log(`❌ Missing consent: ${consentType} for account ${accountId}`);
        return false;
      }
    }
    
    return true;
    
  } catch (error) {
    console.error('❌ Error checking consent:', error);
    return false;
  }
}

/**
 * Get consent status for account
 */
export async function getConsentStatus(accountId: string): Promise<{
  termsAndConditions: boolean;
  privacyPolicy: boolean;
  marketing: boolean;
}> {
  const prisma = getPrisma();
  
  try {
    const consents = await prisma.consent.findMany({
      where: {
        accountId,
        granted: true,
      },
      orderBy: {
        grantedAt: 'desc',
      },
      distinct: ['consentType'],
    });
    
    const status = {
      termsAndConditions: false,
      privacyPolicy: false,
      marketing: false,
    };
    
    for (const consent of consents) {
      if (consent.consentType === 'TERMS_AND_CONDITIONS') {
        status.termsAndConditions = true;
      } else if (consent.consentType === 'PRIVACY_POLICY') {
        status.privacyPolicy = true;
      } else if (consent.consentType === 'MARKETING') {
        status.marketing = true;
      }
    }
    
    return status;
    
  } catch (error) {
    console.error('❌ Error getting consent status:', error);
    return {
      termsAndConditions: false,
      privacyPolicy: false,
      marketing: false,
    };
  }
}

/**
 * Revoke consent
 */
export async function revokeConsent(args: {
  accountId: string;
  consentType: ConsentType;
}): Promise<{ ok: boolean; error?: string }> {
  const { accountId, consentType } = args;
  const prisma = getPrisma();
  
  try {
    // Record revocation as a new consent record with granted = false
    await prisma.consent.create({
      data: {
        id: `consent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        accountId,
        consentType,
        granted: false,
        version: 'REVOKED',
      },
    });
    
    // Log audit event
    await prisma.auditLog.create({
      data: {
        id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        accountId,
        event: 'CONSENT_REVOKED',
        metadata: {
          consentType,
        },
      },
    });
    
    console.log(`✅ Consent revoked: ${consentType} for account ${accountId}`);
    
    return { ok: true };
    
  } catch (error) {
    console.error('❌ Error revoking consent:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'UNKNOWN_ERROR',
    };
  }
}

