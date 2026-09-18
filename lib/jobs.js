/**
 * The async tier — C20 of docs/AGENT_ARCHITECTURE_V2.md, Phase 4.
 *
 * One table for every piece of work that must not run while a customer waits.
 * The WhatsApp turn has a 60 second function budget and a person watching a
 * typing indicator; a supplier reconcile, a retention purge or a backfill has
 * no business in it. Before this, the fuel reconcile ran inline on the turn of
 * every fuel customer, and a slow supplier made their whole conversation slow.
 *
 * The contract:
 *   * enqueue is idempotent on (kind, key). Queueing the same work twice is a
 *     no-op, which is what lets a per-turn hook enqueue freely and cheaply.
 *   * claimJobs takes a batch atomically. Two drains running at once cannot
 *     take the same row, because the claim is a conditional updateMany and
 *     only one of them can match.
 *   * A RUNNING row older than the stale window is reclaimable: a serverless
 *     worker can vanish mid-job without ever writing DONE or FAILED, and a job
 *     nobody will ever finish must not sit there forever.
 *   * A job that exhausts maxAttempts is FAILED and left for a human. Nothing
 *     retries forever, because a poisoned job that retries forever is an
 *     outage that looks like a queue.
 *   * Backoff is exponential on runAfter, so a supplier having a bad hour is
 *     not hammered.
 *
 * Nothing here moves money. A worker may call code that does, and that code
 * keeps its own idempotency (deterministic idemKeys through ledger-post), so a
 * job that runs twice is safe by construction rather than by this table.
 *
 * Never throws at the caller: a queue failure must not fail the money flow or
 * the customer turn that produced it.
 */
import prismaDefault from './prisma.js';

const log = (type, data) => console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));

/** A claim older than this is assumed dead and may be taken again. */
export const STALE_LOCK_MS = 10 * 60 * 1000;
/** Retry delay: 1 min, 4 min, 9 min, 16 min … capped. */
export const backoffMs = (attempts) => Math.min(60 * 60 * 1000, Math.max(1, attempts) ** 2 * 60 * 1000);

export const JOB_STATUS = Object.freeze({ PENDING: 'PENDING', RUNNING: 'RUNNING', DONE: 'DONE', FAILED: 'FAILED' });

/**
 * Queue work, once. A second call with the same (kind, key) while the first is
 * still PENDING or RUNNING does nothing and says so.
 *
 * @returns {Promise<{ ok: boolean, queued: boolean, id?: string, reason?: string }>}
 */
export async function enqueueJob({
  prisma = prismaDefault,
  kind,
  key,
  accountId = null,
  payload = null,
  runAfter = null,
  maxAttempts = 5,
} = {}) {
  try {
    if (!kind || !key) return { ok: false, queued: false, reason: 'MISSING_ARGS' };
    const existing = await prisma.agentJob.findUnique({ where: { kind_key: { kind, key } }, select: { id: true, status: true } });
    if (existing) {
      // A finished row is the record of work already done: re-running it is
      // the caller's decision, made by passing a new key.
      if (existing.status === JOB_STATUS.PENDING || existing.status === JOB_STATUS.RUNNING) {
        return { ok: true, queued: false, id: existing.id, reason: 'ALREADY_QUEUED' };
      }
      return { ok: true, queued: false, id: existing.id, reason: existing.status };
    }
    const row = await prisma.agentJob.create({
      data: { kind, key, accountId, payload, maxAttempts, runAfter: runAfter || new Date() },
      select: { id: true },
    });
    log('job_enqueued', { kind, key, accountId, id: row.id });
    return { ok: true, queued: true, id: row.id };
  } catch (error) {
    // A unique-constraint race means someone else queued it first, which is
    // exactly the outcome we wanted.
    if (error?.code === 'P2002') return { ok: true, queued: false, reason: 'ALREADY_QUEUED' };
    log('job_enqueue_failed', { kind, key, error: error?.message });
    return { ok: false, queued: false, reason: 'ERROR' };
  }
}

/**
 * Take up to `limit` runnable jobs. Atomic: a concurrent drain cannot take the
 * same row, because the update only matches a row still in the status it read.
 *
 * @returns {Promise<Array<object>>} the rows this caller owns
 */
export async function claimJobs({ prisma = prismaDefault, kinds = null, limit = 5, now = new Date() } = {}) {
  try {
    const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
    const where = {
      runAfter: { lte: now },
      OR: [
        { status: JOB_STATUS.PENDING },
        // A worker that vanished mid-job: its claim has gone stale.
        { status: JOB_STATUS.RUNNING, lockedAt: { lt: staleBefore } },
      ],
      ...(kinds && kinds.length ? { kind: { in: kinds } } : {}),
    };
    const candidates = await prisma.agentJob.findMany({ where, orderBy: { runAfter: 'asc' }, take: Math.max(1, limit) });
    const mine = [];
    for (const c of candidates) {
      // The values are read ONCE, before the update: the row we hand back must
      // describe the claim we made, not whatever the object looks like
      // afterwards. (A fake database that returns live references caught this;
      // Prisma returns snapshots, but depending on that is a trap.)
      const was = { id: c.id, status: c.status, attempts: c.attempts };
      const nextAttempts = was.attempts + 1;
      const { count } = await prisma.agentJob.updateMany({
        where: { id: was.id, status: was.status, attempts: was.attempts },
        data: { status: JOB_STATUS.RUNNING, lockedAt: now, attempts: nextAttempts },
      });
      if (count === 1) mine.push({ ...c, id: was.id, status: JOB_STATUS.RUNNING, attempts: nextAttempts });
    }
    return mine;
  } catch (error) {
    log('job_claim_failed', { error: error?.message });
    return [];
  }
}

/** Mark a claimed job finished. Never throws. */
export async function completeJob({ prisma = prismaDefault, id, result = null } = {}) {
  try {
    if (!id) return { ok: false };
    await prisma.agentJob.update({ where: { id }, data: { status: JOB_STATUS.DONE, result, lockedAt: null, lastError: null } });
    return { ok: true };
  } catch (error) {
    log('job_complete_failed', { id, error: error?.message });
    return { ok: false };
  }
}

/**
 * Hand a failed job back for a later attempt, or give up on it.
 * Giving up is deliberate: a job retried forever is an outage wearing a queue's
 * clothes, and a human should see a FAILED row.
 */
export async function failJob({ prisma = prismaDefault, id, error, attempts = 0, maxAttempts = 5, now = new Date() } = {}) {
  try {
    if (!id) return { ok: false, retrying: false };
    const message = String(error?.message || error || 'unknown').slice(0, 500);
    if (attempts >= maxAttempts) {
      await prisma.agentJob.update({ where: { id }, data: { status: JOB_STATUS.FAILED, lastError: message, lockedAt: null } });
      log('job_gave_up', { id, attempts, error: message });
      return { ok: true, retrying: false };
    }
    await prisma.agentJob.update({
      where: { id },
      data: { status: JOB_STATUS.PENDING, lastError: message, lockedAt: null, runAfter: new Date(now.getTime() + backoffMs(attempts)) },
    });
    return { ok: true, retrying: true };
  } catch (e) {
    log('job_fail_failed', { id, error: e?.message });
    return { ok: false, retrying: false };
  }
}

/**
 * Run one batch. `handlers` maps a kind to an async function taking the job row.
 * A kind with no handler is failed by name rather than silently retried, so a
 * typo surfaces instead of filling the table.
 *
 * Bounded by BOTH a batch size and a wall-clock deadline, because this runs
 * inside a cron function with its own budget.
 *
 * @returns {Promise<{ claimed: number, done: number, failed: number, gaveUp: number, byKind: object }>}
 */
export async function drainJobs({ prisma = prismaDefault, handlers = {}, limit = 5, deadlineMs = 20000, now = () => new Date() } = {}) {
  const startedAt = Date.now();
  const counts = { claimed: 0, done: 0, failed: 0, gaveUp: 0, byKind: {} };
  const jobs = await claimJobs({ prisma, kinds: Object.keys(handlers), limit, now: now() });
  counts.claimed = jobs.length;
  for (const job of jobs) {
    if (Date.now() - startedAt > deadlineMs) {
      // Out of budget: hand the rest back immediately rather than half-running
      // them. runAfter is left alone, so the next drain takes them at once.
      await failJob({ prisma, id: job.id, error: 'DEADLINE', attempts: 0, maxAttempts: job.maxAttempts, now: now() });
      continue;
    }
    counts.byKind[job.kind] = counts.byKind[job.kind] || { done: 0, failed: 0 };
    const handler = handlers[job.kind];
    try {
      if (typeof handler !== 'function') throw new Error(`no handler for kind ${job.kind}`);
      const result = await handler(job);
      await completeJob({ prisma, id: job.id, result: result ?? null });
      counts.done += 1;
      counts.byKind[job.kind].done += 1;
    } catch (error) {
      const r = await failJob({ prisma, id: job.id, error, attempts: job.attempts, maxAttempts: job.maxAttempts, now: now() });
      counts.failed += 1;
      counts.byKind[job.kind].failed += 1;
      if (!r.retrying) counts.gaveUp += 1;
      log('job_failed', { id: job.id, kind: job.kind, attempts: job.attempts, retrying: r.retrying, error: String(error?.message || error).slice(0, 200) });
    }
  }
  if (counts.claimed) log('jobs_drained', counts);
  return counts;
}

/** What is waiting, for Mission Control and for a human asking "is it stuck". */
export async function jobStats({ prisma = prismaDefault, now = new Date() } = {}) {
  try {
    const rows = await prisma.agentJob.groupBy({ by: ['status'], _count: { _all: true } });
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r._count?._all || 0]));
    const oldest = await prisma.agentJob.findFirst({
      where: { status: JOB_STATUS.PENDING, runAfter: { lte: now } },
      orderBy: { runAfter: 'asc' },
      select: { kind: true, runAfter: true },
    });
    return {
      byStatus,
      pending: byStatus.PENDING || 0,
      failed: byStatus.FAILED || 0,
      oldestWaitingMinutes: oldest ? Math.round((now.getTime() - new Date(oldest.runAfter).getTime()) / 60000) : null,
      oldestKind: oldest?.kind || null,
    };
  } catch (error) {
    log('job_stats_failed', { error: error?.message });
    return { byStatus: {}, pending: 0, failed: 0, oldestWaitingMinutes: null, oldestKind: null };
  }
}
