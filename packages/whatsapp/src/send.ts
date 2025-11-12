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
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    
    if (!accessToken || !phoneNumberId) {
      throw new Error('WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID not set');
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
 * Send WhatsApp text message
 */
export async function sendWhatsAppText(args: SendTextArgs): Promise<{
  ok: boolean;
  data?: any;
  error?: string;
}> {
  const { to, text } = args;
  
  try {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    
    if (!accessToken || !phoneNumberId) {
      throw new Error('WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID not set');
    }
    
    const url = `${WHATSAPP_API_BASE}/${phoneNumberId}/messages`;
    
    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: {
        body: text,
      },
    };
    
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

