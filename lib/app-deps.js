/**
 * The personal portal's dependencies in one object (2026-10-21).
 *
 * Every /api/app route takes its database client and every money function
 * from here, never by importing them itself. Two reasons:
 *   - the tests hand each route stubs, so every refusal and every happy path
 *     is exercised without a database or a rail;
 *   - a developer can click through the whole portal on `next dev` against an
 *     in-memory fixture (lib/app-dev-fixture.js) with no database at all.
 *
 * The real objects are exactly the libraries the chat uses: verifyPIN from
 * @wapay/auth, requestPayout and the pay-out rules, the vault, sendMoney,
 * createPaymentRequest, the deposit intent and the PayFast checkout, the
 * Didit session, the referral code. Nothing here moves money itself.
 *
 * The fixture is reachable only on a development server: NODE_ENV must be
 * 'development' (next dev), WAPAY_APP_DEV_FIXTURE must be '1', and no Vercel
 * variable may be present. `next build` and every Vercel deployment run with
 * NODE_ENV=production, so the branch is dead there, and even if it ran it
 * would serve fake data from memory, never a real account.
 */
import prisma from './prisma.js';
import { verifyPIN, setPIN, resetPIN, validatePINFormat } from '@wapay/auth';
import { verifyPinProof } from '@wapay/auth/pin-proof';
import { buildCheckoutUrl } from '@wapay/providers-payfast';
import {
  requestPayout, quotePayout, payoutBalances, resolveProviders, methodLimits, payoutEnabled, payoutAllowedFor, payoutConfigured,
  kycRequired, accountKycVerified, passportIdType, PAYOUT_METHODS,
} from './payouts.js';
import { checkPayoutRules, kycConfigured } from './payout-rules.js';
import { readPayoutFreeze } from './payout-freeze.js';
import {
  listPayoutDestinations, loadPayoutDestinationSecret, loadPayoutIdentitySecret, loadPayoutIdentitySecretStrict, getPayoutIdentity,
  savePayoutDestination, savePayoutIdentity, touchPayoutDestination, forgetPayoutDetails, setPayoutDestinationNickname, beneficiariesAvailable,
} from './payout-beneficiaries.js';
import { createPaymentRequest, cancelPaymentRequest } from './payment-requests.js';
import { sendMoney } from './send-money.js';
import { startKycSession, syncKycFromDecision } from './didit-kyc.js';
import { rememberPendingWithdraw, clearPendingWithdraw } from './kyc-resume.js';
import { ensureReferralCode } from './referrals.js';
import { createDepositIntent, getDepositIntent } from './deposits.js';
import { mergeProfileSubkeyAtomic } from './profile-merge.js';
import { dbLimiter } from './app-auth.js';

/** True only on a local development server with the fixture asked for. */
export function devFixtureOn(env = process.env) {
  return env.NODE_ENV === 'development' && env.WAPAY_APP_DEV_FIXTURE === '1' && !env.VERCEL && !env.VERCEL_ENV && !env.VERCEL_URL;
}

/** The real dependencies: the chat's own libraries and the shared database client. */
export function realAppDeps() {
  return {
    prisma,
    limiter: dbLimiter(prisma),
    now: () => Date.now(),
    // The PIN: the one verifier, and the two writers the chat uses.
    verifyPIN,
    setPIN,
    resetPIN,
    validatePINFormat,
    verifyPinProof,
    // Money out.
    requestPayout,
    quotePayout,
    payoutBalances,
    resolveProviders,
    methodLimits,
    payoutEnabled,
    payoutAllowedFor,
    payoutConfigured,
    kycRequired,
    accountKycVerified,
    passportIdType,
    PAYOUT_METHODS,
    checkPayoutRules,
    kycConfigured,
    readPayoutFreeze,
    // The vault: labels to read, secrets only at the moment of use.
    listPayoutDestinations,
    loadPayoutDestinationSecret,
    loadPayoutIdentitySecret,
    loadPayoutIdentitySecretStrict,
    getPayoutIdentity,
    savePayoutDestination,
    savePayoutIdentity,
    touchPayoutDestination,
    forgetPayoutDetails,
    setPayoutDestinationNickname,
    beneficiariesAvailable,
    // Links, sends, top-ups, KYC, invites, profile.
    createPaymentRequest,
    cancelPaymentRequest,
    sendMoney,
    startKycSession,
    syncKycFromDecision,
    rememberPendingWithdraw,
    clearPendingWithdraw,
    ensureReferralCode,
    createDepositIntent,
    getDepositIntent,
    buildCheckoutUrl,
    mergeProfileSubkey: ({ accountId, key, patch }) => mergeProfileSubkeyAtomic({ prisma, accountId, key, patch }),
  };
}

/** What a route uses: the real dependencies, or on `next dev` with the flag, the in-memory fixture. */
export async function appDeps() {
  if (devFixtureOn()) {
    // One fixture per process: next dev bundles every route on its own, so a module-level
    // variable would give each route its own fake database.
    if (!globalThis.__wapayAppFixture) {
      // Built from scratch from pure helpers and fakes: never from realAppDeps(), so the
      // shared database client and the rails are not even in the object.
      const { createFixtureDeps } = await import('./app-dev-fixture.js');
      globalThis.__wapayAppFixture = createFixtureDeps();
    }
    return globalThis.__wapayAppFixture;
  }
  return realAppDeps();
}
