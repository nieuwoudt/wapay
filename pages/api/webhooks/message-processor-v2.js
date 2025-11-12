/**
 * WhatsApp Message Processor V2
 * 
 * Integrates onboarding state machine with message routing
 */

import { getOrCreateUser, getUserBalance, updateConversationState, getConversationState } from './user-manager.js';
import { sendWhatsAppText } from '@wapay/whatsapp';
import prisma from '../../../lib/prisma.js';
import { BluClient } from '@wapay/providers-blu';
import { postBluDeposit } from '@wapay/domain';
import { chatWithAI } from '@wapay/ai';
import {
  getOnboardingState,
  handleS0Initial,
  handleS1WelcomeSent,
  handleS2OtpSent,
  handleS3OtpVerified,
  handleS4PinSet,
  handleResendOTP,
} from '@wapay/auth';

/**
 * Process incoming WhatsApp message
 */
export async function processMessage({ from, text, messageId, profile }) {
  console.log('🔄 Processing message:', { from, text });

  // Get or create user
  const { account, isNewUser } = await getOrCreateUser(from, profile);

  // Get onboarding state
  const onboardingState = await getOnboardingState(account.id);
  
  console.log(`📊 Account state: ${onboardingState} (new: ${isNewUser})`);

  // Handle onboarding flow
  if (onboardingState !== 'S5_COMPLETED') {
    return await handleOnboardingFlow({
      account,
      from,
      text,
      profile,
      onboardingState,
    });
  }

  // User is fully onboarded - handle normal operations
  return await handlePostOnboarding({
    account,
    from,
    text,
  });
}

/**
 * Handle onboarding flow (S0 → S5)
 */
async function handleOnboardingFlow({ account, from, text, profile, onboardingState }) {
  const displayName = profile?.name || account.displayName || 'Friend';

  switch (onboardingState) {
    case 'S0_INITIAL':
      // First message - send welcome
      return await handleS0Initial({
        accountId: account.id,
        waId: from,
        displayName,
      });

    case 'S1_WELCOME_SENT':
      // User responded to welcome - send OTP
      return await handleS1WelcomeSent({
        accountId: account.id,
        waId: from,
        msisdn: account.msisdn,
        displayName,
        userMessage: text,
      });

    case 'S2_OTP_SENT':
      // User entered OTP - verify it
      // Check for "resend" request
      if (/resend|new code|send again/i.test(text)) {
        return await handleResendOTP({
          accountId: account.id,
          waId: from,
          displayName,
        });
      }
      
      return await handleS2OtpSent({
        accountId: account.id,
        waId: from,
        displayName,
        userMessage: text,
      });

    case 'S3_OTP_VERIFIED':
      // User entered PIN - set it
      return await handleS3OtpVerified({
        accountId: account.id,
        waId: from,
        displayName,
        userMessage: text,
      });

    case 'S4_PIN_SET':
      // User accepted consent - complete onboarding
      return await handleS4PinSet({
        accountId: account.id,
        waId: from,
        displayName,
        userMessage: text,
      });

    default:
      console.error(`❌ Unknown onboarding state: ${onboardingState}`);
      return { ok: false, error: 'Unknown state' };
  }
}

/**
 * Handle post-onboarding operations (normal banking)
 */
async function handlePostOnboarding({ account, from, text }) {
  console.log('💬 Post-onboarding message:', text);

  // Check if user is in a conversation state (e.g., entering voucher PIN)
  const { state, data } = await getConversationState(from);

  if (state) {
    console.log('💬 User in conversation state:', state);
    return await handleConversationState({ from, text, state, data, account });
  }

  // Detect ONLY explicit intents, route everything else to AI
  const { intent } = detectExplicitIntent(text);
  console.log('🎯 Intent check:', { intent, text });

  try {
    switch (intent) {
      case 'CHECK_BALANCE':
        // Explicit: "balance"
        const { balance, displayName } = await getUserBalance(from);
        return await sendWhatsAppText({
          to: from,
          text: `💰 *Your WaPay Balance*\n\nHi ${displayName}!\n\n💵 Current Balance: R ${balance}\n\nNeed anything else? Just ask me!`,
        });

      case 'HELP':
        // Explicit: "help" or "menu"
        return await sendWhatsAppText({
          to: from,
          text: `👋 Hi! I'm your WaPay assistant.\n\nJust talk to me naturally! For example:\n• "How much money do I have?"\n• "I want to buy R50 airtime"\n• "How do I redeem a voucher?"\n• "Hoe werk WaPay?" (Afrikaans)\n\nI speak all 11 SA languages! 🇿🇦`,
        });

      case 'REDEEM_VOUCHER':
        // Explicit: "redeem voucher"
        await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
        return await sendWhatsAppText({
          to: from,
          text: `🎟️ *Redeem Voucher*\n\nPlease enter your 16-digit Blu Voucher PIN:\n\nExample: 1234-5678-9012-3456\n\nYour balance will be updated instantly!`,
        });

      case 'AI_CHAT':
      default:
        // Everything else goes to AI for natural conversation
        return await handleAIChat({ from, text, account });
    }
  } catch (error) {
    console.error('❌ Error processing message:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Detect ONLY very clear, explicit intents
 */
function detectExplicitIntent(text) {
  const normalized = text.toLowerCase().trim();

  // Balance - only if very clear
  if (/^(balance|check balance|my balance|show balance)$/i.test(normalized)) {
    return { intent: 'CHECK_BALANCE', confidence: 1.0 };
  }

  // Help - only if asking for help explicitly
  if (/^(help|help me|menu)$/i.test(normalized)) {
    return { intent: 'HELP', confidence: 1.0 };
  }

  // Voucher - only if saying "redeem voucher" explicitly
  if (/^(redeem voucher|redeem|voucher)$/i.test(normalized)) {
    return { intent: 'REDEEM_VOUCHER', confidence: 1.0 };
  }

  // Everything else goes to AI (including natural language)
  return { intent: 'AI_CHAT', confidence: 1.0 };
}

/**
 * Handle conversation state (multi-turn conversations)
 */
async function handleConversationState({ from, text, state, data, account }) {
  console.log('💬 Handling conversation state:', { state, text });

  switch (state) {
    case 'AWAITING_VOUCHER_PIN':
      // User entered voucher PIN, process redemption
      return await handleVoucherRedemption({ from, pin: text, account });

    case 'AI_AIRTIME_PURCHASE':
    case 'AI_DATA_PURCHASE':
      // AI-initiated purchase flow (placeholder for future VAS implementation)
      await updateConversationState(from, null);
      return await sendWhatsAppText({
        to: from,
        text: `This feature is coming soon! For now, try:\n• "balance" - Check your balance\n• "redeem voucher" - Add money to your wallet`,
      });

    default:
      // Unknown state, route to AI for help
      await updateConversationState(from, null);
      return await handleAIChat({ from, text, account });
  }
}

/**
 * Handle AI chat for unknown queries
 */
async function handleAIChat({ from, text, account }) {
  console.log('🤖 Routing to AI chat:', text);

  // Check if OpenAI is configured
  if (!process.env.OPENAI_API_KEY) {
    console.log('⚠️ OpenAI not configured, using fallback');
    return await sendWhatsAppText({
      to: from,
      text: `👋 Hi there!\n\nI didn't quite understand that. Here's what I can help you with:\n\n💰 Check balance\n📱 Buy airtime\n📶 Buy data\n🎟️ Redeem voucher\n\nType "help" to see more options!`,
    });
  }

  try {
    const aiResponse = await chatWithAI(text);

    // If AI detected an intent and wants to trigger action
    if (aiResponse.triggerAction && aiResponse.intent) {
      console.log('🎯 AI detected intent:', aiResponse.intent, aiResponse.entities);

      // Send AI's text response first
      await sendWhatsAppText({
        to: from,
        text: aiResponse.text,
      });

      // Then handle the intent
      switch (aiResponse.intent) {
        case 'BUY_AIRTIME':
          await updateConversationState(from, 'AI_AIRTIME_PURCHASE', aiResponse.entities);
          return await sendWhatsAppText({
            to: from,
            text: `I'll help you buy airtime! This feature will be available soon. For now, type "balance" to check your balance.`,
          });

        case 'BUY_DATA':
          await updateConversationState(from, 'AI_DATA_PURCHASE', aiResponse.entities);
          return await sendWhatsAppText({
            to: from,
            text: `I'll help you buy data! This feature will be available soon. For now, type "balance" to check your balance.`,
          });

        case 'REDEEM_VOUCHER':
          await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
          return await sendWhatsAppText({
            to: from,
            text: `🎟️ *Redeem Voucher*\n\nPlease enter your 16-digit Blu Voucher PIN:\n\nExample: 1234-5678-9012-3456`,
          });

        case 'CHECK_BALANCE':
          const { balance, displayName } = await getUserBalance(from);
          return await sendWhatsAppText({
            to: from,
            text: `💰 *Your WaPay Balance*\n\nHi ${displayName}!\nYour current balance is R ${balance}\n\nWhat would you like to do next?`,
          });

        case 'HELP':
          return await sendWhatsAppText({
            to: from,
            text: `📋 *WaPay Help Menu*\n\nHere's what I can help you with:\n\n💰 *Balance*\n"What's my balance?"\n\n📱 *Airtime*\n"Buy R50 airtime"\n\n📶 *Data*\n"Buy 1GB data"\n\n🎟️ *Voucher*\n"Redeem voucher"\n\nJust ask me in your own words! I understand natural language.`,
          });

        default:
          return await sendWhatsAppText({
            to: from,
            text: aiResponse.text,
          });
      }
    }

    // Otherwise, just send AI's informational response
    return await sendWhatsAppText({
      to: from,
      text: aiResponse.text,
    });

  } catch (error) {
    console.error('❌ AI chat error:', error);

    let fallbackMessage = `I'm having trouble understanding. Type "help" to see what I can do!`;

    if (error.message === 'AI_QUOTA_EXCEEDED') {
      fallbackMessage = `I'm temporarily unavailable. Please type "help" to see available commands.`;
    } else if (error.message === 'AI_CONFIG_ERROR') {
      fallbackMessage = `Service configuration issue. Please type "help" for available commands.`;
    }

    return await sendWhatsAppText({
      to: from,
      text: fallbackMessage,
    });
  }
}

/**
 * Handle voucher redemption
 */
async function handleVoucherRedemption({ from, pin, account }) {
  console.log('🎟️ Processing voucher redemption:', { from, pin: '***' });

  // Normalize PIN (remove spaces, dashes)
  const normalizedPin = pin.replace(/[\s-]/g, '');

  // Validate PIN format (should be 16 digits)
  if (!/^\d{16}$/.test(normalizedPin)) {
    await updateConversationState(from, null);
    return await sendWhatsAppText({
      to: from,
      text: `❌ *Invalid Voucher PIN*\n\nPlease enter a valid 16-digit voucher PIN.\n\nExample: 1234-5678-9012-3456\n\nTry again by typing "redeem voucher"`,
    });
  }

  // Send "processing" message
  await sendWhatsAppText({
    to: from,
    text: `⏳ *Processing Voucher*\n\nPlease wait while we redeem your voucher...`,
  });

  try {
    const bluClient = new BluClient();
    const idemKey = `wapay-redeem-${account.id}-${Date.now()}`;

    // Attempt redemption
    console.log('💰 Calling Blu API to redeem voucher');
    const result = await bluClient.redeem(normalizedPin, idemKey);

    console.log('✅ Voucher redeemed successfully:', {
      providerRef: result.providerRef,
      amountCents: result.amount_cents
    });

    // Post to ledger
    console.log('📖 Posting to ledger');
    const { journalEntryId } = await postBluDeposit({
      accountId: account.id,
      amountCents: result.amount_cents,
      providerRef: result.providerRef,
      idemKey,
    });

    console.log('✅ Ledger posted:', journalEntryId);

    // Get updated balance
    const { balance, displayName } = await getUserBalance(from);

    // Clear conversation state
    await updateConversationState(from, null);

    // Format amount
    const amountRands = (result.amount_cents / 100).toFixed(2);

    // Send success message
    await sendWhatsAppText({
      to: from,
      text: `✅ *Voucher Redeemed Successfully!*\n\n💰 Amount: R ${amountRands}\n📈 New Balance: R ${balance}\n📝 Reference: ${result.providerRef}\n\nWhat would you like to do next?\n• Check balance\n• Buy airtime\n• Buy data\n\nReply with your choice!`,
    });

    return { ok: true };

  } catch (error) {
    console.error('❌ Voucher redemption error:', error);

    // Clear conversation state
    await updateConversationState(from, null);

    // Determine error type and message
    let errorMessage = 'Sorry, we could not process your voucher. Please try again later.';

    if (error.message === 'USER_INPUT') {
      errorMessage = error.reason || 'Invalid voucher PIN or voucher already used.';
    } else if (error.message === 'AUTH') {
      errorMessage = 'System error. Please contact support.';
    } else if (error.message === 'RETRYABLE') {
      errorMessage = 'Service temporarily unavailable. Please try again in a few minutes.';
    }

    await sendWhatsAppText({
      to: from,
      text: `❌ *Voucher Redemption Failed*\n\n${errorMessage}\n\nNeed help? Type "help" for options.`,
    });

    return { ok: false, error: error.message };
  }
}

