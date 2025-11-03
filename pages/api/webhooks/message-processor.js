/**
 * WhatsApp Message Processor
 * 
 * Processes incoming WhatsApp messages and sends appropriate template responses
 */

/**
 * Send WhatsApp template message
 */
async function sendTemplateMessage({ to, templateName, languageCode = 'en_US', components = [] }) {
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
export async function processMessage({ from, text, messageId }) {
  console.log('🔄 Processing message:', { from, text });

  // Detect intent
  const { intent, confidence } = detectIntent(text);
  console.log('🎯 Detected intent:', { intent, confidence });

  try {
    switch (intent) {
      case 'CHECK_BALANCE':
        // Send balance_summary template
        return await sendTemplateMessage({
          to: from,
          templateName: 'balance_summary',
          components: [
            {
              type: 'header',
              parameters: [
                {
                  type: 'text',
                  text: 'Balance Enquiry',
                },
              ],
            },
            {
              type: 'body',
              parameters: [
                {
                  type: 'text',
                  text: 'Nieuwoudt', // TODO: Get from user profile
                },
                {
                  type: 'text',
                  text: 'R 0.00', // TODO: Get from balance API
                },
              ],
            },
          ],
        });

      case 'HELP':
        // Send help_me_menu template
        return await sendTemplateMessage({
          to: from,
          templateName: 'help_me_menu',
          components: [
            {
              type: 'header',
              parameters: [
                {
                  type: 'text',
                  text: 'Help Menu',
                },
              ],
            },
            {
              type: 'body',
              parameters: [
                {
                  type: 'text',
                  text: 'Nieuwoudt', // TODO: Get from user profile
                },
              ],
            },
          ],
        });

      case 'BUY_AIRTIME':
        // Send airtime_select_amount template
        return await sendTemplateMessage({
          to: from,
          templateName: 'airtime_select_amount',
          components: [],
        });

      case 'BUY_DATA':
        // Send data_select_bundle template
        return await sendTemplateMessage({
          to: from,
          templateName: 'data_select_bundle',
          components: [],
        });

      case 'REDEEM_VOUCHER':
        // Send bluvoucher_redeem_pro template
        return await sendTemplateMessage({
          to: from,
          templateName: 'bluvoucher_redeem_pro',
          components: [],
        });

      default:
        // Send help menu for unknown intents
        return await sendTemplateMessage({
          to: from,
          templateName: 'help_me_menu',
          components: [
            {
              type: 'header',
              parameters: [
                {
                  type: 'text',
                  text: 'Help Menu',
                },
              ],
            },
            {
              type: 'body',
              parameters: [
                {
                  type: 'text',
                  text: 'Friend', // TODO: Get from user profile
                },
              ],
            },
          ],
        });
    }
  } catch (error) {
    console.error('❌ Error processing message:', error);
    return { ok: false, error: error.message };
  }
}

