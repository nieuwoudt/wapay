/**
 * Admin endpoint to initialize/refresh WhatsApp templates
 * 
 * GET /api/admin/init-templates
 */

import { initializeTemplates } from '../../../lib/initTemplates';

export default async function handler(req, res) {
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
    
    return res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
}

