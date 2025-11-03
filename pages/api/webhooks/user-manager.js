/**
 * User Manager
 * 
 * Handles user account creation and session management
 */

import prisma from '../../../lib/prisma';

/**
 * Get or create user account
 */
export async function getOrCreateUser(waId, profile = {}) {
  try {
    // Try to find existing user
    let account = await prisma.account.findFirst({
      where: { waId: waId },
      include: {
        wallets: true,
      },
    });

    if (account) {
      console.log('👤 Existing user found:', account.id);
      return { account, isNewUser: false };
    }

    // Create new user
    console.log('🆕 Creating new user for:', waId);

    account = await prisma.account.create({
      data: {
        waId: waId,
        msisdn: waId, // Use WA ID as MSISDN for now
        displayName: profile.name || 'Friend',
        createdAt: new Date(),
      },
    });

    // Create wallet for new user
    const wallet = await prisma.wallet.create({
      data: {
        accountId: account.id,
        currency: 'ZAR',
        availableCents: 0,
        pendingCents: 0,
      },
    });

    console.log('✅ New user created:', { accountId: account.id, walletId: wallet.id });

    return {
      account: { ...account, wallets: [wallet] },
      isNewUser: true,
    };

  } catch (error) {
    console.error('❌ Error in getOrCreateUser:', error);
    
    // Fallback: return minimal user object
    return {
      account: {
        id: waId,
        waId: waId,
        displayName: 'Friend',
        wallets: [],
      },
      isNewUser: true,
      error: error.message,
    };
  }
}

/**
 * Update user onboarding status
 */
export async function updateOnboardingStatus(accountId, status) {
  try {
    // For now, just log since we don't have a status field yet
    console.log('✅ Onboarding status:', { accountId, status });
    return { ok: true };
  } catch (error) {
    console.error('❌ Error updating onboarding status:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Get user balance
 */
export async function getUserBalance(waId) {
  try {
    const account = await prisma.account.findFirst({
      where: { waId: waId },
      include: {
        wallets: true,
      },
    });

    if (!account || !account.wallets || account.wallets.length === 0) {
      return { balance: '0.00', displayName: 'Friend' };
    }

    const wallet = account.wallets[0];
    const balanceCents = wallet.availableCents || 0;
    const balanceRands = (balanceCents / 100).toFixed(2);

    return {
      balance: balanceRands,
      displayName: account.displayName || 'Friend',
    };

  } catch (error) {
    console.error('❌ Error getting user balance:', error);
    return { balance: '0.00', displayName: 'Friend' };
  }
}

