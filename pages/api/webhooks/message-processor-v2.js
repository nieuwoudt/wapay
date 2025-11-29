/**
 * WhatsApp Message Processor V2
 * 
 * Integrates onboarding state machine with message routing.
 * Includes structured logging for debugging VAS flows.
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
 * Structured logging helper for Vercel logs
 */
function logStructured(type, data) {
  console.log(JSON.stringify({
    type,
    ...data,
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Blu QA Test Numbers - Whitelisted by Blu for testing
 */
const BLU_QA_TEST_NUMBERS = new Set([
  '0840012300', // Cell C
  '0720012345', // Vodacom
  '0830012300', // MTN
  '0850012345', // Telkom
]);

/**
 * Validate SA mobile number format
 * Accepts standard SA mobile format + Blu QA test numbers
 */
function isValidMsisdn(msisdn) {
  // Whitelist Blu QA test numbers
  if (BLU_QA_TEST_NUMBERS.has(msisdn)) {
    return true;
  }
  
  // Standard SA mobile: 10 digits starting with 0
  // Prefixes: 06x, 07x, 08x
  return /^0\d{9}$/.test(msisdn);
}

/**
 * Process incoming WhatsApp message
 */
export async function processMessage({ from, text, messageId, profile }) {
  // Log incoming message
  logStructured('whatsapp_inbound', {
    from,
    text,
    messageId,
    profileName: profile?.name,
  });

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
  const detection = detectExplicitIntent(text);
  const intent = detection.intent;
  
  // Log NLP intent detection
  logStructured('nlp_intent', {
    from,
    text,
    intent,
    confidence: detection.confidence,
    entities: detection.entities || {},
    triggerAction: detection.triggerAction || false,
  });
  
  console.log('🎯 Intent check:', { intent, text, detection });

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
      case 'VOUCHER_PIN':
        await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
        return await handleVoucherRedemption({ from, pin: detection.voucherPin || text, account });

      case 'BUY_AIRTIME':
        // User wants to buy airtime - start airtime flow
        logStructured('vas_airtime_flow_start', {
          from,
          accountId: account.id,
          entities: detection.entities,
        });
        
        await updateConversationState(from, 'AIRTIME_AMOUNT', detection.entities || {});
        
        // Check if we already have amount from the message
        if (detection.entities?.amount) {
          // Ask for phone number
          await updateConversationState(from, 'AIRTIME_MSISDN', { 
            amountCents: detection.entities.amount * 100 
          });
          return await sendWhatsAppText({
            to: from,
            text: `📱 *Buy R${detection.entities.amount} Airtime*\n\nWhich phone number should I send the airtime to?\n\nReply with the number (e.g., 0781234567) or "me" for your own number.`,
          });
        }
        
        return await sendWhatsAppText({
          to: from,
          text: `📱 *Buy Airtime*\n\nHow much airtime would you like to buy?\n\nReply with an amount (e.g., R10, R50, R100)`,
        });

      // ====================================================================
      // LIST INTENTS - Show real catalogue data, not generic responses
      // ====================================================================
      case 'LIST_DATA_BUNDLES':
        return await handleListDataBundles({ from, account, entities: detection.entities });
        
      case 'LIST_VAS_PRODUCTS':
        return await handleListVasProducts({ from, account });

      case 'AI_CHAT':
      default:
        // Everything else goes to AI for natural conversation
        return await handleAIChat({ from, text, account });
    }
  } catch (error) {
    console.error('❌ Error processing message:', error);
    logStructured('message_processing_error', {
      from,
      text,
      intent,
      error: error.message,
    });
    return { ok: false, error: error.message };
  }
}

/**
 * Detect ONLY very clear, explicit intents
 */
function detectExplicitIntent(text = '') {
  const normalized = text.toLowerCase().trim();
  const squashed = normalized.replace(/\s+/g, ' ');
  const digitsOnly = text.replace(/[^\d]/g, '');

  // =====================================================================
  // CHECK BALANCE - Accept natural language variations
  // =====================================================================
  const balancePatterns = [
    /^(balance|check balance|my balance|show balance)$/i,
    /what('s| is) (my|the|your) (account )?balance/i,
    /how much (money|do i have|is in my (account|wallet))/i,
    /show (me )?(my )?balance/i,
    /check (my )?balance/i,
    /what'?s (my|the) balance/i,
    /balance check/i,
  ];

  for (const pattern of balancePatterns) {
    if (pattern.test(squashed)) {
      return { intent: 'CHECK_BALANCE', confidence: 0.95, triggerAction: true };
    }
  }

  // Help - explicit request
  if (/^(help|help me|menu|options)$/i.test(squashed)) {
    return { intent: 'HELP', confidence: 1.0 };
  }

  // Deposit / voucher keywords (catch template buttons like "Deposit Money")
  const wantsDeposit =
    /(redeem|use|get)\s+(my\s+)?(blu\s+)?voucher/.test(squashed) ||
    /(voucher\s*(code|pin|number))/.test(squashed) ||
    /(deposit|top\s*up|topup|add|load|put)\s+(money|funds|cash|to my wallet|to wallet|into wallet)/.test(squashed) ||
    squashed.includes('deposit money') ||
    squashed.includes('blu voucher');

  if (wantsDeposit) {
    return { intent: 'REDEEM_VOUCHER', confidence: 1.0 };
  }

  if (/^\d{16}$/.test(digitsOnly)) {
    return { intent: 'VOUCHER_PIN', confidence: 1.0, voucherPin: digitsOnly };
  }

  // =====================================================================
  // LIST VAS PRODUCTS - "What can I buy?", "Top 10 products", etc.
  // Must check BEFORE specific bundle/airtime patterns
  // =====================================================================
  const vasProductPatterns = [
    /what\s+(vas\s+)?products?\s+(can|do)\s+(i|you)/i,
    /what\s+(can|do)\s+(i|you)\s+buy/i,
    /what\s+services?\s+(do\s+you|are|is)\s+(have|offer|available)/i,
    /show\s+me\s+(your\s+)?(products?|services?|catalogue|catalog)/i,
    /list\s+(all\s+)?(your\s+|of )?(the\s+)?(products?|services?)/i,
    /top\s*\d*\s*(vas\s+)?products?/i,
    /what's\s+available/i,
    /what\s+do\s+you\s+sell/i,
    /what\s+can\s+i\s+buy(\s+on\s+wapay)?/i,
    /can\s+(i|you)\s+list\s+(all|the)?\s*(products?|services?)/i,
    /products?\s+(i\s+can|that\s+i\s+can|available)/i,
    /all\s+(of\s+)?(the\s+)?products?/i,
  ];

  for (const pattern of vasProductPatterns) {
    if (pattern.test(squashed)) {
      return { intent: 'LIST_VAS_PRODUCTS', confidence: 0.95, triggerAction: true };
    }
  }

  // =====================================================================
  // LIST DATA BUNDLES - "Show me Vodacom bundles", "What bundles do you have?"
  // Must check BEFORE BUY_DATA patterns
  // =====================================================================
  const listBundlePatterns = [
    /\b(show|list|what|display)\s+(me\s+)?(the\s+)?(best|all|available)?\s*(vodacom|mtn|cell\s?c|telkom)?\s*(data\s+)?bundles?\b/i,
    /\b(vodacom|mtn|cell\s?c|telkom)('s|s)?\s+(data\s+)?bundles?\b/i,
    /how\s+much\s+(are|is)\s+(the\s+)?(weekly|daily|monthly)?\s*bundles?/i,
    /what\s+(are\s+)?(the\s+)?(vodacom|mtn|cell\s?c|telkom)?\s*(weekly|daily|monthly)?\s*bundles?/i,
    /(weekly|daily|monthly)\s+bundles?\s+(for\s+)?(vodacom|mtn|cell\s?c|telkom)?/i,
    /bundles?\s+(you\s+have|available|for sale)/i,
    /prices?\s+(for|of)\s+(vodacom|mtn|cell\s?c|telkom)?\s*bundles?/i,
  ];

  for (const pattern of listBundlePatterns) {
    if (pattern.test(squashed)) {
      // Extract network
      let networkCode = null;
      if (/vodacom/i.test(squashed)) networkCode = 'VODACOM';
      else if (/mtn/i.test(squashed)) networkCode = 'MTN';
      else if (/cell\s?c/i.test(squashed)) networkCode = 'CELLC';
      else if (/telkom/i.test(squashed)) networkCode = 'TELKOM';
      
      // Extract period
      let periodType = null;
      if (/daily|day/i.test(squashed)) periodType = 'DAILY';
      else if (/weekly|week/i.test(squashed)) periodType = 'WEEKLY';
      else if (/monthly|month/i.test(squashed)) periodType = 'MONTHLY';
      
      return { 
        intent: 'LIST_DATA_BUNDLES', 
        confidence: 0.95, 
        entities: { networkCode, periodType },
        triggerAction: true,
      };
    }
  }

  // =====================================================================
  // Airtime intent detection (BUY, not list)
  // =====================================================================
  const airtimePatterns = [
    /buy\s*(?:r?\s*)?(\d+)\s*(?:rand\s*)?airtime/i,
    /(?:r?\s*)?(\d+)\s*(?:rand\s*)?airtime/i,
    /airtime\s*(?:for\s*)?(?:r?\s*)?(\d+)/i,
    /^(?:buy\s+)?airtime$/i,
    /i\s*(?:want|need)\s*(?:to\s+buy\s+)?(?:r?\s*)?(\d+)?\s*airtime/i,
    /can\s*(?:i|you)\s*(?:buy|get)\s*(?:r?\s*)?(\d+)?\s*airtime/i,
  ];

  for (const pattern of airtimePatterns) {
    const match = squashed.match(pattern);
    if (match) {
      const amount = match[1] ? parseInt(match[1], 10) : null;
      return { 
        intent: 'BUY_AIRTIME', 
        confidence: 0.9, 
        entities: amount ? { amount } : {},
        triggerAction: true,
      };
    }
  }

  // Everything else goes to AI (including natural language)
  return { intent: 'AI_CHAT', confidence: 1.0 };
}

/**
 * Handle conversation state (multi-turn conversations)
 */
async function handleConversationState({ from, text, state, data, account }) {
  console.log('💬 Handling conversation state:', { state, text, data });

  switch (state) {
    case 'AWAITING_VOUCHER_PIN':
      // User entered voucher PIN - single-step flow
      {
        const normalized = text.trim().toLowerCase();

        if (/^(cancel|stop|no|not now|later|reset|restart)$/i.test(normalized)) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `👍 No problem. When you're ready to add money again, just type "redeem voucher".`,
          });
        }

        if (/^(yes|yep|yeah|y|sure|ok|okay|alright|please|confirm)$/i.test(normalized)) {
          await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
          return await sendWhatsAppText({
            to: from,
            text: `Great! Please enter your 16-digit Blu Voucher PIN (numbers only).\nExample: 1234567890123456\n\nReply "cancel" to stop.`,
          });
        }

        // Otherwise treat message as PIN entry
        // Validate and normalize PIN
        const normalizedPin = text.replace(/[\s-]/g, '');
        
        if (!/^\d{16}$/.test(normalizedPin)) {
          await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
          return await sendWhatsAppText({
            to: from,
            text: `❌ *Invalid Voucher PIN*\n\nPlease enter a valid 16-digit Blu Voucher PIN (numbers only).\nExample: 1234567890123456\n\nYou can reply with the PIN now, or type "cancel" to stop.`,
          });
        }
        
        // PIN is valid - redeem immediately (single-step flow)
        return await handleVoucherRedemption({ from, pin: normalizedPin, account });
      }

    case 'AIRTIME_AMOUNT':
      // User is entering airtime amount
      {
        const normalized = text.trim().toLowerCase();
        
        if (/^(cancel|stop|no|not now|later)$/i.test(normalized)) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `👍 No problem. Let me know when you want to buy airtime.`,
          });
        }
        
        // Parse amount
        const amountMatch = text.match(/(\d+)/);
        if (!amountMatch) {
          return await sendWhatsAppText({
            to: from,
            text: `Please enter a valid amount (e.g., R10, R50, R100)\n\nReply "cancel" to stop.`,
          });
        }
        
        const amountCents = parseInt(amountMatch[1], 10) * 100;
        
        // Validate amount
        if (amountCents < 500 || amountCents > 100000) {
          return await sendWhatsAppText({
            to: from,
            text: `Amount must be between R5 and R1000.\n\nPlease enter a valid amount.`,
          });
        }
        
        // Move to phone number collection
        await updateConversationState(from, 'AIRTIME_MSISDN', { amountCents });
        return await sendWhatsAppText({
          to: from,
          text: `📱 *R${amountCents / 100} Airtime*\n\nWhich phone number should I send the airtime to?\n\nReply with the number (e.g., 0781234567) or "me" for your own number.`,
        });
      }

    case 'AIRTIME_MSISDN':
      // User is entering phone number for airtime
      {
        const normalized = text.trim().toLowerCase();
        
        if (/^(cancel|stop|no|not now|later)$/i.test(normalized)) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `👍 No problem. Let me know when you want to buy airtime.`,
          });
        }
        
        let msisdn = text.trim();
        
        // Handle "me" or "my number"
        if (/^(me|my\s*number|my\s*phone|myself)$/i.test(normalized)) {
          msisdn = account.msisdn;
        }
        
        // Normalize phone number
        msisdn = msisdn.replace(/[\s-]/g, '');
        if (msisdn.startsWith('+27')) {
          msisdn = '0' + msisdn.substring(3);
        } else if (msisdn.startsWith('27')) {
          msisdn = '0' + msisdn.substring(2);
        }
        
        // Validate phone number format
        if (!isValidMsisdn(msisdn)) {
          logStructured('msisdn_validation_failed', {
            from,
            accountId: account.id,
            msisdn,
            reason: 'format_validation_failed',
          });
          
          return await sendWhatsAppText({
            to: from,
            text: `❌ Invalid phone number format.\n\nPlease enter a valid SA mobile number (e.g., 0781234567)`,
          });
        }
        
        const amountCents = data?.amountCents || 1000;
        
        // Log VAS preview call
        logStructured('vas_airtime_preview_initiated', {
          from,
          accountId: account.id,
          msisdn,
          amountCents,
        });
        
        // Move to confirmation state
        await updateConversationState(from, 'AIRTIME_CONFIRM', { amountCents, msisdn });
        
        return await sendWhatsAppText({
          to: from,
          text: `📱 *Confirm Airtime Purchase*\n\n` +
                `Amount: R${amountCents / 100}\n` +
                `Number: ${msisdn}\n\n` +
                `Reply *YES* to confirm or *NO* to cancel.`,
        });
      }

    case 'AIRTIME_CONFIRM':
      // User is confirming airtime purchase
      {
        const normalized = text.trim().toLowerCase();
        
        if (/^(no|cancel|stop|not now|later)$/i.test(normalized)) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `👍 Airtime purchase cancelled. Let me know if you need anything else.`,
          });
        }
        
        if (/^(yes|yep|yeah|y|sure|ok|okay|alright|confirm)$/i.test(normalized)) {
          const { amountCents, msisdn } = data || {};
          
          if (!amountCents || !msisdn) {
            await updateConversationState(from, null);
            return await sendWhatsAppText({
              to: from,
              text: `❌ Something went wrong. Please start again by saying "buy airtime".`,
            });
          }
          
          // Log execute initiated
          logStructured('vas_airtime_execute_initiated', {
            from,
            accountId: account.id,
            msisdn,
            amountCents,
          });
          
          // Clear state first
          await updateConversationState(from, null);
          
          // Call preview API
          try {
            const previewRes = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || ''}/api/vas/airtime/preview`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                accountId: account.id,
                msisdn,
                amountCents,
              }),
            });
            
            const previewData = await previewRes.json();
            
            if (!previewData.ok) {
              logStructured('vas_airtime_preview_failed', {
                from,
                accountId: account.id,
                error: previewData.error,
                message: previewData.message,
              });
              
              return await sendWhatsAppText({
                to: from,
                text: `❌ ${previewData.message || 'Could not process airtime purchase.'}\n\nPlease try again later.`,
              });
            }
            
            // For now, we need PIN to execute
            // In stub mode, we'll simulate success
            await updateConversationState(from, 'AIRTIME_PIN', { 
              previewId: previewData.previewId,
              amountCents,
              msisdn,
              vendorName: previewData.preview?.vendorName,
            });
            
            return await sendWhatsAppText({
              to: from,
              text: `🔐 *Enter Your PIN*\n\n` +
                    `To complete your R${amountCents / 100} airtime purchase to ${msisdn}, please enter your 5-digit WaPay PIN.`,
            });
            
          } catch (error) {
            console.error('Preview API error:', error);
            logStructured('vas_airtime_preview_error', {
              from,
              accountId: account.id,
              error: error.message,
            });
            
            return await sendWhatsAppText({
              to: from,
              text: `❌ Service temporarily unavailable. Please try again later.`,
            });
          }
        }
        
        // Unrecognized response
        return await sendWhatsAppText({
          to: from,
          text: `Please reply *YES* to confirm or *NO* to cancel.`,
        });
      }

    case 'AIRTIME_PIN':
      // User entering PIN to complete airtime purchase
      {
        const normalized = text.trim();
        
        if (/^(cancel|stop|no)$/i.test(normalized.toLowerCase())) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `👍 Airtime purchase cancelled.`,
          });
        }
        
        // Validate PIN format (5 digits)
        if (!/^\d{5}$/.test(normalized)) {
          return await sendWhatsAppText({
            to: from,
            text: `❌ Invalid PIN. Please enter your 5-digit WaPay PIN.\n\nReply "cancel" to stop.`,
          });
        }
        
        const { previewId, amountCents, msisdn, vendorName } = data || {};
        
        if (!previewId) {
          await updateConversationState(from, null);
          return await sendWhatsAppText({
            to: from,
            text: `❌ Session expired. Please start again by saying "buy airtime".`,
          });
        }
        
        // Send processing message
        await sendWhatsAppText({
          to: from,
          text: `⏳ Processing your airtime purchase...`,
        });
        
        // Call execute API
        try {
          const executeRes = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || ''}/api/vas/airtime/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              previewId,
              accountId: account.id,
              pin: normalized,
            }),
          });
          
          const executeData = await executeRes.json();
          
          // Clear state
          await updateConversationState(from, null);
          
          if (!executeData.ok) {
            logStructured('vas_airtime_execute_failed', {
              from,
              accountId: account.id,
              previewId,
              error: executeData.error,
              message: executeData.message,
            });
            
            return await sendWhatsAppText({
              to: from,
              text: `❌ ${executeData.message || 'Airtime purchase failed.'}\n\nPlease try again later.`,
            });
          }
          
          // Success!
          logStructured('vas_airtime_execute_success', {
            from,
            accountId: account.id,
            previewId,
            providerRef: executeData.reference,
            amountCents,
            msisdn,
          });
          
          return await sendWhatsAppText({
            to: from,
            text: `✅ *Airtime Purchase Successful!*\n\n` +
                  `📱 Amount: R${amountCents / 100}\n` +
                  `📞 Number: ${msisdn}\n` +
                  `🏢 Network: ${vendorName || 'Detected'}\n` +
                  `📝 Reference: ${executeData.reference}\n` +
                  `💰 New Balance: R${(executeData.transaction?.newBalance / 100).toFixed(2)}\n\n` +
                  `Thank you for using WaPay! 🎉`,
          });
          
        } catch (error) {
          console.error('Execute API error:', error);
          await updateConversationState(from, null);
          
          logStructured('vas_airtime_execute_error', {
            from,
            accountId: account.id,
            previewId,
            error: error.message,
          });
          
          return await sendWhatsAppText({
            to: from,
            text: `❌ Service temporarily unavailable. Please try again later.`,
          });
        }
      }

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

    // Log AI response with intent
    if (aiResponse.triggerAction && aiResponse.intent) {
      logStructured('nlp_intent', {
        from,
        text,
        intent: aiResponse.intent,
        entities: aiResponse.entities,
        triggerAction: true,
        source: 'ai',
      });
    }

    // If AI detected an intent and wants to trigger action
    if (aiResponse.triggerAction && aiResponse.intent) {
      console.log('🎯 AI detected intent:', aiResponse.intent, aiResponse.entities);

      // IMPORTANT: Do NOT send raw JSON to users
      // Extract only the text field if it's a structured response
      const responseText = typeof aiResponse.text === 'string' ? aiResponse.text : 'Let me help you with that.';

      // Then handle the intent (send acknowledgment only for actions that need follow-up)
      switch (aiResponse.intent) {
        case 'BUY_AIRTIME':
          // Start airtime flow
          if (aiResponse.entities?.amount) {
            await updateConversationState(from, 'AIRTIME_MSISDN', { 
              amountCents: aiResponse.entities.amount * 100 
            });
            return await sendWhatsAppText({
              to: from,
              text: `📱 *Buy R${aiResponse.entities.amount} Airtime*\n\nWhich phone number should I send the airtime to?\n\nReply with the number (e.g., 0781234567) or "me" for your own number.`,
            });
          }
          
          await updateConversationState(from, 'AIRTIME_AMOUNT', aiResponse.entities || {});
          return await sendWhatsAppText({
            to: from,
            text: `📱 *Buy Airtime*\n\nHow much airtime would you like to buy?\n\nReply with an amount (e.g., R10, R50, R100)`,
          });

        case 'BUY_DATA':
          await updateConversationState(from, 'AI_DATA_PURCHASE', aiResponse.entities);
          return await sendWhatsAppText({
            to: from,
            text: `📶 Data bundles are coming soon! For now, you can:\n• Check your balance\n• Buy airtime\n• Redeem a voucher`,
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
          // For unhandled intents, send only the text (never JSON)
          return await sendWhatsAppText({
            to: from,
            text: responseText,
          });
      }
    }

    // Otherwise, just send AI's informational response (text only, never JSON)
    const finalText = typeof aiResponse === 'object' && aiResponse.text 
      ? aiResponse.text 
      : typeof aiResponse === 'string' 
        ? aiResponse 
        : 'I can help you with balance checks, airtime, data, and vouchers. What would you like to do?';
    
    return await sendWhatsAppText({
      to: from,
      text: finalText,
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

// ==============================================================================
// CATALOGUE HANDLERS - Return real data from VasProduct catalogue
// ==============================================================================

/**
 * Handle listing data bundles from the catalogue
 */
async function handleListDataBundles({ from, account, entities }) {
  const { networkCode, periodType } = entities || {};
  
  logStructured('vas_bundles_fetch_call', {
    from,
    accountId: account.id,
    intent: 'LIST_DATA_BUNDLES',
    networkCode,
    periodType,
  });

  try {
    // Build query
    const where = {
      category: 'DATA',
      isActive: true,
    };
    
    if (networkCode) {
      where.networkCode = networkCode;
    }
    
    if (periodType) {
      where.periodType = periodType;
    }

    // Get bundles from database
    const bundles = await prisma.vasProduct.findMany({
      where,
      orderBy: [
        { periodType: 'asc' },
        { dataMb: 'asc' },
        { fixedPriceCents: 'asc' },
      ],
      take: 15,
    });

    logStructured('vas_bundles_fetch_result', {
      from,
      intent: 'LIST_DATA_BUNDLES',
      networkCode,
      periodType,
      count: bundles.length,
      success: true,
    });

    if (bundles.length === 0) {
      return await sendWhatsAppText({
        to: from,
        text: `📶 I couldn't find any ${networkCode || ''} ${periodType?.toLowerCase() || ''} bundles in our catalogue.\n\nTry asking for a different network (Vodacom, MTN, Cell C, Telkom) or period (daily, weekly, monthly).`,
      });
    }

    // Format bundles for display
    const networkDisplay = networkCode ? `${networkCode}` : 'All Networks';
    const periodDisplay = periodType ? ` ${periodType.charAt(0) + periodType.slice(1).toLowerCase()}` : '';
    
    let message = `📶 *${networkDisplay}${periodDisplay} Data Bundles*\n\n`;
    
    // Group by period if no specific period requested
    const byPeriod = {};
    for (const b of bundles) {
      const period = b.periodType || 'OTHER';
      if (!byPeriod[period]) byPeriod[period] = [];
      byPeriod[period].push(b);
    }
    
    for (const [period, periodBundles] of Object.entries(byPeriod)) {
      if (!periodType && Object.keys(byPeriod).length > 1) {
        message += `*${period.charAt(0) + period.slice(1).toLowerCase()}*\n`;
      }
      
      for (const b of periodBundles.slice(0, 5)) {
        const sizeMb = b.dataMb;
        const sizeLabel = sizeMb >= 1024 
          ? `${(sizeMb / 1024).toFixed(sizeMb % 1024 === 0 ? 0 : 1)}GB`
          : `${sizeMb}MB`;
        const price = ((b.fixedPriceCents || b.priceCents) / 100).toFixed(0);
        message += `• ${sizeLabel} – R${price}\n`;
      }
      message += '\n';
    }
    
    message += `Reply like: *"Buy 1GB data for 0821234567"* and I'll help you purchase.`;
    
    return await sendWhatsAppText({
      to: from,
      text: message,
    });

  } catch (error) {
    console.error('List data bundles error:', error);
    logStructured('vas_bundles_fetch_result', {
      from,
      intent: 'LIST_DATA_BUNDLES',
      success: false,
      error: error.message,
    });
    
    return await sendWhatsAppText({
      to: from,
      text: `❌ Sorry, I couldn't fetch the bundle list right now. Please try again later.`,
    });
  }
}

/**
 * Handle listing top VAS products
 */
async function handleListVasProducts({ from, account }) {
  logStructured('vas_list_vas_products', {
    from,
    accountId: account.id,
    intent: 'LIST_VAS_PRODUCTS',
  });

  try {
    // Get category counts
    const categoryCounts = await prisma.vasProduct.groupBy({
      by: ['category'],
      where: { isActive: true },
      _count: { id: true },
    });

    // Build friendly category list
    const categoryNames = {
      AIRTIME: { name: '📱 Mobile Airtime', desc: 'Vodacom, MTN, Cell C, Telkom' },
      DATA: { name: '📶 Data Bundles', desc: 'Daily, Weekly, Monthly bundles' },
      ELECTRICITY: { name: '💡 Prepaid Electricity', desc: 'Eskom, City Power, and more' },
      BILLPAY: { name: '📺 Bill Payments', desc: 'DStv, GOtv subscriptions' },
      LIFESTYLE: { name: '🎮 Lifestyle & OTT', desc: 'Netflix, Uber, Google Play, Steam' },
      GAMING: { name: '🎰 Betting & Gaming', desc: 'Hollywoodbets, Lottostar, Betway' },
      REMITTANCE: { name: '💸 Money Transfers', desc: 'Mukuru, Hello Paisa, Mama Money' },
    };

    let message = `🛒 *WaPay VAS Products*\n\nHere's what you can buy on WaPay:\n\n`;
    
    for (const cat of categoryCounts) {
      const info = categoryNames[cat.category];
      if (info) {
        message += `${info.name}\n   _${info.desc}_\n\n`;
      }
    }
    
    message += `━━━━━━━━━━━━━━━━━━\n\n`;
    message += `*How to use:*\n`;
    message += `• "Show me Vodacom bundles"\n`;
    message += `• "Buy R50 airtime"\n`;
    message += `• "Weekly MTN bundles"\n`;
    message += `• "Redeem voucher"\n\n`;
    message += `Just tell me what you need! 🎉`;

    logStructured('vas_list_vas_products_result', {
      from,
      categoryCount: categoryCounts.length,
      success: true,
    });

    return await sendWhatsAppText({
      to: from,
      text: message,
    });

  } catch (error) {
    console.error('List VAS products error:', error);
    logStructured('vas_list_vas_products_result', {
      from,
      success: false,
      error: error.message,
    });
    
    return await sendWhatsAppText({
      to: from,
      text: `❌ Sorry, I couldn't fetch the product list right now. Please try again later.`,
    });
  }
}

/**
 * Handle voucher redemption
 */
async function handleVoucherRedemption({ from, pin, account }) {
  console.log('🎟️ Processing voucher redemption:', { from, pin: '***' });

  // Send "processing" message
  await sendWhatsAppText({
    to: from,
    text: `⏳ *Processing Voucher*\n\nPlease wait while we redeem your voucher...`,
  });

  const bluClient = new BluClient();
  try {
    const idemKey = `wapay-redeem-${account.id}-${Date.now()}`;

    // Check voucher status first to get amount and validate state
    let statusInfo;
    try {
      statusInfo = await bluClient.checkStatus(pin);
      console.log('🔎 Voucher status check', { from, status: statusInfo });
      
      if (statusInfo.status === 'USED') {
        await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
        return await sendWhatsAppText({
          to: from,
          text: `❌ *Voucher Already Used*\n\nThis voucher has already been redeemed. Please try another PIN.`,
        });
      }
      
      if (statusInfo.status === 'EXPIRED') {
        await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
        return await sendWhatsAppText({
          to: from,
          text: `❌ *Voucher Expired*\n\nThis voucher has expired. Please try another PIN.`,
        });
      }
      
      if (!statusInfo.amount_cents) {
        await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
        return await sendWhatsAppText({
          to: from,
          text: `❌ *Voucher Amount Unknown*\n\nCould not determine voucher value. Please verify the PIN and try again.`,
        });
      }
    } catch (statusError) {
      console.error('⚠️ Status check failed', statusError);
      await updateConversationState(from, 'AWAITING_VOUCHER_PIN');
      return await sendWhatsAppText({
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

    // Send success message
    await sendWhatsAppText({
      to: from,
      text: `✅ *Voucher Redeemed Successfully!*\n\n💰 Amount: R ${amountRands}\n📈 New Balance: R ${balance}\n📝 Reference: ${result.providerRef}\n\nWhat would you like to do next?\n• Check balance\n• Buy airtime\n• Buy data\n\nReply with your choice!`,
    });

    return { ok: true };

  } catch (error) {
    console.error('❌ Voucher redemption error:', error);
    const reasonRaw = (error.reason || '').toString().trim();
    const sanitizedReason =
      reasonRaw && !['USER_INPUT', 'AUTH', 'RETRYABLE', 'Error'].includes(reasonRaw) && reasonRaw.toLowerCase() !== 'no message available'
        ? reasonRaw
        : '';

    // Determine error type and message
    let errorMessage = 'Sorry, we could not process your voucher. Please try again later.';
    const errorType = error.message;
    const allowRetry = errorType === 'USER_INPUT' || errorType === 'RETRYABLE';

    // Map Blu error messages to user-friendly text
    if (errorType === 'USER_INPUT') {
      // Use Blu's error message directly when available
      if (sanitizedReason) {
        errorMessage = sanitizedReason;
      } else {
        errorMessage = 'Blu could not redeem that voucher PIN. The voucher may be invalid, already used, or expired. Please verify the digits and try another voucher if needed.';
      }
    } else if (errorType === 'AUTH') {
      errorMessage = 'We could not connect to the voucher provider. Please contact support.';
    } else if (errorType === 'RETRYABLE') {
      errorMessage = sanitizedReason || 'The voucher service is temporarily unavailable. Please try again in a few minutes.';
    } else if (sanitizedReason) {
      errorMessage = sanitizedReason;
    }

    // Keep user in voucher flow if retry makes sense
    await updateConversationState(from, allowRetry ? 'AWAITING_VOUCHER_PIN' : null);

    const retryHint = allowRetry
      ? `\n\nDouble-check the 16-digit PIN and enter it again when you're ready. Reply "cancel" to stop.`
      : `\n\nNeed help? Type "help" for options or try again later.`;

    await sendWhatsAppText({
      to: from,
      text: `❌ *Voucher Redemption Failed*\n\n${errorMessage}${retryHint}`,
    });

    return { ok: false, error: errorType || error.message };
  }
}
