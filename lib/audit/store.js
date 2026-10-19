/**
 * The audit store (docs/audits/DAILY_AUDIT.md): audit_runs (one row per run)
 * and audit_findings (one row per distinct finding, keyed by fingerprint =
 * sha1(category + normalised title)), so a problem that returns day after
 * day is counted as recurring instead of listed again.
 *
 * Status rules (the brief, 2026-10-19):
 *   open      = seen in the latest run only (first seen there)
 *   recurring = seen in two or more runs
 *   resolved  = not seen in the last two runs that had conversations, after
 *               having been seen; or marked by hand (POST /api/internal/
 *               audit-resolve). A resolved finding seen again reopens as
 *               recurring and keeps the note, so a regression is visible.
 *
 * Every function takes `prisma`; tests stub it. Nothing here reads a
 * customer row: the store holds the audit's own rows only.
 */
import crypto from 'node:crypto';

export const ACCOUNTS_KEPT = 20;
export const RESOLVED_BY_RULE_NOTE = 'Not seen in the last two runs.';
const SEV_RANK = { P1: 1, P2: 2, P3: 3 };

/** Lower case, amounts and numbers as #, letters and digits only, one space. Pure. */
export function normaliseTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\br\s?\d+(?:[ ,.]\d+)*\b/g, 'r#')
    .replace(/\d+/g, '#')
    .replace(/[^a-z0-9#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function fingerprintOf(category, title) {
  return crypto.createHash('sha1').update(`${String(category || 'other').toLowerCase()}|${normaliseTitle(title)}`).digest('hex');
}

/** Merge account references newest first, one per id, capped. Pure. */
export function mergeAccounts(existing, incoming, cap = ACCOUNTS_KEPT) {
  const byId = new Map();
  for (const a of [...(incoming || []), ...(existing || [])]) {
    if (!a || !a.id) continue;
    const prev = byId.get(a.id);
    if (!prev || (!prev.at && a.at)) byId.set(a.id, { id: a.id, at: a.at || prev?.at || null });
  }
  return [...byId.values()].sort((x, y) => Date.parse(y.at || 0) - Date.parse(x.at || 0)).slice(0, cap);
}

/** Group a run's findings by fingerprint: the row each group writes. Pure. */
export function groupFindings(findings) {
  const groups = new Map();
  for (const f of findings || []) {
    if (!f || !f.title) continue;
    const fingerprint = f.fingerprint || fingerprintOf(f.category, f.title);
    if (!groups.has(fingerprint)) groups.set(fingerprint, { fingerprint, severity: f.severity, category: f.category || 'other', title: f.title, why: f.why || null, fix: f.fix || null, hits: 0, accounts: [], sampleBotQuote: null, sampleUserQuote: null, rules: new Set() });
    const g = groups.get(fingerprint);
    g.hits += 1;
    if ((SEV_RANK[f.severity] || 9) < (SEV_RANK[g.severity] || 9)) g.severity = f.severity;
    if (f.accountId) g.accounts.push({ id: f.accountId, at: f.at || null });
    if (!g.sampleBotQuote && f.botQuote) g.sampleBotQuote = f.botQuote;
    if (!g.sampleUserQuote && f.userQuote) g.sampleUserQuote = f.userQuote;
    if (!g.why && f.why) g.why = f.why;
    if (!g.fix && f.fix) g.fix = f.fix;
    if (f.rule) g.rules.add(f.rule);
  }
  return [...groups.values()].map((g) => ({ ...g, accounts: mergeAccounts([], g.accounts, Number.MAX_SAFE_INTEGER), rules: [...g.rules] }));
}

/** The newest finished run without an error (with conversations when `withAccounts`). */
export async function latestRun({ prisma, withAccounts = false, before = null } = {}) {
  const where = { finishedAt: { not: null }, error: null };
  if (withAccounts) where.accounts = { gt: 0 };
  if (before) where.id = { not: before };
  return prisma.auditRun.findFirst({ where, orderBy: { startedAt: 'desc' } });
}

export async function createRun({ prisma, since, until, now = new Date() }) {
  return prisma.auditRun.create({ data: { startedAt: now, since: new Date(since), until: new Date(until) } });
}

export async function finishRun({ prisma, runId, data }) {
  return prisma.auditRun.update({ where: { id: runId }, data });
}

/**
 * upsertFindings({ prisma, runId, findings, now }) -> { created, updated, rows }
 * One row per fingerprint; a new one opens, a known one becomes recurring
 * (or stays open when it was first seen in this same run).
 */
export async function upsertFindings({ prisma, runId, findings, now = new Date() }) {
  const groups = groupFindings(findings);
  const rows = [];
  let created = 0; let updated = 0;
  for (const g of groups) {
    const existing = await prisma.auditFinding.findUnique({ where: { fingerprint: g.fingerprint } });
    if (!existing) {
      const row = await prisma.auditFinding.create({
        data: {
          fingerprint: g.fingerprint, severity: g.severity, category: g.category, title: g.title, why: g.why, fix: g.fix,
          firstSeenRunId: runId, lastSeenRunId: runId, firstSeenAt: now, lastSeenAt: now,
          occurrences: g.hits, accountCount: g.accounts.length, accountsJson: g.accounts.slice(0, ACCOUNTS_KEPT),
          sampleBotQuote: g.sampleBotQuote, sampleUserQuote: g.sampleUserQuote, status: 'open',
        },
      });
      created += 1; rows.push(row);
      continue;
    }
    const known = new Set((Array.isArray(existing.accountsJson) ? existing.accountsJson : []).map((a) => a && a.id).filter(Boolean));
    const fresh = g.accounts.filter((a) => !known.has(a.id)).length;
    const sameRun = existing.lastSeenRunId === runId;
    const data = {
      lastSeenRunId: runId, lastSeenAt: now,
      occurrences: (existing.occurrences || 0) + g.hits,
      accountCount: (existing.accountCount || known.size) + fresh,
      accountsJson: mergeAccounts(existing.accountsJson, g.accounts),
      severity: (SEV_RANK[g.severity] || 9) < (SEV_RANK[existing.severity] || 9) ? g.severity : existing.severity,
      why: existing.why || g.why, fix: existing.fix || g.fix,
      sampleBotQuote: existing.sampleBotQuote || g.sampleBotQuote,
      sampleUserQuote: existing.sampleUserQuote || g.sampleUserQuote,
      status: sameRun ? existing.status : existing.firstSeenRunId === runId ? 'open' : 'recurring',
      resolvedAt: null,
    };
    const row = await prisma.auditFinding.update({ where: { fingerprint: g.fingerprint }, data });
    updated += 1; rows.push(row);
  }
  return { created, updated, rows };
}

/**
 * settleStatuses({ prisma, runId, previousRunId, now }) -> { resolved }
 * Findings not seen in this run nor the previous run with conversations are
 * resolved by the rule. With no such previous run nothing can be resolved:
 * one miss is not two.
 */
export async function settleStatuses({ prisma, runId, previousRunId, now = new Date() }) {
  if (!runId || !previousRunId) return { resolved: 0 };
  const r = await prisma.auditFinding.updateMany({
    where: { status: { not: 'resolved' }, lastSeenRunId: { notIn: [runId, previousRunId] } },
    data: { status: 'resolved', resolvedAt: now, resolvedNote: RESOLVED_BY_RULE_NOTE },
  });
  return { resolved: r?.count || 0 };
}

/** Mark one finding resolved by hand. null when the fingerprint is unknown. */
export async function resolveFinding({ prisma, fingerprint, note, now = new Date() }) {
  const existing = await prisma.auditFinding.findUnique({ where: { fingerprint } });
  if (!existing) return null;
  return prisma.auditFinding.update({ where: { fingerprint }, data: { status: 'resolved', resolvedAt: now, resolvedNote: String(note || '').trim().slice(0, 500) || 'Resolved by hand.' } });
}

export async function statusCounts({ prisma }) {
  const rows = await prisma.auditFinding.groupBy({ by: ['status'], _count: { _all: true } });
  const out = { open: 0, recurring: 0, resolved: 0 };
  for (const r of rows || []) {
    const n = typeof r._count === 'number' ? r._count : Number(r._count?._all || 0);
    if (r.status in out) out[r.status] = n;
  }
  return out;
}

/** The recurring findings with the most hits, as { title, occurrences, severity }. */
export async function topRecurring({ prisma, limit = 5 }) {
  const rows = await prisma.auditFinding.findMany({ where: { status: 'recurring' }, orderBy: [{ occurrences: 'desc' }, { lastSeenAt: 'desc' }], take: limit, select: { title: true, occurrences: true, severity: true, fingerprint: true } });
  return rows || [];
}

/**
 * trend({ prisma, limit }) -> [{ date, found, resolved, open }] oldest first,
 * one point per day (the last run of the day wins): found = distinct findings
 * seen in the run, resolved = resolved during the run (by the rule or by hand
 * since the previous run), open = the unresolved backlog after the run
 * (open + recurring).
 */
export async function trend({ prisma, limit = 30 }) {
  const runs = await prisma.auditRun.findMany({ where: { finishedAt: { not: null } }, orderBy: { startedAt: 'desc' }, take: limit, select: { startedAt: true, p1: true, p2: true, p3: true, summary: true, error: true } });
  const byDate = new Map();
  for (const r of (runs || []).slice().reverse()) {
    const date = new Date(r.startedAt).toISOString().slice(0, 10);
    const s = r.summary && typeof r.summary === 'object' ? r.summary : {};
    byDate.set(date, {
      date,
      found: (r.p1 || 0) + (r.p2 || 0) + (r.p3 || 0),
      resolved: Number(s.resolvedInRun || 0),
      open: s.counts ? Number(s.counts.open || 0) + Number(s.counts.recurring || 0) : null,
    });
  }
  return [...byDate.values()];
}

/** The Mission Control shape of a finding (the contract of GET /api/admin/audit). Pure. */
export function toAdminFinding(row) {
  const accounts = Array.isArray(row.accountsJson) ? row.accountsJson.length : 0;
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    severity: row.severity,
    category: row.category,
    title: row.title,
    occurrences: row.occurrences || 0,
    firstSeenAt: row.firstSeenAt ? new Date(row.firstSeenAt).toISOString() : null,
    lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : null,
    status: row.status,
    accounts: Math.max(row.accountCount || 0, accounts),
    sampleBotQuote: row.sampleBotQuote || null,
    sampleUserQuote: row.sampleUserQuote || null,
    why: row.why || null,
    fix: row.fix || null,
  };
}

/** The Mission Control shape of a run. Pure. */
export function toAdminRun(row) {
  if (!row) return null;
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  return {
    id: row.id,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    since: iso(row.since),
    until: iso(row.until),
    accounts: row.accounts || 0,
    turns: row.turns || 0,
    p1: row.p1 || 0,
    p2: row.p2 || 0,
    p3: row.p3 || 0,
    reviewed: !!row.reviewed,
    error: row.error || null,
    summary: row.summary && typeof row.summary === 'object' ? row.summary : null,
  };
}
