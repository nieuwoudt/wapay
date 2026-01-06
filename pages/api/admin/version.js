/**
 * GET /api/admin/version
 * Returns deployed commit SHA for verification.
 */

const ADMIN_KEY = process.env.ADMIN_API_KEY;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }
  if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }

  return res.status(200).json({
    ok: true,
    commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    timestamp: new Date().toISOString(),
  });
}

