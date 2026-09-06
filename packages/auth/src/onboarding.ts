/**
 * Onboarding State Machine
 * 
 * Manages the complete user onboarding flow (S0 → S5)
 * 
 * States:
 * - S0_INITIAL: User sends first message
 * - S1_WELCOME_SENT: Welcome template sent, awaiting user response
 * - S2_OTP_SENT: OTP sent, awaiting verification
 * - S3_OTP_VERIFIED: OTP verified, awaiting PIN creation
 * - S4_PIN_SET: PIN set, awaiting consent
 * - S5_COMPLETED: Onboarding complete, account active
 */

import { getPrisma } from '@wapay/domain';
import { sendWhatsAppTemplate, sendWhatsAppText } from '@wapay/whatsapp';
import { sendOTP, verifyOTP } from './otp.js';
import { setPIN, validatePINFormat, resetPIN, isPINLocked } from './pin.js';
import { recordConsent, hasRequiredConsents } from './consent.js';
import { logAuditEvent } from './audit.js';

export type OnboardingState =
  | 'S0_INITIAL'
  | 'S1_WELCOME_SENT'
  | 'S2_OTP_SENT'
  | 'S3_OTP_VERIFIED'
  | 'S4_PIN_SET'
  | 'S5_COMPLETED';

/**
 * Transition to a new onboarding state
 */
async function transitionState(args: {
  accountId: string;
  from: OnboardingState;
  to: OnboardingState;
  metadata?: Record<string, any>;
}): Promise<void> {
  const { accountId, from, to, metadata } = args;
  const prisma = getPrisma();
  
  await prisma.account.update({
    where: { id: accountId },
    data: {
      onboardingState: to,
      status: to === 'S5_COMPLETED' ? 'ACTIVE' : 'ONBOARDING',
    },
  });
  
  await logAuditEvent({
    accountId,
    event: 'STATE_TRANSITION',
    metadata: {
      from,
      to,
      ...metadata,
    },
  });
  
  console.log(`✅ State transition: ${accountId} ${from} → ${to}`);
}

/**
 * WAPAY_ONBOARDING_OTP=off removes the in-chat OTP step from sign-up
 * (decision note: docs/ONBOARDING.md). The message already arrives from a
 * WhatsApp account Meta verified by SMS, over a webhook WaPay verifies by
 * HMAC, so a code sent back into the SAME chat proves nothing more; the PIN
 * (S3) and consent (S4) steps stay. Default ON (unchanged behaviour) until
 * the founder flips it; accounts already waiting in S2 still verify.
 */
export function onboardingOtpDisabled(): boolean {
  return /^(off|false|0|no|skip)$/i.test(String(process.env.WAPAY_ONBOARDING_OTP || '').trim());
}

/**
 * The PIN-creation prompt (template onboarding_step_3_pin_creation, text
 * fallback), used when S1 goes straight to S3 without an OTP.
 */
async function sendPinCreationPrompt(args: { waId: string; displayName: string }): Promise<void> {
  const { waId, displayName } = args;
  const pinResult = await sendWhatsAppTemplate({
    to: waId,
    templateName: 'onboarding_step_3_pin_creation',
    language: 'en',
    components: [{ type: 'body', parameters: [{ type: 'text', text: displayName }] }],
  });
  if (!pinResult.ok) {
    console.error(`❌ PIN template failed: ${pinResult.error}`);
    await sendWhatsAppText({
      to: waId,
      text: `✅ Welcome, ${displayName}!\n\n🔐 Now create a 4-6 digit PIN:\n\nExample: 1234\n\n⚠️ Don't use 0000 or 1234`,
    });
  }
}

/**
 * S0 → S1: Send welcome template (ONLY send once)
 */
export async function handleS0Initial(args: {
  accountId: string;
  waId: string;
  displayName: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { accountId, waId, displayName } = args;
  
  try {
    console.log(`📝 S0 → S1: Sending welcome template (onboarding_step_1) to ${displayName}`);
    
    // Send welcome template (onboarding_step_1) - STEP 1
    const result = await sendWhatsAppTemplate({
      to: waId,
      templateName: 'onboarding_step_1',
      language: 'en',
      components: [
        {
          type: 'body',
          parameters: [
            {
              type: 'text',
              text: displayName,
            },
          ],
        },
      ],
    });
    
    if (!result.ok) {
      console.error(`❌ Failed to send welcome template: ${result.error}`);
      
      // Fallback to text message ONLY if template fails
      await sendWhatsAppText({
        to: waId,
        text: `👋 Welcome to WaPay, ${displayName}!\n\nLet's get you set up!\n\nClick the button or reply "continue" to start.`,
      });
    } else {
      console.log(`✅ Welcome template sent successfully`);
    }
    
    // Transition to S1 (welcome sent, waiting for user to click button/continue)
    await transitionState({
      accountId,
      from: 'S0_INITIAL',
      to: 'S1_WELCOME_SENT',
    });
    
    return { ok: true };
    
  } catch (error) {
    console.error('❌ Error in S0 → S1:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * S1 → S2: Send OTP
 */
export async function handleS1WelcomeSent(args: {
  accountId: string;
  waId: string;
  msisdn: string;
  displayName: string;
  userMessage: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { accountId, waId, msisdn, displayName, userMessage } = args;
  
  try {
    console.log(`📝 S1 → S2: User responded: "${userMessage}"`);
    
    // Check if user wants to continue (accept any reasonable response)
    const normalized = userMessage.toLowerCase().trim();
    const continueWords = ['continue', 'yes', 'start', 'ok', 'sure', 'proceed', 'open', 'account', 'begin'];
    const wantsToContinue = continueWords.some(word => normalized.includes(word));
    
    if (!wantsToContinue && normalized.length > 0) {
      // User said something else - provide guidance (but don't block them)
      console.log(`⚠️ User message doesn't match continue words, but proceeding anyway: "${userMessage}"`);
    }
    
    if (onboardingOtpDisabled()) {
      console.log(`⏭️ OTP step skipped (WAPAY_ONBOARDING_OTP=off) for ${displayName}`);
      await sendPinCreationPrompt({ waId, displayName });
      await transitionState({
        accountId,
        from: 'S1_WELCOME_SENT',
        to: 'S3_OTP_VERIFIED',
        metadata: { otpSkipped: true },
      });
      return { ok: true };
    }

    // Send OTP via template
    console.log(`📧 Sending OTP via template to ${waId}`);
    const otpResult = await sendOTP({
      accountId,
      msisdn: waId,
      displayName,
    });
    
    if (!otpResult.ok) {
      console.error(`❌ Failed to send OTP: ${otpResult.error}`);
      
      // Send error message based on error type
      if (otpResult.error === 'TOO_MANY_REQUESTS') {
        await sendWhatsAppText({
          to: waId,
          text: `⚠️ Too many OTP requests. Please wait 5 minutes and try again.`,
        });
        return { ok: false, error: otpResult.error };
      }
      
      // For other errors, send generic message but DON'T return error
      // This prevents duplicate error messages
      await sendWhatsAppText({
        to: waId,
        text: `❌ Sorry, there was a problem sending your verification code. Please try again by typing "continue".`,
      });
      return { ok: false, error: otpResult.error };
    }
    
    console.log(`✅ OTP sent successfully (OTP ID: ${otpResult.otpId})`);
    
    // Transition to S2
    await transitionState({
      accountId,
      from: 'S1_WELCOME_SENT',
      to: 'S2_OTP_SENT',
      metadata: {
        otpId: otpResult.otpId,
      },
    });
    
    return { ok: true };
    
  } catch (error) {
    console.error('❌ Error in S1 → S2:', error);
    
    // Send user-friendly error
    await sendWhatsAppText({
      to: waId,
      text: `❌ An error occurred. Please try again by typing "continue".`,
    });
    
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * S2 → S3: Verify OTP
 */
export async function handleS2OtpSent(args: {
  accountId: string;
  waId: string;
  displayName: string;
  userMessage: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { accountId, waId, displayName, userMessage } = args;
  
  try {
    console.log(`📝 S2 → S3: Verifying OTP: ${userMessage.substring(0, 2)}****`);
    
    // Extract OTP code (remove spaces/dashes)
    const code = userMessage.replace(/[\s-]/g, '');
    
    // Validate format
    if (!/^\d{6}$/.test(code)) {
      await sendWhatsAppText({
        to: waId,
        text: `❌ Invalid code format. Please enter the 6-digit code we sent you.\n\nExample: 123456`,
      });
      return { ok: true }; // Don't transition, wait for valid input
    }
    
    // Verify OTP
    const verifyResult = await verifyOTP({
      accountId,
      code,
    });
    
    if (!verifyResult.ok) {
      console.error('❌ OTP verification failed:', verifyResult.error);
      
      await sendWhatsAppText({
        to: waId,
        text: `❌ Invalid or expired code. Please check and try again.\n\nNeed a new code? Reply "resend"`,
      });
      
      return { ok: true }; // Don't transition, wait for valid input
    }
    
    console.log(`✅ OTP verified successfully for ${displayName}`);
    
    // Send PIN creation template (onboarding_step_3_pin_creation)
    console.log(`📤 Sending PIN creation template to ${displayName}`);
    const pinResult = await sendWhatsAppTemplate({
      to: waId,
      templateName: 'onboarding_step_3_pin_creation',
      language: 'en',
      components: [
        {
          type: 'body',
          parameters: [
            {
              type: 'text',
              text: displayName,
            },
          ],
        },
      ],
    });
    
    if (!pinResult.ok) {
      console.error(`❌ PIN template failed: ${pinResult.error}`);
      // Fallback to text ONLY if template fails
      await sendWhatsAppText({
        to: waId,
        text: `✅ Code verified, ${displayName}!\n\n🔐 Now create a 4-6 digit PIN:\n\nExample: 1234\n\n⚠️ Don't use 0000 or 1234`,
      });
    } else {
      console.log(`✅ PIN template sent successfully`);
    }
    
    // Transition to S3
    await transitionState({
      accountId,
      from: 'S2_OTP_SENT',
      to: 'S3_OTP_VERIFIED',
    });
    
    return { ok: true };
    
  } catch (error) {
    console.error('❌ Error in S2 → S3:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * S3 → S4: Set PIN
 */
export async function handleS3OtpVerified(args: {
  accountId: string;
  waId: string;
  displayName: string;
  userMessage: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { accountId, waId, displayName, userMessage } = args;
  
  try {
    console.log(`📝 S3 → S4: Setting PIN`);
    
    // Extract PIN (remove spaces/dashes)
    const pin = userMessage.replace(/[\s-]/g, '');
    
    // Validate PIN format
    const validation = validatePINFormat(pin);
    if (!validation.valid) {
      await sendWhatsAppText({
        to: waId,
        text: `❌ ${validation.error}\n\nPlease try again with a different PIN.`,
      });
      return { ok: true }; // Don't transition, wait for valid input
    }
    
    // Set PIN
    const pinResult = await setPIN({
      accountId,
      pin,
    });
    
    if (!pinResult.ok) {
      console.error('❌ Failed to set PIN:', pinResult.error);
      
      await sendWhatsAppText({
        to: waId,
        text: `❌ Failed to set PIN. Please try again.`,
      });
      
      return { ok: false, error: pinResult.error };
    }
    
    console.log(`✅ PIN set successfully for ${displayName}`);
    
    // Send consent template (consent_terms_ - note the underscore at the end!)
    console.log(`📤 Sending consent template to ${displayName}`);
    const consentResult = await sendWhatsAppTemplate({
      to: waId,
      templateName: 'consent_terms_',  // CORRECT NAME with underscore
      language: 'en',
      components: [
        {
          type: 'body',
          parameters: [
            {
              type: 'text',
              text: displayName,
            },
          ],
        },
      ],
    });
    
    if (!consentResult.ok) {
      console.error(`❌ Consent template failed: ${consentResult.error}`);
      // Fallback to text ONLY if template fails
      await sendWhatsAppText({
        to: waId,
        text: `✅ PIN set!\n\n📋 Almost done, ${displayName}!\n\nAccept our Terms & Privacy Policy.\n\nReply "I accept" to continue.`,
      });
    } else {
      console.log(`✅ Consent template sent successfully`);
    }
    
    // Transition to S4
    await transitionState({
      accountId,
      from: 'S3_OTP_VERIFIED',
      to: 'S4_PIN_SET',
    });
    
    return { ok: true };
    
  } catch (error) {
    console.error('❌ Error in S3 → S4:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * S4 → S5: Record consent and complete onboarding
 */
export async function handleS4PinSet(args: {
  accountId: string;
  waId: string;
  displayName: string;
  userMessage: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { accountId, waId, displayName, userMessage } = args;
  
  try {
    console.log(`📝 S4 → S5: Recording consent`);
    
    // Check if user accepts
    const normalized = userMessage.toLowerCase().trim();
    if (!['accept', 'i accept', 'yes', 'agree', 'ok'].some(word => normalized.includes(word))) {
      await sendWhatsAppText({
        to: waId,
        text: `To continue, please reply "I accept" to accept our Terms & Conditions and Privacy Policy.\n\nYou can review them at: wapay.co.za/terms`,
      });
      return { ok: true }; // Don't transition, wait for acceptance
    }
    
    // Record consents
    await recordConsent({
      accountId,
      consentType: 'TERMS_AND_CONDITIONS',
      granted: true,
      version: 'v1.0',
    });
    
    await recordConsent({
      accountId,
      consentType: 'PRIVACY_POLICY',
      granted: true,
      version: 'v1.0',
    });
    
    console.log(`✅ Consents recorded for ${displayName}`);
    
    // Get user's balance
    const prisma = getPrisma();
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      include: { wallets: true },
    });
    
    const wallet = account?.wallets?.[0];
    const balanceCents = wallet?.availableCents || 0;
    const balance = (balanceCents / 100).toFixed(2);
    
    // Send account activation template (welcome_new_user_account_activation)
    const activationResult = await sendWhatsAppTemplate({
      to: waId,
      templateName: 'welcome_new_user_account_activation',
      language: 'en',
      components: [
        {
          type: 'body',
          parameters: [
            {
              type: 'text',
              text: displayName,
            },
            {
              type: 'text',
              text: balance,
            },
          ],
        },
      ],
    });
    
    if (!activationResult.ok) {
      // Fallback to text
      await sendWhatsAppText({
        to: waId,
        text: `🎉 Welcome to WaPay, ${displayName}!\n\n✅ Your account is now active!\n\n💰 Current Balance: R ${balance}\n\nI'm here to help you:\n• Redeem vouchers\n• Buy airtime & data\n• Send money\n• Check your balance\n\nJust ask me anything! 😊`,
      });
    }
    
    // Transition to S5
    await transitionState({
      accountId,
      from: 'S4_PIN_SET',
      to: 'S5_COMPLETED',
    });
    
    // Log onboarding completion
    await logAuditEvent({
      accountId,
      event: 'ONBOARDING_COMPLETED',
      metadata: {
        displayName,
        balance,
      },
    });
    
    console.log(`🎉 Onboarding completed for ${displayName}`);
    
    return { ok: true };
    
  } catch (error) {
    console.error('❌ Error in S4 → S5:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Handle "resend OTP" request
 */
export async function handleResendOTP(args: {
  accountId: string;
  waId: string;
  displayName: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { accountId, waId, displayName } = args;
  
  console.log(`📧 Resending OTP to ${displayName}`);
  
  const result = await sendOTP({
    accountId,
    msisdn: waId,
    displayName,
  });
  
  if (!result.ok) {
    if (result.error === 'TOO_MANY_REQUESTS') {
      await sendWhatsAppText({
        to: waId,
        text: `⚠️ Too many OTP requests. Please wait 5 minutes and try again.`,
      });
    } else {
      await sendWhatsAppText({
        to: waId,
        text: `❌ Sorry, we couldn't send your verification code. Please try again later.`,
      });
    }
  }
  
  return result;
}

/**
 * Get current onboarding state for account
 */
export async function getOnboardingState(accountId: string): Promise<OnboardingState | null> {
  const prisma = getPrisma();
  
  try {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { onboardingState: true },
    });
    
    return (account?.onboardingState as OnboardingState) || null;
    
  } catch (error) {
    console.error('❌ Error getting onboarding state:', error);
    return null;
  }
}

/**
 * Forgot PIN Flow - Step 1: Initiate reset (send OTP)
 */
export async function initiatePINReset(args: {
  accountId: string;
  waId: string;
  displayName: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { accountId, waId, displayName } = args;
  
  try {
    console.log(`🔐 Initiating PIN reset for ${displayName}`);
    
    // Check if account is locked
    const isLocked = await isPINLocked(accountId);
    
    if (!isLocked) {
      // Account not locked, user should try PIN again
      await sendWhatsAppText({
        to: waId,
        text: `Hi ${displayName}! Your PIN is not locked yet.\n\nIf you've forgotten your PIN, I can help you reset it. Reply "reset PIN" to continue.`,
      });
      return { ok: true };
    }
    
    // Send OTP for verification
    const otpResult = await sendOTP({
      accountId,
      msisdn: waId,
      displayName,
    });
    
    if (!otpResult.ok) {
      console.error('❌ Failed to send OTP for PIN reset:', otpResult.error);
      
      if (otpResult.error === 'TOO_MANY_REQUESTS') {
        await sendWhatsAppText({
          to: waId,
          text: `⚠️ Too many OTP requests. Please wait 5 minutes and try again.`,
        });
      } else {
        await sendWhatsAppText({
          to: waId,
          text: `❌ Sorry, we couldn't send your verification code. Please try again later.`,
        });
      }
      
      return { ok: false, error: otpResult.error };
    }
    
    await sendWhatsAppText({
      to: waId,
      text: `🔐 *PIN Reset*\n\nYour account is locked. To reset your PIN, please enter the 6-digit code we just sent you.`,
    });
    
    // Log audit event
    await logAuditEvent({
      accountId,
      event: 'PIN_RESET_INITIATED',
      metadata: {
        otpId: otpResult.otpId,
      },
    });
    
    return { ok: true };
    
  } catch (error) {
    console.error('❌ Error initiating PIN reset:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Forgot PIN Flow - Step 2: Verify OTP
 */
export async function verifyPINResetOTP(args: {
  accountId: string;
  waId: string;
  displayName: string;
  code: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { accountId, waId, displayName, code } = args;
  
  try {
    console.log(`🔐 Verifying OTP for PIN reset: ${code.substring(0, 2)}****`);
    
    // Verify OTP
    const verifyResult = await verifyOTP({
      accountId,
      code,
    });
    
    if (!verifyResult.ok) {
      console.error('❌ OTP verification failed for PIN reset:', verifyResult.error);
      
      await sendWhatsAppText({
        to: waId,
        text: `❌ Invalid or expired code. Please check and try again.\n\nNeed a new code? Reply "resend"`,
      });
      
      return { ok: false, error: verifyResult.error };
    }
    
    console.log(`✅ OTP verified for PIN reset`);
    
    // Prompt for new PIN
    await sendWhatsAppText({
      to: waId,
      text: `✅ Code verified!\n\n🔐 Now, please create a new 4-6 digit PIN:\n\nExample: 5678\n\n⚠️ Don't use simple patterns like 0000 or 1234`,
    });
    
    return { ok: true };
    
  } catch (error) {
    console.error('❌ Error verifying PIN reset OTP:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Forgot PIN Flow - Step 3: Set new PIN
 */
export async function completePINReset(args: {
  accountId: string;
  waId: string;
  displayName: string;
  newPin: string;
  otpVerified: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const { accountId, waId, displayName, newPin, otpVerified } = args;
  
  try {
    console.log(`🔐 Completing PIN reset for ${displayName}`);
    
    // Validate PIN format
    const validation = validatePINFormat(newPin);
    if (!validation.valid) {
      await sendWhatsAppText({
        to: waId,
        text: `❌ ${validation.error}\n\nPlease try again with a different PIN.`,
      });
      return { ok: true }; // Don't fail, just wait for valid input
    }
    
    // Reset PIN
    const resetResult = await resetPIN({
      accountId,
      newPin,
      otpVerified,
    });
    
    if (!resetResult.ok) {
      console.error('❌ Failed to reset PIN:', resetResult.error);
      
      await sendWhatsAppText({
        to: waId,
        text: `❌ Failed to reset PIN. Please try again or contact support.`,
      });
      
      return { ok: false, error: resetResult.error };
    }
    
    console.log(`✅ PIN reset successfully for ${displayName}`);
    
    // Send success message
    await sendWhatsAppText({
      to: waId,
      text: `✅ *PIN Reset Successful!*\n\nYour new PIN has been set and your account is unlocked.\n\nYou can now use WaPay normally. What would you like to do?\n• Check balance\n• Redeem voucher\n• Buy airtime\n\nJust ask me!`,
    });
    
    return { ok: true };
    
  } catch (error) {
    console.error('❌ Error completing PIN reset:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

