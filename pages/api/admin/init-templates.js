/**
 * Admin endpoint to initialize/refresh WhatsApp templates
 * 
 * GET /api/admin/init-templates
 */

import { initializeTemplates } from '../../../lib/initTemplates';
import { requireInternalAuth } from '../../../lib/internal-auth.js';

export default async function handler(req, res) {
  // Internal key (review 2026-11-13): this seeded templates from Meta on the production token for any caller.
  if (!requireInternalAuth(req, res)) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    console.log('🔄 Template initialization requested...');
    
    await initializeTemplates();
    
    return res.status(200).json({ 
      ok: true, 
      message: 'Templates initialized successfully' 
    });
    
  } catch (error) {
    console.error('❌ Template initialization failed:', error);
    
    return res.status(500).json({ ok: false, error: 'INIT_FAILED' });
  }
}

