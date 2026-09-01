/**
 * WhatsApp Sending Helper
 * 
 * Simplified interface for sending WhatsApp messages
 */

import { request } from 'undici';
import { resolveLanguage } from './templateCatalog.js';

const WHATSAPP_API_BASE = 'https://graph.facebook.com/v21.0';

export interface SendTemplateArgs {
  to: string;
  templateName: string;
  language?: string;
  components?: Array<{
    type: 'header' | 'body' | 'button';
    parameters: Array<{
      type: 'text' | 'currency' | 'date_time';
      text?: string;
      currency?: { fallback_value: string; code: string; amount_1000: number };
      date_time?: { fallback_value: string };
    }>;
  }>;
}

export interface SendTextArgs {
  to: string;
  text: string;
  /** Meta Direct Send (beta, Sept 2026): top-level category on /messages. */
  category?: 'utility';
}

/**
 * True when this deploy has opted into Meta's Direct Send beta
 * (WHATSAPP_DIRECT_SEND=true — set only after the WABA is enabled and the
 * beta terms are accepted in WhatsApp Manager).
 */
export function directSendEnabled(): boolean {
  return process.env.WHATSAPP_DIRECT_SEND === 'true';
}

/**
 * Direct Send: a business-initiated UTILITY message outside the 24h window
 * with NO template — the ordinary text payload plus `category: "utility"`.
 * TRANSACTIONAL CONTENT ONLY: Meta warns, then revokes Direct Send access,
 * for marketing sent this way. Gate call sites with directSendEnabled().
 */
export async function sendWhatsAppUtilityDirect(args: { to: string; text: string }): Promise<{
  ok: boolean;
  messageId?: string;
  error?: string;
}> {
  return sendWhatsAppText({ ...args, category: 'utility' });
}

export interface SendCtaUrlArgs {
  to: string;
  bodyText: string;
  buttonText: string;
  url: string;
  headerText?: string;
  footerText?: string;
}

// Meta's documented limits for interactive cta_url messages. Exceeding them
// fails the send at the API, so they are enforced before the request.
const CTA_BUTTON_MAX = 20;
const CTA_BODY_MAX = 1024;
const CTA_HEADER_MAX = 60;
const CTA_FOOTER_MAX = 60;

/**
 * Build the Cloud API payload for an interactive CTA-URL message — body copy
 * plus one tappable button that opens a link. Pure and exported so tests can
 * lock the wire shape without a network call.
 */
export function buildCtaUrlPayload(args: SendCtaUrlArgs): Record<string, any> {
  const { to, bodyText, buttonText, url, headerText, footerText } = args;
  if (!to) throw new Error('to is required');
  if (!bodyText) throw new Error('bodyText is required');
  if (!buttonText) throw new Error('buttonText is required');
  if (!/^https:\/\//.test(url || '')) throw new Error('url must be https');
  if (buttonText.length > CTA_BUTTON_MAX) {
    throw new Error(`buttonText exceeds ${CTA_BUTTON_MAX} chars: "${buttonText}"`);
  }
  if (bodyText.length > CTA_BODY_MAX) throw new Error(`bodyText exceeds ${CTA_BODY_MAX} chars`);
  if (headerText && headerText.length > CTA_HEADER_MAX) {
    throw new Error(`headerText exceeds ${CTA_HEADER_MAX} chars`);
  }
  if (footerText && footerText.length > CTA_FOOTER_MAX) {
    throw new Error(`footerText exceeds ${CTA_FOOTER_MAX} chars`);
  }

  return {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      ...(headerText ? { header: { type: 'text', text: headerText } } : {}),
      body: { text: bodyText },
      ...(footerText ? { footer: { text: footerText } } : {}),
      action: {
        name: 'cta_url',
        parameters: {
          display_text: buttonText,
          url,
        },
      },
    },
  };
}

/**
 * Send WhatsApp template message
 */
export async function sendWhatsAppTemplate(args: SendTemplateArgs): Promise<{
  ok: boolean;
  data?: any;
  error?: string;
}> {
  const { to, templateName, language, components } = args;
  
  try {
    const accessToken = process.env.META_WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
    
    if (!accessToken || !phoneNumberId) {
      throw new Error('META_WHATSAPP_TOKEN or META_WHATSAPP_PHONE_NUMBER_ID not set');
    }
    
    // Resolve language from catalog
    const resolvedLanguage = resolveLanguage(templateName, language) || 'en_US';
    
    const url = `${WHATSAPP_API_BASE}/${phoneNumberId}/messages`;
    
    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: {
          code: resolvedLanguage,
        },
        components: components || [],
      },
    };
    
    console.log(`📤 Sending WhatsApp template: ${templateName} (${resolvedLanguage}) to ${to}`);
    
    const { statusCode, body } = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });
    
    const data = await body.json() as any;
    
    if (statusCode >= 400) {
      console.error('❌ WhatsApp template send failed:', data);
      return {
        ok: false,
        error: data.error?.message || 'Unknown error',
      };
    }
    
    console.log(`✅ WhatsApp template sent: ${data.messages?.[0]?.id}`);
    
    return {
      ok: true,
      data,
    };
    
  } catch (error) {
    console.error('❌ Error sending WhatsApp template:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Send a WhatsApp interactive CTA-URL message: body copy + one tappable
 * button that opens a link. A free-form (session) message — deliverable only
 * inside the 24h customer-service window, which always holds when replying
 * to a message the customer just sent.
 */
export async function sendWhatsAppCtaUrl(args: SendCtaUrlArgs): Promise<{
  ok: boolean;
  data?: any;
  error?: string;
}> {
  try {
    const accessToken = process.env.META_WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;

    if (!accessToken || !phoneNumberId) {
      throw new Error('META_WHATSAPP_TOKEN or META_WHATSAPP_PHONE_NUMBER_ID not set');
    }

    const payload = buildCtaUrlPayload(args);
    const url = `${WHATSAPP_API_BASE}/${phoneNumberId}/messages`;

    console.log(`📤 Sending WhatsApp CTA-URL message to ${args.to}`);

    const { statusCode, body } = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await body.json() as any;

    if (statusCode >= 400) {
      console.error('❌ WhatsApp CTA-URL send failed:', data);
      return {
        ok: false,
        error: data.error?.message || 'Unknown error',
      };
    }

    console.log(`✅ WhatsApp CTA-URL sent: ${data.messages?.[0]?.id}`);

    return {
      ok: true,
      data,
    };

  } catch (error) {
    console.error('❌ Error sending WhatsApp CTA-URL:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Send WhatsApp text message
 */
export async function sendWhatsAppText(args: SendTextArgs): Promise<{
  ok: boolean;
  data?: any;
  error?: string;
}> {
  const { to, text } = args;
  
  try {
    const accessToken = process.env.META_WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
    
    if (!accessToken || !phoneNumberId) {
      throw new Error('META_WHATSAPP_TOKEN or META_WHATSAPP_PHONE_NUMBER_ID not set');
    }
    
    const url = `${WHATSAPP_API_BASE}/${phoneNumberId}/messages`;
    
    const payload: Record<string, any> = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: {
        body: text,
      },
    };
    if (args.category) payload.category = args.category;
    
    console.log(`📤 Sending WhatsApp text to ${to}`);
    
    const { statusCode, body } = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });
    
    const data = await body.json() as any;
    
    if (statusCode >= 400) {
      console.error('❌ WhatsApp text send failed:', data);
      return {
        ok: false,
        error: data.error?.message || 'Unknown error',
      };
    }
    
    console.log(`✅ WhatsApp text sent: ${data.messages?.[0]?.id}`);
    
    return {
      ok: true,
      data,
    };
    
  } catch (error) {
    console.error('❌ Error sending WhatsApp text:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

