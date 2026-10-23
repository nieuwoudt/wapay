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

/** The terms and privacy versions every sign-up path records (the classic "I accept" writes the same). */
export const TERMS_VERSION = 'v1.0';
export const PRIVACY_VERSION = 'v1.0';
export const TERMS_URL = 'https://wapay.co.za/legal/terms';
/** How the one-step sign-up's consent was given: by carrying on after the notice. */
export const IMPLIED_BY_USE = 'IMPLIED_BY_USE';

/**
 * Consent by continuing (one-step sign-up, WAPAY_ONBOARDING_ONE_STEP,
 * 2026-10-22). The reply to the customer's first message ended with "By using
 * WaPay you agree to our Terms & Privacy Policy: <TERMS_URL>", and WhatsApp
 * accepted it before this runs. Written:
 *   - two consent rows, TERMS_AND_CONDITIONS and PRIVACY_POLICY, granted, this
 *     version, whose userAgent carries the evidence: "IMPLIED_BY_USE wa:<inbound
 *     message id>" (the table has no note column; a web consent keeps its
 *     browser there), grantedAt now;
 *   - one audit row CONSENT_IMPLIED with the inbound message id in its own
 *     column and, in metadata, the method, both versions, the URL, the notice's
 *     outbound message id, the consent row ids and the time.
 * Throws when a write fails, so the caller's transaction opens nothing: an
 * account never becomes active without its consent on file. `prisma` is the
 * transaction client when called inside one.
 */
export async function recordImpliedConsent(args: {
  accountId: string;
  waMessageId?: string | null;
  noticeMessageId?: string | null;
  via?: string | null;
  now?: Date;
  prisma?: any;
}): Promise<{ consentIds: string[]; auditId: string }> {
  const db = args.prisma || getPrisma();
  const now = args.now || new Date();
  const inbound = args.waMessageId ? String(args.waMessageId).slice(0, 200) : null;
  const evidence = `${IMPLIED_BY_USE} wa:${inbound || 'unknown'}`;
  const stamp = () => `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const rows: Array<{ type: ConsentType; version: string }> = [
    { type: 'TERMS_AND_CONDITIONS', version: TERMS_VERSION },
    { type: 'PRIVACY_POLICY', version: PRIVACY_VERSION },
  ];
  const consentIds: string[] = [];
  for (const row of rows) {
    const consent = await db.consent.create({
      data: { id: `consent_${stamp()}`, accountId: args.accountId, consentType: row.type, granted: true, version: row.version, userAgent: evidence, grantedAt: now },
    });
    consentIds.push(consent.id);
  }
  const audit = await db.auditLog.create({
    data: {
      id: `audit_${stamp()}`,
      accountId: args.accountId,
      event: 'CONSENT_IMPLIED',
      waMessageId: inbound,
      metadata: {
        method: IMPLIED_BY_USE,
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION,
        termsUrl: TERMS_URL,
        noticeMessageId: args.noticeMessageId ? String(args.noticeMessageId).slice(0, 200) : null,
        consentIds,
        via: args.via || null,
        at: now.toISOString(),
      },
      timestamp: now,
    },
  });
  return { consentIds, auditId: audit.id };
}

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

