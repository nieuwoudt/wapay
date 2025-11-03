/**
 * WhatsApp Message Processor
 * 
 * Processes incoming WhatsApp messages and sends appropriate template responses
 */

import { getOrCreateUser, updateOnboardingStatus, getUserBalance } from './user-manager';

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
async function sendTemplateMessage({ to, templateName, languageCode = 'en', components = [] }) {
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
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components,
    },
  };

  try {
    console.log('📤 Sending template:', { to, templateName, components });

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
 * Simple NLP intent detection (rule-based)
 */
function detectIntent(text) {
  const normalized = text.toLowerCase().trim();

  // Balance check
  if (/\b(balance|wallet|money|how much)\b/i.test(normalized)) {
    return { intent: 'CHECK_BALANCE', confidence: 0.9 };
  }

  // Help
  if (/\b(help|menu|what can|commands)\b/i.test(normalized)) {
    return { intent: 'HELP', confidence: 0.9 };
  }

  // Airtime
  if (/\b(airtime|recharge|top\s*up)\b/i.test(normalized)) {
    return { intent: 'BUY_AIRTIME', confidence: 0.9 };
  }

  // Data
  if (/\b(data|bundle|gb|mb)\b/i.test(normalized)) {
    return { intent: 'BUY_DATA', confidence: 0.9 };
  }

  // Voucher
  if (/\b(voucher|redeem|deposit)\b/i.test(normalized)) {
    return { intent: 'REDEEM_VOUCHER', confidence: 0.9 };
  }

  return { intent: 'UNKNOWN', confidence: 0.0 };
}

/**
 * Process incoming WhatsApp message
 */
export async function processMessage({ from, text, messageId, profile }) {
  console.log('🔄 Processing message:', { from, text });

  // Get or create user
  const { account, isNewUser } = await getOrCreateUser(from, profile);
  
  // Log if new user (but don't send welcome yet, just process their message)
  if (isNewUser) {
    console.log('👋 New user detected, account created');
    await updateOnboardingStatus(account.id, 'ONBOARDING_STARTED');
  }

  // Detect intent for all users
  const { intent, confidence } = detectIntent(text);
  console.log('🎯 Detected intent:', { intent, confidence });

  try {
    switch (intent) {
      case 'CHECK_BALANCE':
        // Get user's actual balance
        const { balance, displayName } = await getUserBalance(from);
        
        // Send text message with balance
        return await sendTextMessage({
          to: from,
          text: `💰 *Your WaPay Balance*\n\nHi ${displayName}!\nYour current balance is R ${balance}\n\nWhat would you like to do?\n• Buy airtime\n• Buy data\n• Redeem voucher\n• Send money\n\nReply with your choice or type "help" for more options.`,
        });

      case 'HELP':
        // Send help text message
        return await sendTextMessage({
          to: from,
          text: `📋 *WaPay Help Menu*\n\nHere's what I can help you with:\n\n💰 *Balance*\n"What's my balance?"\n\n📱 *Airtime*\n"Buy R50 airtime"\n\n📶 *Data*\n"Buy 1GB data"\n\n🎟️ *Voucher*\n"Redeem voucher"\n\nJust ask me in your own words! I understand natural language.`,
        });

      case 'BUY_AIRTIME':
        // Send airtime options
        return await sendTextMessage({
          to: from,
          text: `📱 *Buy Airtime*\n\nHow much airtime would you like?\n\nJust tell me the amount, like:\n• "R10"\n• "R20"\n• "R50"\n• "R100"\n\nOr specify the number:\n"R50 airtime for 082 123 4567"`,
        });

      case 'BUY_DATA':
        // Send data options
        return await sendTextMessage({
          to: from,
          text: `📶 *Buy Data*\n\nTell me what you need:\n\n• "1GB daily"\n• "500MB weekly"\n• "2GB monthly"\n\nOr specify the number:\n"1GB for 082 123 4567"`,
        });

      case 'REDEEM_VOUCHER':
        // Send voucher instructions
        return await sendTextMessage({
          to: from,
          text: `🎟️ *Redeem Voucher*\n\nPlease enter your 16-digit Blu Voucher PIN:\n\nExample: 1234-5678-9012-3456\n\nYour voucher value will be added to your WaPay balance instantly!`,
        });

      default:
        // Send help for unknown intents
        return await sendTextMessage({
          to: from,
          text: `👋 Hi there!\n\nI didn't quite understand that. Here's what I can help you with:\n\n💰 Check balance\n📱 Buy airtime\n📶 Buy data\n🎟️ Redeem voucher\n\nType "help" to see more options!`,
        });
    }
  } catch (error) {
    console.error('❌ Error processing message:', error);
    return { ok: false, error: error.message };
  }
}

