/**
 * The programme board snapshot (lib/programme-board.js, 2026-11-13).
 *
 *   GET  /api/internal/programme            what is stored now: counts, when, by whom (never the content)
 *   POST /api/internal/programme { board, by? }   validate and store the board as the current snapshot
 *
 * Internal key. A session publishes the board with scripts/programme-board.mjs
 * after it changed the private master file; Mission Control then shows it
 * (GET /api/admin/programme). The board is refused when it carries a number
 * or anything shaped like a secret, so a slip in the master file never reaches
 * the database. Touches one finished row in agent_jobs and nothing else.
 */
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import prismaDefault from '../../../lib/prisma.js';
import { validateBoard, saveBoard, loadBoard } from '../../../lib/programme-board.js';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

/** The handler with its database named, so a test can hand it a stand-in. */
export function createProgrammeStoreHandler({ prisma = prismaDefault } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!requireInternalAuth(req, res)) return;

    if (req.method === 'GET') {
      const cur = await loadBoard({ prisma });
      if (!cur) return res.status(200).json({ ok: true, stored: false });
      const v = validateBoard(cur.board);
      return res.status(200).json({ ok: true, stored: true, storedAt: cur.storedAt, by: cur.by, asOf: cur.board?.asOf || null, valid: v.ok, counts: v.counts });
    }

    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'METHOD' });
    if (!/application\/json/i.test(String(req.headers?.['content-type'] || ''))) return res.status(415).json({ ok: false, error: 'JSON_ONLY' });
    const board = req.body && typeof req.body === 'object' ? req.body.board : null;
    const v = validateBoard(board);
    if (!v.ok) return res.status(400).json({ ok: false, error: 'INVALID_BOARD', errors: v.errors });
    const by = String(req.body?.by || 'session').slice(0, 60);
    try {
      const out = await saveBoard({ prisma, board, by });
      if (!out.ok) return res.status(400).json(out);
      console.log(JSON.stringify({ type: 'programme_board_stored', by, counts: out.counts, timestamp: new Date().toISOString() }));
      return res.status(200).json(out);
    } catch (error) {
      console.log(JSON.stringify({ type: 'programme_board_store_failed', error: String(error?.message || error).slice(0, 200), timestamp: new Date().toISOString() }));
      return res.status(500).json({ ok: false, error: 'STORE_FAILED' });
    }
  };
}

export default createProgrammeStoreHandler();
