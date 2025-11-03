/**
 * Admin endpoint to list all WhatsApp Business Accounts
 * 
 * GET /api/admin/list-wabas
 */

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!accessToken) {
    return res.status(500).json({ ok: false, error: 'Missing access token' });
  }

  try {
    console.log('📋 Fetching all WhatsApp Business Accounts...');
    
    // Get the business from the token
    const meUrl = 'https://graph.facebook.com/v21.0/me?fields=id,name';
    const meRes = await fetch(meUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    
    const meData = await meRes.json();
    console.log('👤 User/App:', meData);

    // Try to get WABAs
    const wabaUrl = 'https://graph.facebook.com/v21.0/me/client_whatsapp_business_accounts';
    const wabaRes = await fetch(wabaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const wabaData = await wabaRes.json();
    console.log('📱 WABAs:', wabaData);

    return res.status(200).json({ 
      ok: true, 
      user: meData,
      wabas: wabaData.data || []
    });
    
  } catch (error) {
    console.error('❌ Failed to list WABAs:', error);
    
    return res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
}

