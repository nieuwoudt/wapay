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
 * - the daily conversation audit (docs/audits/DAILY_AUDIT.md): the day's
 *   conversations swept and reviewed, findings stored, the ops summary sent
 *   (best-effort, 25 s cap; never fails the cron)
 *
 * Auth:
 * - Authorization: Bearer CRON_SECRET (what Vercel sends when the env is set; lib/cron-auth.js)
 * - or query token: ?key=${CRON_SECRET}
 */

import { syncBluDataCatalogue } from '../../../lib/vas-catalog-sync.js';
import { syncProductEmbeddings } from '../../../lib/vas-embeddings.js';
import { sweepPayoutsAndNotify } from '../../../lib/payouts.js';
import { purgeOldTurns } from '../../../lib/turns.js';
import { checkWalletIntegrity } from '../../../lib/ledger-integrity.js';
import prisma from '../../../lib/prisma.js';
// Golden thread O4 (2026-10-16): Bearer CRON_SECRET only; no header trust, no query token.
import { isCronAuthed } from '../../../lib/cron-auth.js';


// The audit step at the end needs more than the default budget (2026-10-20: the 02:00 run read 3 of 5 chunks in 25 s).
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ ok: false, error: `Method ${req.method} Not Allowed` });
  }

  if (!isCronAuthed(req)) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }

  try {
    const cronStartedMs = Date.now();
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
      // A backlog on a DAILY floor means rows wait a full day each. Loud on
      // purpose: this is the number that decides whether the ten-minute
      // schedule is still optional (docs/AGENT_ARCHITECTURE_V2.md 14.1).
      if (payoutSweep.backlog > 0) {
        console.error(JSON.stringify({
          type: 'cron_payout_sweep_backlog',
          backlog: payoutSweep.backlog,
          note: 'eligible pay-outs the daily sweep could not reach; each waits another day',
          timestamp: new Date().toISOString(),
        }));
      }
    } catch (e) {
      console.error(JSON.stringify({
        type: 'cron_payout_sweep_failed',
        error: e?.message || String(e),
        timestamp: new Date().toISOString(),
      }));
      payoutSweep = { error: e?.message || String(e) };
    }

    // Held sends nobody collected in 30 days go back to their senders, each told
    // once (BUGLOG #117; Hobby plan, so it rides this daily cron like the pay-out
    // sweep). Best-effort: never changes this route's answer or status.
    try {
      const { refundHeldGiftsAndNotify } = await import('../../../lib/send-money.js');
      const heldRefund = await refundHeldGiftsAndNotify({});
      console.log(JSON.stringify({ type: 'cron_held_gift_refund', ...heldRefund, timestamp: new Date().toISOString() }));
    } catch (e) {
      console.error(JSON.stringify({ type: 'cron_held_gift_refund_failed', error: e?.message || String(e), timestamp: new Date().toISOString() }));
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

    // Growth (2026-10-10): the ad account's last three days from Meta's
    // Marketing API into ad_insights_daily, and the Conversions API floor for
    // attributed accounts whose Purchase has not been sent. Both best-effort,
    // both no-ops until their envs are set.
    let growth = null;
    try {
      const { snapshotAdInsights } = await import('../../../lib/meta-ads.js');
      const { capiSweep } = await import('../../../lib/growth-attribution.js');
      const ads = await snapshotAdInsights({ prisma, days: 3 });
      const capi = await capiSweep({ prisma, limit: 50, deadlineMs: 15 * 1000 });
      // The ad arrival's one reminder (docs/AD_CHAT_FLOW.md section 8), sent on
      // the customer's own 24h window through notifyCustomer.
      const { sendAdReminders } = await import('../../../lib/ad-reminders.js');
      const { notifyCustomer } = await import('../../../lib/notify.js');
      const reminders = await sendAdReminders({ prisma, limit: 20, send: ({ to, text, kind }) => notifyCustomer({ to, text, kind }) });
      growth = { ads, capi, reminders };
      // Logged, not returned: tests/payout-reconcile.test.mjs pins the response literal.
      console.log(JSON.stringify({ type: 'cron_growth', ...growth, timestamp: new Date().toISOString() }));
    } catch (e) {
      console.error(JSON.stringify({ type: 'cron_growth_failed', error: e?.message || String(e), timestamp: new Date().toISOString() }));
      growth = { error: e?.message || String(e) };
    }

    // The async tier (C20): work queued off the customer's turn. Bounded by a
    // batch size and its own deadline, because this function has a budget too.
    // Best effort: a stuck worker must never fail the rest of the nightly run.
    let jobs = null;
    try {
      const { drainJobs } = await import('../../../lib/jobs.js');
      const { reconcileFuelPurchases } = await import('../../../lib/fuel-settlement.js');
      const { reconcileElectricityPurchases } = await import('../../../lib/electricity-settlement.js');
      const { notifyCustomer } = await import('../../../lib/notify.js');
      jobs = await drainJobs({
        prisma,
        limit: 10,
        deadlineMs: 20 * 1000,
        handlers: {
          // Moved off the per-turn path on 2026-09-18: a slow supplier used to
          // slow the whole conversation for every fuel customer.
          'fuel-reconcile': async (job) => {
            const account = await prisma.account.findUnique({ where: { id: job.accountId } });
            if (!account) return { skipped: 'NO_ACCOUNT' };
            const recon = await reconcileFuelPurchases({ account });
            if (recon.failed > 0 && account.waId) {
              await notifyCustomer({
                to: account.waId,
                accountId: account.id,
                text: '💚 Quick update: a fuel voucher purchase from earlier could not be completed, so nothing was charged. Your money is back in your balance.',
                kind: 'receipt',
              });
            }
            return { settled: recon.settled ?? null, failed: recon.failed ?? null };
          },
          // An electricity sale that timed out at our end (2026-10-06): the
          // same requestId is sent again; a replayed vend delivers the token
          // here, a refusal puts the money back, anything else stays queued.
          'electricity-reconcile': async (job) => {
            const account = await prisma.account.findUnique({ where: { id: job.accountId } });
            if (!account) return { skipped: 'NO_ACCOUNT' };
            const recon = await reconcileElectricityPurchases({ account });
            if (account.waId) {
              for (const d of recon.delivered) {
                const formattedToken = String(d.token || '').replace(/(.{4})/g, '$1 ').trim();
                await notifyCustomer({
                  to: account.waId,
                  accountId: account.id,
                  text: `✅ Electricity purchase successful!\n\n📟 Meter: ${d.meterNumber}\n💰 Amount: R${(Number(d.amountCents || 0) / 100).toFixed(2)}\n⚡ Token: *${formattedToken}*\n🔋 Units: ${d.units || 'N/A'} kWh\n🧾 Reference: ${d.providerRef}\n\n💳 New balance: R${(Number(d.newBalanceCents || 0) / 100).toFixed(2)}`,
                  kind: 'receipt',
                });
              }
              if (recon.failed > 0) {
                await notifyCustomer({
                  to: account.waId,
                  accountId: account.id,
                  text: '💚 Quick update: an electricity purchase from earlier could not be completed, so nothing was charged. Your money is back in your balance.',
                  kind: 'receipt',
                });
              }
            }
            if (recon.pending > 0) throw new Error('ELECTRICITY_STILL_PENDING');
            return { settled: recon.settled, failed: recon.failed };
          },
        },
      });
      console.log(JSON.stringify({ type: 'cron_jobs_drained', ...jobs, timestamp: new Date().toISOString() }));
    } catch (e) {
      console.error(JSON.stringify({ type: 'cron_jobs_drain_failed', error: e?.message || String(e), timestamp: new Date().toISOString() }));
    }

    // Meta's quality rating (2026-10-20, BUGLOG #130): read once a day, alert ops while it is not GREEN. Logged, never returned.
    try {
      const { qualityCheck } = await import('../../../lib/whatsapp-quality.js');
      await Promise.race([qualityCheck(), new Promise((resolve) => setTimeout(() => resolve({ skipped: 'TIMEOUT' }), 8000))]);
      const { deliveryStallCheck } = await import('../../../lib/delivery-health.js');
      await Promise.race([deliveryStallCheck({ prisma }), new Promise((resolve) => setTimeout(() => resolve({ skipped: 'TIMEOUT' }), 5000))]);
    } catch (e) {
      console.error(JSON.stringify({ type: 'cron_whatsapp_quality_failed', error: e?.message || String(e), timestamp: new Date().toISOString() }));
    }

    // The daily conversation audit (docs/audits/DAILY_AUDIT.md, 2026-10-19):
    // the conversations since the last run swept by the rules and read by the
    // reviewer, findings stored with their recurrence, the ops summary sent.
    // One call, its own try/catch, a hard cap of 45 s (less when the steps
    // above used the function's budget): it can never fail or delay the cron's
    // answer, and it is logged, never returned (the response literal below is
    // pinned by tests/payout-reconcile.test.mjs).
    try {
      // 2026-10-21: the 02:00 run reviewed 0 of 12 chunks because the steps above had used the
      // budget (the audit got the 5-second floor). The audit now runs in its OWN invocation:
      // this cron fires POST /api/internal/audit-run with the internal key and stops waiting
      // after four seconds; the route keeps running on its own 60-second budget after the
      // client goes away. The in-process run stays as the fallback when the hand-off cannot be
      // made (no key, no base URL, the request never left).
      const { runDailyAudit } = await import('../../../lib/audit/run.js');
      const auditCapMs = Math.max(5 * 1000, Math.min(45 * 1000, 57 * 1000 - (Date.now() - cronStartedMs)));
      let audit = null;
      const key = process.env.WAPAY_INTERNAL_API_KEY || '';
      if (key) {
        const { apiUrl } = await import('../../../lib/api-url.js');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        try {
          const r = await fetch(apiUrl('/api/internal/audit-run', req), { method: 'POST', headers: { 'x-internal-api-key': key, 'content-type': 'application/json' }, signal: controller.signal });
          audit = { ok: r.ok, handoff: true, status: r.status };
        } catch (e) {
          // An abort means the request was sent and the audit route is running on its own budget.
          audit = e?.name === 'AbortError' ? { ok: true, handoff: true, status: 'RUNNING' } : null;
          if (!audit) console.error(JSON.stringify({ type: 'cron_daily_audit_handoff_failed', error: e?.message || String(e) }));
        } finally { clearTimeout(timer); }
      }
      if (!audit) {
        let auditTimer = null;
        audit = await Promise.race([
          runDailyAudit({ prisma, deadlineMs: auditCapMs - 3 * 1000 }),
          new Promise((resolve) => { auditTimer = setTimeout(() => resolve({ ok: false, skipped: 'TIMEOUT' }), auditCapMs); }),
        ]);
        if (auditTimer) clearTimeout(auditTimer);
      }
      console.log(JSON.stringify({
        type: 'cron_daily_audit',
        handoff: audit?.handoff || false,
        ok: audit?.ok ?? false,
        skipped: audit?.skipped || audit?.review?.skipped || null,
        error: audit?.error || null,
        runId: audit?.runId || null,
        accounts: audit?.accounts ?? null,
        turns: audit?.turns ?? null,
        p1: audit?.counts?.p1 ?? null,
        p2: audit?.counts?.p2 ?? null,
        p3: audit?.counts?.p3 ?? null,
        reviewed: audit?.reviewed ?? null,
        capMs: auditCapMs,
        timestamp: new Date().toISOString(),
      }));
    } catch (e) {
      console.error(JSON.stringify({ type: 'cron_daily_audit_failed', error: e?.message || String(e), timestamp: new Date().toISOString() }));
    }

    return res.status(200).json({ ...out, turnsPurged, integrity: integrity ? { checked: integrity.checked, mismatches: integrity.mismatches.length } : null, embeddings, payoutSweep, jobs });
  } catch (e) {
    console.error('cron_daily_vas_sync_failed', e);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: e?.message || String(e) });
  }
}


