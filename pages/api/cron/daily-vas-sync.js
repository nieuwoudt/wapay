/**
 * GET /api/cron/daily-vas-sync
 *
 * Daily cron entrypoint:
 * - sync Blu DATA catalogue into DB
 * - log counts so we can detect if a vendor goes to 0 products
 * - refresh semantic-search embeddings for changed products (best-effort;
 *   an embeddings failure never fails the cron response)
 * - sweep PENDING/INIT pay-outs and tell finalised customers (best-effort;
 *   the Hobby plan allows one cron, so this is the sweep's daily floor)
 *
 * Auth:
 * - Vercel Cron header: x-vercel-cron=1 (preferred)
 * - or query token: ?key=${CRON_SECRET}
 */

import { syncBluDataCatalogue } from '../../../lib/vas-catalog-sync.js';
import { syncProductEmbeddings } from '../../../lib/vas-embeddings.js';
import { sweepPayoutsAndNotify } from '../../../lib/payouts.js';
import { purgeOldTurns } from '../../../lib/turns.js';
import { checkWalletIntegrity } from '../../../lib/ledger-integrity.js';
import prisma from '../../../lib/prisma.js';

function isCronAuthed(req) {
  if (req.headers['x-vercel-cron'] === '1') return true;
  const key = req.query?.key;
  return process.env.CRON_SECRET && key === process.env.CRON_SECRET;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ ok: false, error: `Method ${req.method} Not Allowed` });
  }

  if (!isCronAuthed(req)) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }

  try {
    const out = await syncBluDataCatalogue();
    console.log(JSON.stringify({ type: 'cron_daily_vas_sync', ...out, timestamp: new Date().toISOString() }));

    // Best-effort embeddings refresh: must never fail the cron response.
    let embeddings;
    try {
      embeddings = await syncProductEmbeddings({ prisma });
    } catch (e) {
      console.error(JSON.stringify({
        type: 'cron_embeddings_sync_failed',
        error: e?.message || String(e),
        timestamp: new Date().toISOString(),
      }));
      embeddings = { embedded: 0, skipped: 0, failed: 0, error: e?.message || String(e) };
    }

    // Best-effort pay-out sweep: must never fail the cron response.
    let payoutSweep;
    try {
      // A daily floor only: five rows, twenty seconds, so the cron's other
      // work (catalogue, embeddings, retention) is never starved.
      const sweep = await sweepPayoutsAndNotify({ limit: 5, deadlineMs: 20 * 1000 });
      payoutSweep = { skipped: sweep.skipped || null, ...sweep.counts };
      console.log(JSON.stringify({ type: 'cron_payout_sweep', ...payoutSweep, timestamp: new Date().toISOString() }));
    } catch (e) {
      console.error(JSON.stringify({
        type: 'cron_payout_sweep_failed',
        error: e?.message || String(e),
        timestamp: new Date().toISOString(),
      }));
      payoutSweep = { error: e?.message || String(e) };
    }

    // Conversation memory retention (docs/AGENT_ARCHITECTURE_V2.md C14): turns
    // older than 30 days are deleted; best-effort, never fails the cron.
    let turnsPurged = null;
    try {
      turnsPurged = await purgeOldTurns({ prisma, olderThanDays: 30 });
      console.log(JSON.stringify({ type: 'cron_turns_purged', ...turnsPurged, timestamp: new Date().toISOString() }));
    } catch (e) {
      console.error(JSON.stringify({ type: 'cron_turns_purge_failed', error: e?.message || String(e), timestamp: new Date().toISOString() }));
    }

    // Balance integrity (docs/AGENT_ARCHITECTURE_V2.md C17): stored vs derived
    // for every wallet; drift is logged for Mission Control, never corrected here.
    let integrity = null;
    try {
      integrity = await checkWalletIntegrity({ prisma });
      console.log(JSON.stringify({ type: 'cron_ledger_integrity', checked: integrity.checked, mismatches: integrity.mismatches.length, stopped: integrity.stopped, drift: integrity.mismatches.slice(0, 20), timestamp: new Date().toISOString() }));
    } catch (e) {
      console.error(JSON.stringify({ type: 'cron_ledger_integrity_failed', error: e?.message || String(e), timestamp: new Date().toISOString() }));
    }

    return res.status(200).json({ ...out, turnsPurged, integrity: integrity ? { checked: integrity.checked, mismatches: integrity.mismatches.length } : null, embeddings, payoutSweep });
  } catch (e) {
    console.error('cron_daily_vas_sync_failed', e);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: e?.message || String(e) });
  }
}


