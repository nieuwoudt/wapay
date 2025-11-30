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
    await prisma.account.update({
      where: { id: accountId },
      data: { onboardingStatus: status },
    });
    
    console.log('✅ Onboarding status updated:', { accountId, status });
    return { ok: true };
  } catch (error) {
    console.error('❌ Error updating onboarding status:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Update user conversation state
 */
export async function updateConversationState(waId, state, data = null) {
  try {
    await prisma.account.update({
      where: { waId },
      data: {
        conversationState: state,
        conversationData: data,
      },
    });
    
    console.log('✅ Conversation state updated:', { waId, state });
    return { ok: true };
  } catch (error) {
    console.error('❌ Error updating conversation state:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Get user conversation state
 */
export async function getConversationState(waId) {
  try {
    const account = await prisma.account.findFirst({
      where: { waId },
      select: {
        conversationState: true,
        conversationData: true,
      },
    });
    
    return {
      state: account?.conversationState || null,
      data: account?.conversationData || null,
    };
  } catch (error) {
    console.error('❌ Error getting conversation state:', error);
    return { state: null, data: null };
  }
}

/**
 * Add message to conversation history
 * Stores last 10 messages for context
 */
export async function addToConversationHistory(waId, role, text) {
  try {
    const account = await prisma.account.findFirst({
      where: { waId },
      select: {
        conversationData: true,
      },
    });
    
    const existingData = account?.conversationData || {};
    const history = existingData.history || [];
    
    // Add new message
    history.push({
      role, // 'user' or 'assistant'
      text,
      timestamp: new Date().toISOString(),
    });
    
    // Keep only last 10 messages
    const trimmedHistory = history.slice(-10);
    
    await prisma.account.update({
      where: { waId },
      data: {
        conversationData: {
          ...existingData,
          history: trimmedHistory,
        },
      },
    });
    
    return { ok: true };
  } catch (error) {
    console.error('❌ Error adding to conversation history:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Get recent conversation history
 * Returns last N messages for AI context
 */
export async function getConversationHistory(waId, limit = 5) {
  try {
    const account = await prisma.account.findFirst({
      where: { waId },
      select: {
        conversationData: true,
      },
    });
    
    const existingData = account?.conversationData || {};
    const history = existingData.history || [];
    
    // Return last N messages
    return history.slice(-limit);
  } catch (error) {
    console.error('❌ Error getting conversation history:', error);
    return [];
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

