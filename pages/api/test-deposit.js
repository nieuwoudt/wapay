/**
 * Simple test endpoint for deposit flow
 * This is a stub that simulates the deposit flow without dependencies
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const { pin, accountId, waId } = req.body;
    const idemKey = req.headers['x-idempotency-key'];

    if (!idemKey) {
      return res.status(400).json({ ok: false, error: 'MISSING_IDEMPOTENCY' });
    }

    if (!pin) {
      return res.status(400).json({ ok: false, error: 'MISSING_PIN' });
    }

    // Simulate successful deposit
    const mockResponse = {
      ok: true,
      reference: `BLU-${Date.now()}`,
      amount_cents: 10000, // R100
      accountId: accountId || 'test-account',
      message: 'Deposit successful (STUB - no real processing)',
      timestamp: new Date().toISOString(),
    };

    return res.status(200).json(mockResponse);

  } catch (error) {
    console.error('Error in test-deposit:', error);
    return res.status(500).json({ 
      ok: false, 
      error: 'INTERNAL_ERROR',
      message: error.message 
    });
  }
}

