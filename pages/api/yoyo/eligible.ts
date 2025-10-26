import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

const eligibleQuerySchema = z.object({
  retailer: z.string(),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const parse = eligibleQuerySchema.safeParse(req.query);
    if (!parse.success) {
      return res.status(400).json({ 
        ok: false, 
        error: 'INVALID_QUERY', 
        details: parse.error.errors 
      });
    }

    const { retailer } = parse.data;

    // This is a stub. In a real scenario, you'd check a list of supported retailers.
    const supportedRetailers = ['checkers', 'pick n pay', 'shoprite', 'spar'];
    const supported = supportedRetailers.includes(retailer.toLowerCase());

    return res.status(200).json({ 
      ok: true, 
      supported, 
      retailer 
    });

  } catch (error: any) {
    console.error('Error in yoyo/eligible:', error);
    return res.status(500).json({ 
      ok: false, 
      error: 'INTERNAL_ERROR',
      message: error.message 
    });
  }
}

