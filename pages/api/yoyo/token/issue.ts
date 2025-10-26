import type { NextApiRequest, NextApiResponse } from 'next';
import { YoyoClient } from '@wapay/providers-yoyo';
import { env } from '@wapay/utils';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  try {
    if (!env.FEATURE_ENABLE_YOYO) {
      return res.status(403).json({ 
        ok: false, 
        message: 'Yoyo integration is not enabled.' 
      });
    }

    // This is a simplified stub. Real token issuance would involve user context and specific gift card IDs.
    const yoyoClient = new YoyoClient();
    const accountId = req.body?.accountId || 'test-user-ref-123';
    
    const tokenResult = await yoyoClient.issueTokenForGift({ accountId });

    return res.status(200).json({ 
      ok: true, 
      token: tokenResult
    });

  } catch (error: any) {
    console.error('Yoyo token issuance failed:', error);
    return res.status(500).json({ 
      ok: false, 
      message: error.message 
    });
  }
}

