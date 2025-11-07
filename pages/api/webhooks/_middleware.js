/**
 * Middleware to ensure templates are initialized before processing webhooks
 */
import { initializeTemplates } from '../../../lib/initTemplates';

let initPromise = null;

export async function ensureTemplatesReady() {
  // Only initialize once
  if (!initPromise) {
    console.log('🔄 Starting template initialization...');
    initPromise = initializeTemplates().catch(err => {
      console.error('❌ Template initialization failed:', err);
      initPromise = null; // Reset so we can retry
      throw err;
    });
  }
  
  return initPromise;
}

