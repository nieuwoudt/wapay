/**
 * Initialize WhatsApp Templates
 * 
 * Seeds templates from Meta API and builds in-memory catalog
 * Call this on app startup
 */

const { seedWhatsappTemplates, buildCatalog } = require('@wapay/whatsapp');

let initialized = false;

export async function initializeTemplates() {
  if (initialized) {
    console.log('ℹ️  Templates already initialized');
    return;
  }

  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!wabaId || !accessToken) {
    console.error('❌ Missing WHATSAPP_BUSINESS_ACCOUNT_ID or WHATSAPP_ACCESS_TOKEN');
    throw new Error('WhatsApp configuration incomplete');
  }

  try {
    console.log('🚀 Initializing WhatsApp templates...');
    
    // Seed templates from Meta API
    await seedWhatsappTemplates({ wabaId, accessToken });
    
    // Build in-memory catalog
    await buildCatalog(wabaId);
    
    initialized = true;
    console.log('✅ WhatsApp templates initialized successfully');
    
  } catch (error) {
    console.error('❌ Failed to initialize templates:', error);
    throw error;
  }
}

// Auto-refresh templates every 30 minutes
export function startTemplateRefresh() {
  const REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes
  
  setInterval(async () => {
    try {
      console.log('🔄 Refreshing WhatsApp templates...');
      const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
      const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
      
      await seedWhatsappTemplates({ wabaId, accessToken });
      await buildCatalog(wabaId);
      
      console.log('✅ Templates refreshed');
    } catch (error) {
      console.error('❌ Template refresh failed:', error);
    }
  }, REFRESH_INTERVAL);
}

