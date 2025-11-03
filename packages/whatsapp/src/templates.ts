/**
 * WhatsApp Template Message Helpers
 * 
 * All templates are approved and active in Meta Business Manager
 */

export interface TemplateParameter {
  type: 'text';
  text: string;
}

export interface TemplateMessage {
  messaging_product: 'whatsapp';
  to: string;
  type: 'template';
  template: {
    name: string;
    language: {
      code: string;
    };
    components?: Array<{
      type: 'header' | 'body' | 'button';
      parameters?: TemplateParameter[];
    }>;
  };
}

/**
 * Send balance_summary template
 * 
 * Template: balance_summary
 * Header: Your Balance
 * Body: Hi {{1}}, your WaPay balance is R {{2}}. What would you like to do?
 * Variables: name, balance
 */
export function balanceSummaryTemplate(
  waId: string,
  name: string,
  balanceAmount: string
): TemplateMessage {
  return {
    messaging_product: 'whatsapp',
    to: waId,
    type: 'template',
    template: {
      name: 'balance_summary',
      language: {
        code: 'en',
      },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: name },
            { type: 'text', text: balanceAmount },
          ],
        },
      ],
    },
  };
}

/**
 * Send help_me_menu template
 * 
 * Template: help_me_menu
 * Header: How Can I Help?
 * Body: Hi {{1}}. Here's what I can help you with...
 * Variables: name
 */
export function helpMenuTemplate(
  waId: string,
  name: string
): TemplateMessage {
  return {
    messaging_product: 'whatsapp',
    to: waId,
    type: 'template',
    template: {
      name: 'help_me_menu',
      language: {
        code: 'en',
      },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: name },
          ],
        },
      ],
    },
  };
}

/**
 * Send airtime_preview_confirm template
 * 
 * Template: airtime_preview_confirm
 * Body: Buy airtime for: R {{1}}. Reply YES to confirm.
 * Variables: amount
 */
export function airtimePreviewTemplate(
  waId: string,
  amount: string
): TemplateMessage {
  return {
    messaging_product: 'whatsapp',
    to: waId,
    type: 'template',
    template: {
      name: 'airtime_preview_confirm',
      language: {
        code: 'en',
      },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: amount },
          ],
        },
      ],
    },
  };
}

/**
 * Send airtime_receipt template
 * 
 * Template: airtime_receipt
 * Body: Airtime purchase successful...
 */
export function airtimeReceiptTemplate(
  waId: string,
  // Add parameters based on your actual template
): TemplateMessage {
  return {
    messaging_product: 'whatsapp',
    to: waId,
    type: 'template',
    template: {
      name: 'airtime_receipt',
      language: {
        code: 'en',
      },
    },
  };
}

/**
 * Send data_preview_confirm template
 * 
 * Template: data_preview_confirm
 * Body: Buy bundle: {{1}}. Price: R {{2}}. Reply YES to confirm.
 */
export function dataPreviewTemplate(
  waId: string,
  bundleName: string,
  price: string
): TemplateMessage {
  return {
    messaging_product: 'whatsapp',
    to: waId,
    type: 'template',
    template: {
      name: 'data_preview_confirm',
      language: {
        code: 'en',
      },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: bundleName },
            { type: 'text', text: price },
          ],
        },
      ],
    },
  };
}

/**
 * Send data_receipt template
 */
export function dataReceiptTemplate(
  waId: string,
  // Add parameters based on your actual template
): TemplateMessage {
  return {
    messaging_product: 'whatsapp',
    to: waId,
    type: 'template',
    template: {
      name: 'data_receipt',
      language: {
        code: 'en',
      },
    },
  };
}

/**
 * Send bluvoucher_redeem_success template
 */
export function voucherSuccessTemplate(
  waId: string,
  // Add parameters based on your actual template
): TemplateMessage {
  return {
    messaging_product: 'whatsapp',
    to: waId,
    type: 'template',
    template: {
      name: 'bluvoucher_redeem_success',
      language: {
        code: 'en',
      },
    },
  };
}

/**
 * Send redeem_in_progress template
 */
export function redeemInProgressTemplate(
  waId: string
): TemplateMessage {
  return {
    messaging_product: 'whatsapp',
    to: waId,
    type: 'template',
    template: {
      name: 'redeem_in_progress',
      language: {
        code: 'en',
      },
    },
  };
}

/**
 * Send deposit_failed template
 */
export function depositFailedTemplate(
  waId: string,
  // Add parameters based on your actual template
): TemplateMessage {
  return {
    messaging_product: 'whatsapp',
    to: waId,
    type: 'template',
    template: {
      name: 'deposit_failed',
      language: {
        code: 'en',
      },
    },
  };
}

/**
 * Generic template sender
 * 
 * @param waId - WhatsApp ID (phone number)
 * @param templateName - Name of the template
 * @param parameters - Array of parameter values
 */
export function sendTemplate(
  waId: string,
  templateName: string,
  parameters: string[] = []
): TemplateMessage {
  const message: TemplateMessage = {
    messaging_product: 'whatsapp',
    to: waId,
    type: 'template',
    template: {
      name: templateName,
      language: {
        code: 'en',
      },
    },
  };

  if (parameters.length > 0) {
    message.template.components = [
      {
        type: 'body',
        parameters: parameters.map((text) => ({ type: 'text', text })),
      },
    ];
  }

  return message;
}

/**
 * Send template via Meta WhatsApp API
 * 
 * @param template - Template message object
 * @param accessToken - Meta access token
 * @param phoneNumberId - Meta phone number ID
 */
export async function sendWhatsAppTemplate(
  template: TemplateMessage,
  accessToken: string,
  phoneNumberId: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(template),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        success: false,
        error: data.error?.message || 'Failed to send template',
      };
    }

    return {
      success: true,
      messageId: data.messages?.[0]?.id,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Network error',
    };
  }
}

