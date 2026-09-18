/**
 * The async tier (C20, Phase 4): work that must not run while a customer waits.
 *
 * What these lock is the behaviour that makes a queue safe rather than a second
 * outage surface: enqueue is idempotent, two drains cannot take the same row, a
 * worker that vanishes does not strand its job forever, a poisoned job stops
 * instead of retrying forever, and nothing here ever throws at the caller.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { enqueueJob, claimJobs, completeJob, failJob, drainJobs, jobStats, backoffMs, STALE_LOCK_MS, JOB_STATUS } from '../lib/jobs.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** An in-memory stand-in for the one table, with the unique index enforced. */
function fakeDb(rows = []) {
  let seq = 0;
  const store = rows.map((r, i) => ({ id: r.id || `j${i}`, attempts: 0, maxAttempts: 5, status: 'PENDING', runAfter: new Date(0), lockedAt: null, payload: null, accountId: null, ...r }));
  const match = (row, where) => {
    for (const [k, v] of Object.entries(where)) {
      if (k === 'OR') { if (!v.some((w) => match(row, w))) return false; continue; }
      if (k === 'kind' && v && typeof v === 'object' && v.in) { if (!v.in.includes(row.kind)) return false; continue; }
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('lte' in v && !(new Date(row[k]) <= v.lte)) return false;
        if ('lt' in v && !(row[k] && new Date(row[k]) < v.lt)) return false;
        continue;
      }
      if (row[k] !== v) return false;
    }
    return true;
  };
  return {
    store,
    agentJob: {
      findUnique: async ({ where }) => store.find((r) => r.kind === where.kind_key?.kind && r.key === where.kind_key?.key) || null,
      create: async ({ data }) => {
        if (store.some((r) => r.kind === data.kind && r.key === data.key)) { const e = new Error('unique'); e.code = 'P2002'; throw e; }
        const row = { id: `new${++seq}`, attempts: 0, maxAttempts: 5, status: 'PENDING', lockedAt: null, ...data };
        store.push(row);
        return row;
      },
      // Copies, like Prisma: a caller must not be handed a live row.
      findMany: async ({ where, take }) => store.filter((r) => match(r, where)).slice(0, take ?? store.length).map((r) => ({ ...r })),
      findFirst: async ({ where }) => store.filter((r) => match(r, where))[0] || null,
      updateMany: async ({ where, data }) => {
        const hit = store.filter((r) => match(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
      update: async ({ where, data }) => {
        const r = store.find((x) => x.id === where.id);
        if (!r) throw new Error('not found');
        Object.assign(r, data);
        return r;
      },
      groupBy: async () => {
        const by = {};
        for (const r of store) by[r.status] = (by[r.status] || 0) + 1;
        return Object.entries(by).map(([status, n]) => ({ status, _count: { _all: n } }));
      },
    },
  };
}

test('enqueue is idempotent on kind and key, so a per-turn hook can queue freely', async () => {
  const db = fakeDb();
  const a = await enqueueJob({ prisma: db, kind: 'fuel-reconcile', key: 'acct:1', accountId: 'a1' });
  assert.equal(a.queued, true);
  const b = await enqueueJob({ prisma: db, kind: 'fuel-reconcile', key: 'acct:1', accountId: 'a1' });
  assert.deepEqual([b.ok, b.queued, b.reason], [true, false, 'ALREADY_QUEUED']);
  assert.equal(db.store.length, 1, 'a chatty customer never queues the same work twice');
  const other = await enqueueJob({ prisma: db, kind: 'fuel-reconcile', key: 'acct:2' });
  assert.equal(other.queued, true);
  assert.deepEqual(await enqueueJob({ prisma: db, kind: '', key: 'x' }), { ok: false, queued: false, reason: 'MISSING_ARGS' });
  const broken = { agentJob: { findUnique: async () => { throw new Error('db down'); } } };
  assert.equal((await enqueueJob({ prisma: broken, kind: 'k', key: 'v' })).ok, false, 'never throws at the caller');
});

test('a claim is atomic, so two drains running at once cannot take the same row', async () => {
  const db = fakeDb([{ kind: 'fuel-reconcile', key: 'k1' }, { kind: 'fuel-reconcile', key: 'k2' }]);
  const first = await claimJobs({ prisma: db, kinds: ['fuel-reconcile'], limit: 5 });
  assert.equal(first.length, 2);
  assert.ok(first.every((j) => j.status === JOB_STATUS.RUNNING && j.attempts === 1));
  const second = await claimJobs({ prisma: db, kinds: ['fuel-reconcile'], limit: 5 });
  assert.equal(second.length, 0, 'the second drain finds nothing runnable');
});

test('a worker that vanished mid-job does not strand its work forever', async () => {
  const fresh = fakeDb([{ kind: 'k', key: 'a', status: 'RUNNING', lockedAt: new Date(Date.now() - 60 * 1000) }]);
  assert.equal((await claimJobs({ prisma: fresh, kinds: ['k'] })).length, 0, 'a live claim is respected');
  const stale = fakeDb([{ kind: 'k', key: 'a', status: 'RUNNING', lockedAt: new Date(Date.now() - STALE_LOCK_MS - 1000) }]);
  assert.equal((await claimJobs({ prisma: stale, kinds: ['k'] })).length, 1, 'a dead claim is reclaimed');
});

test('a failure backs off and then gives up, instead of retrying forever', async () => {
  assert.ok(backoffMs(1) < backoffMs(2) && backoffMs(2) < backoffMs(3), 'exponential');
  assert.equal(backoffMs(1), 60 * 1000);
  assert.ok(backoffMs(100) <= 60 * 60 * 1000, 'capped, so a bad hour is not hammered');
  const db = fakeDb([{ kind: 'k', key: 'a' }]);
  const retry = await failJob({ prisma: db, id: db.store[0].id, error: new Error('supplier down'), attempts: 1, maxAttempts: 3 });
  assert.deepEqual([retry.ok, retry.retrying], [true, true]);
  assert.equal(db.store[0].status, JOB_STATUS.PENDING);
  assert.ok(db.store[0].runAfter > new Date(), 'it waits before the next attempt');
  const gaveUp = await failJob({ prisma: db, id: db.store[0].id, error: new Error('poison'), attempts: 3, maxAttempts: 3 });
  assert.deepEqual([gaveUp.ok, gaveUp.retrying], [true, false]);
  assert.equal(db.store[0].status, JOB_STATUS.FAILED, 'a human sees a FAILED row rather than an endless queue');
  assert.match(db.store[0].lastError, /poison/);
});

test('a drain runs the handler, records the result, and fails a kind nobody handles by name', async () => {
  const db = fakeDb([{ kind: 'fuel-reconcile', key: 'a', accountId: 'acc1' }, { kind: 'mystery', key: 'b' }]);
  const seen = [];
  const counts = await drainJobs({
    prisma: db,
    handlers: { 'fuel-reconcile': async (job) => { seen.push(job.accountId); return { settled: 1 }; }, mystery: undefined },
    limit: 10,
  });
  assert.deepEqual(seen, ['acc1']);
  assert.equal(counts.done, 1);
  const done = db.store.find((r) => r.kind === 'fuel-reconcile');
  assert.equal(done.status, JOB_STATUS.DONE);
  assert.deepEqual(done.result, { settled: 1 });
  const unknown = db.store.find((r) => r.kind === 'mystery');
  assert.match(unknown.lastError || '', /no handler for kind mystery/, 'a typo surfaces instead of filling the table');
});

test('a handler that throws never escapes the drain, and the deadline hands work back rather than half-running it', async () => {
  const db = fakeDb([{ kind: 'k', key: 'a' }]);
  const counts = await drainJobs({ prisma: db, handlers: { k: async () => { throw new Error('boom'); } } });
  assert.equal(counts.failed, 1);
  assert.equal(db.store[0].status, JOB_STATUS.PENDING, 'it will be retried');
  const many = fakeDb([{ kind: 'k', key: 'a' }, { kind: 'k', key: 'b' }]);
  const slow = await drainJobs({ prisma: many, handlers: { k: async () => { await new Promise((r) => setTimeout(r, 30)); } }, deadlineMs: 1, limit: 10 });
  assert.equal(slow.claimed, 2);
  assert.ok(slow.done <= 1, 'the second job is handed back, not half-run');
});

test('jobStats answers "is anything stuck" without scanning, and never throws', async () => {
  const db = fakeDb([{ kind: 'k', key: 'a' }, { kind: 'k', key: 'b', status: 'FAILED' }]);
  const s = await jobStats({ prisma: db });
  assert.equal(s.pending, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.oldestKind, 'k');
  assert.ok(Number.isFinite(s.oldestWaitingMinutes));
  const broken = { agentJob: { groupBy: async () => { throw new Error('down'); } } };
  assert.deepEqual((await jobStats({ prisma: broken })).byStatus, {});
});

test('the jobs tier is wired: the cron drains it, and the fuel reconcile queues a belt-and-braces job while staying on the turn', () => {
  const processor = read('../pages/api/webhooks/message-processor-v2.js');
  const hook = processor.slice(processor.indexOf('fuel-preview'), processor.indexOf('fuel-preview') + 2000);
  assert.match(hook, /enqueueJob\(\{/);
  assert.match(hook, /kind: 'fuel-reconcile'/);
  assert.match(hook, /key: `acct:\$\{account\.id\}`/, 'idempotent per customer');
  // The reconcile itself deliberately STAYS on the turn: it only runs for a
  // customer who already has a stuck purchase, and this is the turn their code
  // can be delivered. The job is the belt and braces for a turn that dies.
  assert.match(hook, /await reconcileFuelPurchases\(\{ account \}\)/);
  assert.match(hook, /recon\.settled === 0 && recon\.failed === 0/, 'queued only when nothing resolved');
  const cron = read('../pages/api/cron/daily-vas-sync.js');
  assert.match(cron, /drainJobs\(\{/);
  assert.match(cron, /'fuel-reconcile': async \(job\)/);
  assert.match(cron, /notifyCustomer\(\{/, 'the customer is told by the rail that crosses the window');
  assert.match(cron, /deadlineMs: 20 \* 1000/);
  const schema = read('../packages/domain/prisma/schema.prisma');
  assert.match(schema, /model AgentJob \{/);
  assert.match(schema, /@@unique\(\[kind, key\]\)/);
  assert.match(schema, /@@map\("agent_jobs"\)/);
  const sql = read('../packages/domain/prisma/migrations/20260918_agent_jobs/migration.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "agent_jobs"/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "agent_jobs_kind_key_key"/);
  assert.doesNotMatch(sql, /DO \$\$/, 'the apply script splits on ";\\n"');
});
