/**
 * Initialize WhatsApp Templates
 * 
 * Seeds templates from Meta API and builds in-memory catalog
 * Call this on app startup
 */

import { seedWhatsappTemplates, buildCatalog, getAvailableTemplates } from '@wapay/whatsapp';

let READY = false;
let WABA_ID = null;

export function isReady() {
  return READY;
}

export function assertReady() {
  if (!READY) {
    throw new Error('WhatsApp catalog not ready. Templates are still being seeded.');
  }
}

export async function initializeTemplates() {
  if (READY) {
    console.log('ℹ️  Templates already initialized');
    return { ready: true, wabaId: WABA_ID };
  }

  const accessToken = process.env.META_WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!accessToken) {
    console.error('❌ Missing META_WHATSAPP_TOKEN or WHATSAPP_ACCESS_TOKEN');
    throw new Error('WhatsApp configuration incomplete');
  }

  if (!phoneNumberId) {
    console.error('❌ Missing META_WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_PHONE_NUMBER_ID');
    throw new Error('WhatsApp configuration incomplete');
  }

  try {
    console.log('🚀 Initializing WhatsApp templates...');
    console.log(`📱 Phone Number ID: ${phoneNumberId}`);
    
    // Seed templates from Meta API (auto-derives WABA from phone number)
    const result = await seedWhatsappTemplates({ accessToken, phoneNumberId });
    WABA_ID = result.wabaId;
    
    console.log(`✅ Resolved WABA ID: ${WABA_ID}`);
    console.log(`📊 Seeded ${result.count} templates`);
    
    // Build in-memory catalog
    await buildCatalog(WABA_ID);
    
    // Log catalog state for debugging
    const templates = getAvailableTemplates();
    console.log('📋 WA READY:', {
      phone_number_id: phoneNumberId,
      waba_id_seeded: WABA_ID,
      templates_count: templates.length,
      templates: templates,
    });
    
    READY = true;
    console.log('✅ WhatsApp templates initialized successfully');
    
    return { ready: true, wabaId: WABA_ID, count: result.count };
    
  } catch (error) {
    console.error('❌ Failed to initialize templates:', error);
    READY = false;
    throw error;
  }
}

// Auto-refresh templates every 30 minutes
export function startTemplateRefresh() {
  const REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes
  
  setInterval(async () => {
    try {
      console.log('🔄 Refreshing WhatsApp templates...');
      const accessToken = process.env.META_WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
      const phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
      
      const result = await seedWhatsappTemplates({ accessToken, phoneNumberId });
      await buildCatalog(result.wabaId);
      
      console.log('✅ Templates refreshed');
    } catch (error) {
      console.error('❌ Template refresh failed:', error);
    }
  }, REFRESH_INTERVAL);
}

