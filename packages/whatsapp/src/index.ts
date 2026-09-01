import { request, Dispatcher } from 'undici';

// Export template seeding and catalog functions
export { seedWhatsappTemplates } from './seedTemplates.js';
export { buildCatalog, resolveLanguage, isApproved, getAvailableTemplates, getAvailableLanguages } from './templateCatalog.js';
export { sendWhatsAppTemplate, sendWhatsAppText, sendWhatsAppCtaUrl, buildCtaUrlPayload, sendWhatsAppUtilityDirect, directSendEnabled } from './send.js';
export type { SendTemplateArgs, SendTextArgs, SendCtaUrlArgs } from './send.js';

export type TemplateName =
  | 'redeem_in_progress'
  | 'deposit_receipt'
  | 'deposit_failed'
  | 'topup_collect_number'
  | 'airtime_select_amount'
  | 'airtime_preview_confirm'
  | 'airtime_receipt'
  | 'data_select_bundle'
  | 'data_preview_confirm'
  | 'data_receipt';

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  baseUrl?: string;
}

export interface TemplateComponent {
  type: 'header' | 'body' | 'button';
  parameters: Array<{
    type: 'text' | 'currency' | 'date_time';
    text?: string;
    currency?: { fallback_value: string; code: string; amount_1000: number };
    date_time?: { fallback_value: string };
  }>;
}

export interface SendTemplateParams {
  to: string;
  templateName: TemplateName;
  languageCode?: string;
  components?: TemplateComponent[];
}

export interface SendTextParams {
  to: string;
  text: string;
}

export class WhatsAppClient {
  private config: WhatsAppConfig;

  constructor(config: WhatsAppConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl || 'https://graph.facebook.com/v18.0',
    };
  }

  /**
   * Send a WhatsApp template message
   */
  async sendTemplate(params: SendTemplateParams): Promise<{ messageId: string }> {
    const url = `${this.config.baseUrl}/${this.config.phoneNumberId}/messages`;
    
    const payload = {
      messaging_product: 'whatsapp',
      to: params.to,
      type: 'template',
      template: {
        name: params.templateName,
        language: {
          code: params.languageCode || 'en',
        },
        components: params.components || [],
      },
    };

    const { statusCode, body } = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await body.json() as any;

    if (statusCode >= 400) {
      throw new Error(`WhatsApp API error: ${JSON.stringify(data)}`);
    }

    return { messageId: data.messages[0].id };
  }

  /**
   * Send a simple text message (for testing/fallback)
   */
  async sendText(params: SendTextParams): Promise<{ messageId: string }> {
    const url = `${this.config.baseUrl}/${this.config.phoneNumberId}/messages`;
    
    const payload = {
      messaging_product: 'whatsapp',
      to: params.to,
      type: 'text',
      text: {
        body: params.text,
      },
    };

    const { statusCode, body } = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await body.json() as any;

    if (statusCode >= 400) {
      throw new Error(`WhatsApp API error: ${JSON.stringify(data)}`);
    }

    return { messageId: data.messages[0].id };
  }
}

/**
 * Helper to format currency for WhatsApp templates
 */
export function formatCurrencyCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Template message builders for common WaPay flows
 */
export const Templates = {
  /**
   * Notify user that voucher redemption is in progress
   */
  redeemInProgress(to: string): SendTemplateParams {
    return {
      to,
      templateName: 'redeem_in_progress',
      languageCode: 'en',
    };
  },

  /**
   * Send deposit receipt with amount and reference
   */
  depositReceipt(to: string, amountCents: number, reference: string): SendTemplateParams {
    return {
      to,
      templateName: 'deposit_receipt',
      languageCode: 'en',
      components: [
        {
          type: 'body',
          parameters: [
            {
              type: 'currency',
              currency: {
                fallback_value: `R${formatCurrencyCents(amountCents)}`,
                code: 'ZAR',
                amount_1000: amountCents * 10, // WhatsApp expects amount in 1/1000 of currency unit
              },
            },
            {
              type: 'text',
              text: reference,
            },
          ],
        },
      ],
    };
  },

  /**
   * Notify user that deposit failed
   */
  depositFailed(to: string, reason: string): SendTemplateParams {
    return {
      to,
      templateName: 'deposit_failed',
      languageCode: 'en',
      components: [
        {
          type: 'body',
          parameters: [
            {
              type: 'text',
              text: reason,
            },
          ],
        },
      ],
    };
  },

  /**
   * Request phone number for airtime/data top-up
   */
  topupCollectNumber(to: string): SendTemplateParams {
    return {
      to,
      templateName: 'topup_collect_number',
      languageCode: 'en',
    };
  },

  /**
   * Airtime purchase receipt
   */
  airtimeReceipt(to: string, amountCents: number, msisdn: string, network: string): SendTemplateParams {
    return {
      to,
      templateName: 'airtime_receipt',
      languageCode: 'en',
      components: [
        {
          type: 'body',
          parameters: [
            {
              type: 'currency',
              currency: {
                fallback_value: `R${formatCurrencyCents(amountCents)}`,
                code: 'ZAR',
                amount_1000: amountCents * 10,
              },
            },
            {
              type: 'text',
              text: msisdn,
            },
            {
              type: 'text',
              text: network,
            },
          ],
        },
      ],
    };
  },

  /**
   * Data bundle purchase receipt
   */
  dataReceipt(to: string, bundleLabel: string, msisdn: string, network: string): SendTemplateParams {
    return {
      to,
      templateName: 'data_receipt',
      languageCode: 'en',
      components: [
        {
          type: 'body',
          parameters: [
            {
              type: 'text',
              text: bundleLabel,
            },
            {
              type: 'text',
              text: msisdn,
            },
            {
              type: 'text',
              text: network,
            },
          ],
        },
      ],
    };
  },
}


