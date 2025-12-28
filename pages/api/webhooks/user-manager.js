/**
 * User Manager
 * 
 * Handles user account creation and session management
 */

import prisma from '../../../lib/prisma';

export async function wasMessageProcessed(waId, messageId) {
  if (!waId || !messageId) return false;
  try {
    const account = await prisma.account.findFirst({
      where: { waId },
      select: { conversationData: true },
    });
    const data = account?.conversationData || {};
    const ids = Array.isArray(data.processedMessageIds) ? data.processedMessageIds : [];
    return ids.includes(messageId);
  } catch (e) {
    console.error('❌ Error checking processed messageId:', e);
    return false;
  }
}

export async function markMessageProcessed(waId, messageId) {
  if (!waId || !messageId) return { ok: true };
  try {
    const account = await prisma.account.findFirst({
      where: { waId },
      select: { conversationData: true },
    });
    const existingData = account?.conversationData || {};
    const ids = Array.isArray(existingData.processedMessageIds) ? existingData.processedMessageIds : [];
    if (ids.includes(messageId)) return { ok: true, dedup: true };

    const next = [...ids, messageId].slice(-25); // keep last 25
    await prisma.account.update({
      where: { waId },
      data: {
        conversationData: {
          ...existingData,
          processedMessageIds: next,
        },
      },
    });
    return { ok: true };
  } catch (e) {
    console.error('❌ Error marking processed messageId:', e);
    return { ok: false, error: e.message };
  }
}

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
 * Set active category context
 * Used to track what category the user was browsing
 * so follow-up messages can be interpreted correctly
 */
export async function setActiveCategory(waId, category, products = []) {
  try {
    const account = await prisma.account.findFirst({
      where: { waId },
      select: {
        conversationData: true,
      },
    });
    
    const existingData = account?.conversationData || {};
    
    await prisma.account.update({
      where: { waId },
      data: {
        conversationData: {
          ...existingData,
          activeCategory: category,
          categoryTimestamp: Date.now(),
          recentProducts: products.slice(0, 5), // Store up to 5 recent products shown
        },
      },
    });
    
    console.log('✅ Active category set:', { waId, category });
    return { ok: true };
  } catch (error) {
    console.error('❌ Error setting active category:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Get active category context
 * Returns the category user was browsing and when
 */
export async function getActiveCategory(waId) {
  try {
    const account = await prisma.account.findFirst({
      where: { waId },
      select: {
        conversationData: true,
      },
    });
    
    const data = account?.conversationData || {};
    
    // Check if context is still valid (within 5 minutes)
    const categoryTimestamp = data.categoryTimestamp;
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    
    if (categoryTimestamp && categoryTimestamp > fiveMinutesAgo) {
      return {
        category: data.activeCategory || null,
        timestamp: categoryTimestamp,
        products: data.recentProducts || [],
        isValid: true,
      };
    }
    
    return {
      category: null,
      timestamp: null,
      products: [],
      isValid: false,
    };
  } catch (error) {
    console.error('❌ Error getting active category:', error);
    return {
      category: null,
      timestamp: null,
      products: [],
      isValid: false,
    };
  }
}

/**
 * Clear active category context
 */
export async function clearActiveCategory(waId) {
  try {
    const account = await prisma.account.findFirst({
      where: { waId },
      select: {
        conversationData: true,
      },
    });
    
    const existingData = account?.conversationData || {};
    
    // Remove category context but keep history
    const { activeCategory, categoryTimestamp, recentProducts, ...rest } = existingData;
    
    await prisma.account.update({
      where: { waId },
      data: {
        conversationData: rest,
      },
    });
    
    return { ok: true };
  } catch (error) {
    console.error('❌ Error clearing active category:', error);
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

