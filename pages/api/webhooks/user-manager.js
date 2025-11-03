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
    let account = await prisma.accounts.findFirst({
      where: { wa_id: waId },
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

    account = await prisma.accounts.create({
      data: {
        wa_id: waId,
        display_name: profile.name || 'Friend',
        status: 'PENDING_ONBOARDING',
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    // Create wallet for new user
    const wallet = await prisma.wallets.create({
      data: {
        account_id: account.id,
        currency: 'ZAR',
        available_balance: 0,
        pending_balance: 0,
        created_at: new Date(),
        updated_at: new Date(),
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
        wa_id: waId,
        display_name: 'Friend',
        status: 'PENDING_ONBOARDING',
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
    await prisma.accounts.update({
      where: { id: accountId },
      data: {
        status,
        updated_at: new Date(),
      },
    });
    console.log('✅ Updated onboarding status:', { accountId, status });
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
    const account = await prisma.accounts.findFirst({
      where: { wa_id: waId },
      include: {
        wallets: true,
      },
    });

    if (!account || !account.wallets || account.wallets.length === 0) {
      return { balance: 0, displayName: 'Friend' };
    }

    const wallet = account.wallets[0];
    const balanceCents = wallet.available_balance || 0;
    const balanceRands = (balanceCents / 100).toFixed(2);

    return {
      balance: balanceRands,
      displayName: account.display_name || 'Friend',
    };

  } catch (error) {
    console.error('❌ Error getting user balance:', error);
    return { balance: '0.00', displayName: 'Friend' };
  }
}

