/**
 * WhatsApp Message Processor
 * 
 * Processes incoming WhatsApp messages and sends appropriate template responses
 */

import { getOrCreateUser, updateOnboardingStatus, getUserBalance, updateConversationState, getConversationState } from './user-manager';
import { resolveLanguage } from '@wapay/whatsapp';
import prisma from '../../../lib/prisma';
import { BluClient } from '@wapay/providers-blu';
import { postBluDeposit } from '@wapay/domain';
import { chatWithAI } from '@wapay/ai';

/**
 * Send WhatsApp text message (fallback)
 */
async function sendTextMessage({ to, text }) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!accessToken || !phoneNumberId) {
    console.error('❌ Missing WhatsApp credentials');
    return { ok: false, error: 'Missing credentials' };
  }

  const url = `https://graph.facebook.com/v24.0/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  };

  try {
    console.log('📤 Sending text message:', { to, text });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ Text message send failed:', data);
      return { ok: false, error: data };
    }

    console.log('✅ Text message sent successfully:', data);
    return { ok: true, data };

  } catch (error) {
    console.error('❌ Error sending text message:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Send WhatsApp template message
 */
async function sendTemplateMessage({ to, templateName, preferredLanguage = 'en_US', components = [] }) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!accessToken || !phoneNumberId) {
    console.error('❌ Missing WhatsApp credentials');
    return { ok: false, error: 'Missing credentials' };
  }

  // Resolve the actual language from the catalog
  const languageCode = resolveLanguage(templateName, preferredLanguage);
  
  if (!languageCode) {
    console.error(`❌ Template '${templateName}' not found in catalog. Seed templates first.`);
    return { ok: false, error: `Template '${templateName}' not available` };
  }

  const url = `https://graph.facebook.com/v24.0/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode, policy: 'deterministic' },
      components,
    },
  };

  try {
    console.log('📤 Sending template:', { to, templateName, languageCode, components });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ Template send failed:', data);
      return { ok: false, error: data };
    }

    console.log('✅ Template sent successfully:', data);
    return { ok: true, data };

  } catch (error) {
    console.error('❌ Error sending template:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Detect ONLY very clear, explicit intents
 * Everything else routes to AI for conversational handling
 */
function detectExplicitIntent(text) {
  const normalized = text.toLowerCase().trim();

  // Only match if it's VERY explicit (full command-style)
  
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
  // Examples that will go to AI:
  // - "How much money do I have?"
  // - "I want to buy airtime"
  // - "Can you help me?"
  // - "What can I do?"
  // This makes it conversational!
  
  return { intent: 'AI_CHAT', confidence: 1.0 };
}

/**
 * Handle onboarding flow
 */
async function handleOnboarding({ from, text, account }) {
  const displayName = account.displayName || 'Friend';
  
  // Step 1: Send welcome message (first time user)
  if (account.onboardingStatus === 'NEW') {
    console.log('📝 New user - starting onboarding flow');
    
    // Try welcome template first
    const welcomeResult = await sendTemplateMessage({
      to: from,
      templateName: 'welcome_new_user',
      preferredLanguage: 'en_US',
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: displayName }],
        },
      ],
    });
    
    // If template fails, use conversational text
    if (!welcomeResult.ok) {
      await sendTextMessage({
        to: from,
        text: `👋 Welcome to WaPay, ${displayName}!\n\nI'm your personal banking assistant on WhatsApp. I can help you:\n\n💰 Manage your money\n📱 Buy airtime & data\n🎟️ Redeem vouchers\n💸 Send money to friends\n\nAnd I speak all 11 South African languages! 🇿🇦\n\nLet's get you set up - just say "continue" or ask me anything!`,
      });
    }
    
    await updateOnboardingStatus(account.id, 'WELCOME_SENT');
    await updateConversationState(from, 'ONBOARDING_WELCOME');
    return { ok: true };
  }
  
  // Step 2: User wants to continue onboarding
  const { state } = await getConversationState(from);
  
  if (state === 'ONBOARDING_WELCOME') {
    console.log('📝 Completing onboarding');
    
    // Try onboarding_continue template (if exists)
    const continueResult = await sendTemplateMessage({
      to: from,
      templateName: 'onboarding_continue',
      preferredLanguage: 'en_US',
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: displayName }],
        },
      ],
    });
    
    // Fallback to conversational text
    if (!continueResult.ok) {
      await sendTextMessage({
        to: from,
        text: `Perfect! Creating your WaPay account now... ⚡`,
      });
    }
    
    // Short delay for better UX
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // Complete onboarding
    await sendAccountCreated(from, displayName);
    
    return { ok: true };
  }
  
  // User is in onboarding but sent something else - route to AI
  console.log('💬 User in onboarding sent message, routing to AI');
  return await handleAIChat({ from, text, account });
}

/**
 * Send account created confirmation
 */
async function sendAccountCreated(to, displayName) {
  console.log('✅ Sending account created confirmation');
  
  const { balance } = await getUserBalance(to);
  
  // Try account_ready template (if exists)
  const accountReadyResult = await sendTemplateMessage({
    to,
    templateName: 'account_ready',
    preferredLanguage: 'en_US',
    components: [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: displayName },
          { type: 'text', text: balance },
        ],
      },
    ],
  });
  
  // Fallback to conversational text
  if (!accountReadyResult.ok) {
    await sendTextMessage({
      to,
      text: `🎉 All done, ${displayName}!\n\nYour WaPay account is ready!\n\n💰 Current Balance: R ${balance}\n\nI'm here to help anytime. Just ask me:\n• "How do I redeem a voucher?"\n• "I want to buy airtime"\n• "What's my balance?"\n\nOr say anything in your own words - I understand! 😊`,
    });
  }
  
  // Update to completed
  const account = await prisma.account.findFirst({ where: { waId: to } });
  if (account) {
    await updateOnboardingStatus(account.id, 'COMPLETED');
    await updateConversationState(to, null); // Clear conversation state
  }
}

/**
 * Process incoming WhatsApp message
 */
export async function processMessage({ from, text, messageId, profile }) {
  console.log('🔄 Processing message:', { from, text });

  // Get or create user
  const { account, isNewUser } = await getOrCreateUser(from, profile);
  
  // Handle onboarding for new users or users in onboarding flow
  if (isNewUser || !account.onboardingStatus || account.onboardingStatus !== 'COMPLETED') {
    return await handleOnboarding({ from, text, account });
  }
  
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
        return await sendTextMessage({
          to: from,
          text: `💰 *Your WaPay Balance*\n\nHi ${displayName}!\n\n💵 Current Balance: R ${balance}\n\nNeed anything else? Just ask me!`,
        });

      case 'HELP':
        // Explicit: "help" or "menu"
        return await sendTextMessage({
          to: from,
          text: `👋 Hi! I'm your WaPay assistant.\n\nJust talk to me naturally! For example:\n• "How much money do I have?"\n• "I want to buy R50 airtime"\n• "How do I redeem a voucher?"\n• "Hoe werk WaPay?" (Afrikaans)\n\nI speak all 11 SA languages! 🇿🇦`,
        });

      case 'REDEEM_VOUCHER':
        // Explicit: "redeem voucher"
        await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
        return await sendTextMessage({
          to: from,
          text: `🎟️ *Redeem Voucher*\n\nPlease enter your 16-digit Blu Voucher PIN:\n\nExample: 1234-5678-9012-3456\n\nYour balance will be updated instantly!`,
        });

      case 'AI_CHAT':
      default:
        // Everything else goes to AI for natural conversation
        // This includes:
        // - "How much money do I have?" → AI detects balance intent
        // - "I want airtime" → AI guides through purchase
        // - "Can you help me?" → AI provides contextual help
        // - Natural language in any SA language
        return await handleAIChat({ from, text, account });
    }
  } catch (error) {
    console.error('❌ Error processing message:', error);
    return { ok: false, error: error.message };
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
    return await sendTextMessage({
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
      await sendTextMessage({
        to: from,
        text: aiResponse.text,
      });
      
      // Then handle the intent
      switch (aiResponse.intent) {
        case 'BUY_AIRTIME':
          // Set conversation state for airtime purchase
          await updateConversationState(from, 'AI_AIRTIME_PURCHASE', aiResponse.entities);
          return await sendTextMessage({
            to: from,
            text: `I'll help you buy airtime! This feature will be available soon. For now, type "balance" to check your balance.`,
          });
          
        case 'BUY_DATA':
          // Set conversation state for data purchase
          await updateConversationState(from, 'AI_DATA_PURCHASE', aiResponse.entities);
          return await sendTextMessage({
            to: from,
            text: `I'll help you buy data! This feature will be available soon. For now, type "balance" to check your balance.`,
          });
          
        case 'REDEEM_VOUCHER':
          // Trigger voucher redemption flow
          await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
          return await sendTextMessage({
            to: from,
            text: `🎟️ *Redeem Voucher*\n\nPlease enter your 16-digit Blu Voucher PIN:\n\nExample: 1234-5678-9012-3456`,
          });
          
        case 'CHECK_BALANCE':
          const { balance, displayName } = await getUserBalance(from);
          return await sendTextMessage({
            to: from,
            text: `💰 *Your WaPay Balance*\n\nHi ${displayName}!\nYour current balance is R ${balance}\n\nWhat would you like to do next?`,
          });
          
        case 'HELP':
          return await sendTextMessage({
            to: from,
            text: `📋 *WaPay Help Menu*\n\nHere's what I can help you with:\n\n💰 *Balance*\n"What's my balance?"\n\n📱 *Airtime*\n"Buy R50 airtime"\n\n📶 *Data*\n"Buy 1GB data"\n\n🎟️ *Voucher*\n"Redeem voucher"\n\nJust ask me in your own words! I understand natural language.`,
          });
          
        default:
          // Unknown intent from AI, just send response
          return await sendTextMessage({
            to: from,
            text: aiResponse.text,
          });
      }
    }
    
    // Otherwise, just send AI's informational response
    return await sendTextMessage({
      to: from,
      text: aiResponse.text,
    });
    
  } catch (error) {
    console.error('❌ AI chat error:', error);
    
    // Provide helpful fallback based on error
    let fallbackMessage = `I'm having trouble understanding. Type "help" to see what I can do!`;
    
    if (error.message === 'AI_QUOTA_EXCEEDED') {
      fallbackMessage = `I'm temporarily unavailable. Please type "help" to see available commands.`;
    } else if (error.message === 'AI_CONFIG_ERROR') {
      fallbackMessage = `Service configuration issue. Please type "help" for available commands.`;
    }
    
    return await sendTextMessage({
      to: from,
      text: fallbackMessage,
    });
  }
}

/**
 * Handle conversation state (multi-turn conversations)
 */
async function handleConversationState({ from, text, state, data, account }) {
  console.log('💬 Handling conversation state:', { state, text });
  
  switch (state) {
    case 'AWAITING_VOUCHER_PIN':
      // User entered voucher PIN - single-step flow
      {
        const normalized = text.trim().toLowerCase();
        
        if (/^(cancel|stop|reset)$/i.test(normalized)) {
          await updateConversationState(from, null);
          return await sendTextMessage({
            to: from,
            text: `👍 Cancelled. Type "redeem voucher" when ready.`,
          });
        }
        
        const normalizedPin = text.replace(/[\s-]/g, '');
        
        if (!/^\d{16}$/.test(normalizedPin)) {
          await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
          return await sendTextMessage({
            to: from,
            text: `❌ Invalid PIN. Please enter 16 digits. Reply "cancel" to stop.`,
          });
        }
        
        // PIN is valid - redeem immediately
        return await handleVoucherRedemption({ from, pin: normalizedPin, account });
      }
      
    case 'AI_AIRTIME_PURCHASE':
    case 'AI_DATA_PURCHASE':
      // AI-initiated purchase flow (placeholder for future VAS implementation)
      await updateConversationState(from, null);
      return await sendTextMessage({
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
 * Handle voucher redemption
 */
async function handleVoucherRedemption({ from, pin, account }) {
  console.log('🎟️ Processing voucher redemption:', { from, pin: '***' });
  
  // Send "processing" message
  await sendTextMessage({
    to: from,
    text: `⏳ *Processing Voucher*\n\nPlease wait while we redeem your voucher...`,
  });
  
  try {
    const bluClient = new BluClient();
    const idemKey = `wapay-redeem-${account.id}-${Date.now()}`;
    
    // Check voucher status first to get amount
    let statusInfo;
    try {
      statusInfo = await bluClient.checkStatus(pin);
      console.log('🔎 Voucher status check', { from, status: statusInfo });
      
      if (statusInfo.status === 'USED') {
        await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
        return await sendTextMessage({
          to: from,
          text: `❌ *Voucher Already Used*\n\nThis voucher has already been redeemed. Please try another PIN.`,
        });
      }
      
      if (statusInfo.status === 'EXPIRED') {
        await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
        return await sendTextMessage({
          to: from,
          text: `❌ *Voucher Expired*\n\nThis voucher has expired. Please try another PIN.`,
        });
      }
      
      if (!statusInfo.amount_cents) {
        await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
        return await sendTextMessage({
          to: from,
          text: `❌ *Voucher Amount Unknown*\n\nCould not determine voucher value. Please verify the PIN.`,
        });
      }
    } catch (statusError) {
      console.error('⚠️ Status check failed', statusError);
      await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
      return await sendTextMessage({
        to: from,
        text: `❌ *Status Check Failed*\n\nCould not verify voucher. Please try again in a moment.`,
      });
    }
    
    const amountCents = statusInfo.amount_cents;
    console.log('💰 Calling Blu API to redeem voucher', { amountCents });
    const result = await bluClient.redeem(pin, idemKey, amountCents);
    
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
    
    // Try to send success template
    const successResult = await sendTemplateMessage({
      to: from,
      templateName: 'bluvoucher_redeem_success',
      preferredLanguage: 'en_US',
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: amountRands },
            { type: 'text', text: balance },
          ],
        },
      ],
    });
    
    if (!successResult.ok) {
      // Fallback to text
      await sendTextMessage({
        to: from,
        text: `✅ *Voucher Redeemed Successfully!*\n\n💰 Amount: R ${amountRands}\n📈 New Balance: R ${balance}\n📝 Reference: ${result.providerRef}\n\nWhat would you like to do next?\n• Check balance\n• Buy airtime\n• Buy data\n\nReply with your choice!`,
      });
    }
    
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
    
    // Try to send failure template
    const failureResult = await sendTemplateMessage({
      to: from,
      templateName: 'deposit_failed',
      preferredLanguage: 'en_US',
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: errorMessage },
          ],
        },
      ],
    });
    
    if (!failureResult.ok) {
      // Fallback to text
      await sendTextMessage({
        to: from,
        text: `❌ *Voucher Redemption Failed*\n\n${errorMessage}\n\nNeed help? Type "help" for options.`,
      });
    }
    
    return { ok: false, error: error.message };
  }
}

