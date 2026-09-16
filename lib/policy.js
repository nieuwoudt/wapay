/**
 * Policy engine (v1.4 agent, 2026-09-16): the deterministic gate between a
 * capability proposal and a flow start. The AI may only propose what this
 * says is 'allow'; everything else is either not proposable ('deny') or needs
 * the customer to complete something first ('require': KYC, a consent).
 *
 * Pure functions, no DB calls. The account row is passed in (profile.kyc is
 * where KYC status lives today, see lib/payouts.js accountKycVerified) and
 * consents are read from account.consents when the caller has loaded them.
 *
 * A capability descriptor:
 *   { id, liveFor(ctx) -> boolean,
 *     policy: { minKycTier: 0|1, consents: [{ type, version }],
 *               adviceClass: 'none'|'factual-only'|'regulated',
 *               perCustomerGate?: (ctx) => boolean } }
 *
 * Decision order: NOT_LIVE, per-customer gate, regulated advice (never
 * proposable, counsel-gated), then the requirements (KYC tier, consents).
 * Requirements accumulate so the caller can ask for everything at once.
 */

import { kycRequired, accountKycVerified } from './payouts.js';

export const ADVICE_CLASSES = ['none', 'factual-only', 'regulated'];

const isUnrevoked = (c, now) => {
  if (!c || typeof c !== 'object') return false;
  if (c.granted === false) return false;
  if (!c.revokedAt) return true;
  const t = new Date(c.revokedAt).getTime();
  // A revocation dated in the future has not happened yet.
  return Number.isFinite(t) && t > now.getTime();
};

/** True when account.consents holds an unrevoked entry for { type, version }. */
export function hasConsent(account, { type, version }, now = new Date()) {
  const list = Array.isArray(account?.consents) ? account.consents : [];
  return list.some((c) => {
    const cType = c?.type ?? c?.consentType; // tolerate the Prisma Consent row shape
    if (cType !== type) return false;
    if (version != null && String(c?.version) !== String(version)) return false;
    return isUnrevoked(c, now);
  });
}

export function evaluatePolicy({ capability, account, waId, pack = null, now = new Date() }) {
  const reasons = [];
  const requirements = [];
  const deny = (reason) => ({ decision: 'deny', reasons: [reason], requirements: [{ type: 'NOT_LIVE' }] });

  if (!capability || typeof capability !== 'object') return { decision: 'deny', reasons: ['NO_CAPABILITY'], requirements: [{ type: 'NOT_LIVE' }] };
  const ctx = { account, waId, pack, now, capability };
  const policy = capability.policy || {};

  let live = true;
  try { live = typeof capability.liveFor === 'function' ? !!capability.liveFor(ctx) : true; } catch { live = false; }
  if (!live) return deny('NOT_LIVE');

  if (typeof policy.perCustomerGate === 'function') {
    let gated = false;
    try { gated = !!policy.perCustomerGate(ctx); } catch { gated = false; }
    if (!gated) return deny('NOT_LIVE_FOR_CUSTOMER');
  }

  if (policy.adviceClass === 'regulated') return { decision: 'deny', reasons: ['REGULATED_ADVICE'], requirements: [] };

  const tier = Number(policy.minKycTier || 0);
  if (tier >= 1 && kycRequired() && !accountKycVerified(account)) {
    reasons.push('KYC_REQUIRED');
    requirements.push({ type: 'KYC_TIER', tier: 1 });
  }

  for (const c of Array.isArray(policy.consents) ? policy.consents : []) {
    if (!c || !c.type) continue;
    if (!hasConsent(account, c, now)) {
      reasons.push(`CONSENT_REQUIRED:${c.type}`);
      requirements.push({ type: 'CONSENT', consentType: c.type, version: c.version ?? null });
    }
  }

  if (requirements.length) return { decision: 'require', reasons, requirements };
  return { decision: 'allow', reasons: [], requirements: [] };
}

const CONSENT_LABELS = {
  TERMS_AND_CONDITIONS: 'the terms and conditions',
  PRIVACY_POLICY: 'the privacy policy',
  MARKETING: 'marketing messages',
};

/** One customer-facing sentence per requirement. No em dashes, no partner names. */
export function requirementMessage(req) {
  switch (req?.type) {
    case 'KYC_TIER':
      return 'Please verify your identity first, it takes about two minutes and you only do it once.';
    case 'CONSENT': {
      const what = CONSENT_LABELS[req.consentType] || 'the latest terms for this service';
      return `Please accept ${what} before we continue.`;
    }
    case 'NOT_LIVE':
      return 'This is not available on your account yet.';
    default:
      return 'This is not available right now.';
  }
}

export function isProposable(capability, ctx = {}) {
  return evaluatePolicy({ capability, ...ctx }).decision === 'allow';
}
