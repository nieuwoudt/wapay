/**
 * GET /api/admin/programme                                         (admin session)
 *
 * Mission Control's Programme tab (founder 2026-11-13): every workstream,
 * thread and open item in one place, a management view and a build view. The
 * content is the snapshot a session published through
 * POST /api/internal/programme; it lives in the database, never in the
 * repository (lib/programme-board.js says why). Read-only.
 */
import prismaDefault from '../../../lib/prisma.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { loadBoard } from '../../../lib/programme-board.js';

/** The handler with its database named, so a test can hand it a stand-in. */
export function createProgrammeReadHandler({ prisma = prismaDefault } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
    if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
    const cur = await loadBoard({ prisma });
    if (!cur) return res.status(200).json({ ok: true, stored: false });
    return res.status(200).json({ ok: true, stored: true, storedAt: cur.storedAt, by: cur.by, board: cur.board });
  };
}

export default createProgrammeReadHandler();
