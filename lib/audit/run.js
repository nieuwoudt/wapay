/**
 * The daily conversation audit, end to end (docs/audits/DAILY_AUDIT.md):
 * export the conversations since the last run → the deterministic rules →
 * the model review (through packages/ai's single door, or skipped without a
 * key) → upsert the findings by fingerprint → write the run → the trend →
 * one ops summary by WhatsApp (opsPersonAlert) and e-mail (sendOpsAlert):
 * counts by severity, the top recurring titles, the link to Mission Control.
 * Never a customer name, number or message in the summary or the logs.
 *
 * runDailyAudit({ prisma, now, since, dry, deadlineMs, deps, env })
 *   dry:true   computes everything and returns it; writes nothing, sends nothing.
 *   deadlineMs the budget; the review reads chunks in parallel and skips the ones
 *              that will not fit, the writes always happen (the cron gives 22 s, the
 *              internal route 50 s).
 *   deps       { model, opsPersonAlert, sendOpsAlert, resolveProviders, processChecks }
 *              for tests; model:null means no reviewer.
 * Resolves { ok:false, error } on failure; never throws (the cron and the
 * route both read `ok`). A failed run leaves a row with `error` set.
 */
import { exportTurns, maskNames, redactText } from './export.js';
import { scanExport } from './rules.js';
import { truthBlock, liveProviders, readProcessChecks, buildReviewBrief } from './brief.js';
import { reviewAccounts, defaultReviewModel } from './review.js';
import { fingerprintOf, latestRun, createRun, finishRun, upsertFindings, settleStatuses, statusCounts, topRecurring, trend as readTrend } from './store.js';
import { launchScope } from '../vas-config.js';
import { opsPersonAlert as realOpsPersonAlert } from '../ops-alerts.js';
import { sendOpsAlert as realSendOpsAlert } from '../email.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_LOOKBACK_DAYS = 7;
export const DEFAULT_MAX_ACCOUNTS = 400;
const WRITE_RESERVE_MS = 6000;
const ALERT_CAP_MS = 5000;

const log = (type, data) => console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));
const logError = (type, data) => console.error(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));

export function missionControlUrl(env = process.env) {
  return env.WAPAY_ADMIN_URL || 'https://wapay-api.vercel.app/admin';
}

export function maxAccountsFromEnv(env = process.env) {
  const n = Number(env.WAPAY_AUDIT_MAX_ACCOUNTS);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_MAX_ACCOUNTS;
}

/** The boundary's tokens and any surviving number or known name become the audit's masks. Pure. */
export function scrubText(text, names = []) {
  const s = String(text ?? '')
    .replace(/\[\[N\d+\]\]/g, '[name]')
    .replace(/\[\[P\d+\]\]/g, '[number]')
    .replace(/\[\[E\d+\]\]/g, '[email]')
    .replace(/\[\[S\d+\]\]/g, '[reference]');
  return maskNames(redactText(s), names);
}

/** One finding as the store takes it: masked, clamped, fingerprinted. Pure. */
export function normaliseFinding(f, names = []) {
  const title = scrubText(f.title, names).replace(/\s+/g, ' ').trim().slice(0, 160);
  const category = String(f.category || 'other');
  return {
    severity: ['P1', 'P2', 'P3'].includes(f.severity) ? f.severity : 'P3',
    category,
    title,
    accountId: f.accountId || null,
    at: f.at || null,
    botQuote: scrubText(f.botQuote, names).slice(0, 200),
    userQuote: scrubText(f.userQuote, names).slice(0, 200),
    why: scrubText(f.why, names).slice(0, 400),
    fix: scrubText(f.fix, names).slice(0, 400),
    rule: f.rule || 'review',
    fingerprint: fingerprintOf(category, title),
  };
}

/** Distinct findings by severity: { p1, p2, p3, distinct, hits }. Pure. */
export function severityCounts(findings) {
  const seen = new Map();
  for (const f of findings || []) if (!seen.has(f.fingerprint)) seen.set(f.fingerprint, f.severity);
  const out = { p1: 0, p2: 0, p3: 0, distinct: seen.size, hits: (findings || []).length };
  for (const s of seen.values()) out[String(s).toLowerCase()] = (out[String(s).toLowerCase()] || 0) + 1;
  return out;
}

const when = (d) => new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The ops summary: counts only, titles of the top recurring findings, the link. Pure. */
export function opsSummary({ since, until, accounts, turns, counts, status, resolvedInRun, reviewed, review, topRecurring: top = [], truncated = 0, url }) {
  const head = `🧪 Daily conversation audit, ${when(until)}: ${accounts} account${accounts === 1 ? '' : 's'}, ${turns} turns since ${when(since)}${truncated ? ` (${truncated} accounts over the cap were not read; raise WAPAY_AUDIT_MAX_ACCOUNTS)` : ''}.`;
  const found = `Found ${counts.distinct} distinct: P1 ${counts.p1}, P2 ${counts.p2}, P3 ${counts.p3}. Reviewer: ${reviewed ? 'read every chunk' : review?.skipped === 'NO_MODEL' ? 'off (no model key), rules only' : `partial (${review?.chunksReviewed ?? 0} of ${review?.chunks ?? 0} chunks)`}.`;
  const backlog = `Backlog: open ${status.open}, recurring ${status.recurring}, resolved ${status.resolved} (${resolvedInRun} in this run).`;
  const recurring = top.length ? `Top recurring: ${top.map((t) => `"${t.title}" (${t.severity}, ${t.occurrences}x)`).join('; ')}.` : 'No recurring findings.';
  const link = `Mission Control, Health tab: ${url}`;
  const text = [head, found, backlog, recurring, link].join('\n');
  const subject = `Daily conversation audit: ${counts.distinct} found (P1 ${counts.p1}), ${status.open + status.recurring} unresolved`;
  const detailsHtml = `<p>${esc(head)}</p><p>${esc(found)}</p><p>${esc(backlog)}</p>`
    + (top.length ? `<p>Top recurring:</p><ul>${top.map((t) => `<li>${esc(t.title)} (${esc(t.severity)}, ${t.occurrences}x)</li>`).join('')}</ul>` : '<p>No recurring findings.</p>')
    + `<p><a href="${esc(url)}">${esc(url)}</a> (Health tab)</p>`;
  return { text, subject, detailsHtml };
}

function resolveWindow({ now, since, last }) {
  const until = new Date(now);
  let from = since ? new Date(since) : last?.until ? new Date(last.until) : new Date(until.getTime() - DAY_MS);
  if (Number.isNaN(from.getTime())) from = new Date(until.getTime() - DAY_MS);
  const floor = new Date(until.getTime() - MAX_LOOKBACK_DAYS * DAY_MS);
  if (from < floor) from = floor;
  if (from >= until) from = new Date(until.getTime() - DAY_MS);
  return { since: from, until };
}

export async function runDailyAudit({ prisma, now = new Date(), since = null, dry = false, deadlineMs = 50_000, deps = {}, env = process.env } = {}) {
  const startedMs = Date.now();
  const deadlineAt = startedMs + Math.max(5000, Number(deadlineMs) || 50_000);
  let runId = null;
  const result = { ok: false, dry: !!dry, runId: null };
  try {
    let last = null;
    try { last = await latestRun({ prisma }); } catch (error) { logError('audit_last_run_unreadable', { error: String(error?.message || error).slice(0, 200) }); }
    const window = resolveWindow({ now, since, last });
    result.since = window.since.toISOString();
    result.until = window.until.toISOString();

    if (!dry) {
      const row = await createRun({ prisma, since: window.since, until: window.until, now: new Date(now) });
      runId = row.id; result.runId = runId;
    }

    // 1. Export, redacted; account ids and facts only.
    const exp = await exportTurns({ prisma, since: window.since, until: window.until, maxAccounts: maxAccountsFromEnv(env) });
    result.accounts = exp.counts.accounts; result.turns = exp.counts.turns; result.truncated = exp.truncated;
    const allNames = [...new Set(exp.accounts.flatMap((a) => a.privacyNames || []))];

    // 2. The rules, against today's switches.
    const scope = launchScope(null);
    const scan = scanExport(exp, { now: new Date(now), scope });

    // 3. The brief: generated truth (live providers, best effort), the process checks, the known titles.
    const providers = await (deps.resolveProviders ? liveProviders({ resolve: deps.resolveProviders, enabled: true }) : liveProviders());
    const processChecks = deps.processChecks !== undefined ? deps.processChecks : readProcessChecks();
    if (!processChecks) logError('audit_process_checks_unreadable', {});
    let knownTitles = [];
    try {
      const open = await prisma.auditFinding.findMany({ where: { status: { in: ['open', 'recurring'] } }, orderBy: [{ occurrences: 'desc' }], take: 60, select: { title: true } });
      knownTitles = (open || []).map((r) => r.title);
    } catch (error) { logError('audit_known_titles_unreadable', { error: String(error?.message || error).slice(0, 200) }); }
    const brief = buildReviewBrief({ truth: truthBlock({ providers }), processChecks, knownTitles });

    // 4. The review, inside what is left of the budget after the writes' reserve.
    const model = deps.model === undefined ? defaultReviewModel({ env }) : deps.model;
    const review = await reviewAccounts({ brief, accounts: exp.accounts, model, deadlineAt: deadlineAt - WRITE_RESERVE_MS });

    // 5. One list, masked and fingerprinted.
    const findings = [...scan.findings, ...review.findings].map((f) => normaliseFinding(f, allNames));
    const counts = severityCounts(findings);
    Object.assign(result, {
      counts, reviewed: review.reviewed,
      review: { skipped: review.skipped, chunks: review.chunks, chunksReviewed: review.chunksReviewed, chunksSkipped: review.chunksSkipped, errors: review.errors, patterns: review.patterns, workedWell: review.workedWell },
      patterns: scan.patterns, ruleCounts: scan.counts, findings,
      providersRead: !!providers, processChecks: !!processChecks, briefChars: brief.length,
    });
    log('audit_run_computed', { dry: !!dry, accounts: result.accounts, turns: result.turns, truncated: result.truncated, p1: counts.p1, p2: counts.p2, p3: counts.p3, distinct: counts.distinct, hits: counts.hits, reviewed: review.reviewed, chunks: review.chunks, chunksReviewed: review.chunksReviewed, reviewErrors: review.errors.length, providersRead: !!providers, processChecks: !!processChecks });
    if (dry) { result.ok = true; result.ms = Date.now() - startedMs; return result; }

    // 6. The store: findings, statuses, the run, the trend.
    const previous = await latestRun({ prisma, withAccounts: true, before: runId });
    const up = await upsertFindings({ prisma, runId, findings, now: new Date(now) });
    const settled = exp.counts.accounts > 0 ? await settleStatuses({ prisma, runId, previousRunId: previous?.id || null, now: new Date(now) }) : { resolved: 0 };
    const status = await statusCounts({ prisma });
    const top = await topRecurring({ prisma, limit: 5 });
    const summary = {
      counts: status, resolvedInRun: settled.resolved, unresolved: status.open + status.recurring,
      findingsCreated: up.created, findingsUpdated: up.updated,
      patterns: scan.patterns, ruleCounts: scan.counts,
      review: result.review, topRecurring: top.map((t) => ({ title: t.title, occurrences: t.occurrences, severity: t.severity })),
      truncated: exp.truncated, providersRead: !!providers, processChecks: !!processChecks, previousRunId: previous?.id || null,
    };
    await finishRun({ prisma, runId, data: { finishedAt: new Date(), accounts: exp.counts.accounts, turns: exp.counts.turns, p1: counts.p1, p2: counts.p2, p3: counts.p3, reviewed: !!review.reviewed, summary } });
    const trend = await readTrend({ prisma, limit: 30 }).catch(() => []);
    Object.assign(result, { status, resolvedInRun: settled.resolved, trend, findingsCreated: up.created, findingsUpdated: up.updated });

    // 7. The ops summary, both channels, best effort.
    const ops = opsSummary({ since: window.since, until: window.until, accounts: exp.counts.accounts, turns: exp.counts.turns, counts, status, resolvedInRun: settled.resolved, reviewed: review.reviewed, review, topRecurring: summary.topRecurring, truncated: exp.truncated, url: missionControlUrl(env) });
    // Both channels at once, inside a short cap: the run is written by now and a slow rail must not hold the cron.
    let alertTimer = null;
    const [wa, mail] = await Promise.race([
      Promise.all([
        (deps.opsPersonAlert || realOpsPersonAlert)({ text: ops.text, key: `audit:${runId}`, prisma }).catch((e) => ({ sent: 0, error: e?.message })),
        (deps.sendOpsAlert || realSendOpsAlert)({ subject: ops.subject, detailsHtml: ops.detailsHtml }).catch((e) => ({ success: false, error: e?.message })),
      ]),
      new Promise((resolve) => { alertTimer = setTimeout(() => resolve([{ sent: 0, skipped: 'TIMEOUT' }, { success: false, skipped: 'TIMEOUT' }]), ALERT_CAP_MS); }),
    ]);
    if (alertTimer) clearTimeout(alertTimer);
    result.ops = { whatsapp: !!(wa && wa.sent), email: !!(mail && mail.success), text: ops.text };
    result.ok = true; result.ms = Date.now() - startedMs;
    log('audit_run_done', { runId, accounts: result.accounts, turns: result.turns, p1: counts.p1, p2: counts.p2, p3: counts.p3, open: status.open, recurring: status.recurring, resolved: status.resolved, resolvedInRun: settled.resolved, reviewed: review.reviewed, whatsapp: result.ops.whatsapp, email: result.ops.email, ms: result.ms });
    return result;
  } catch (error) {
    const message = String(error?.message || error).slice(0, 300);
    logError('audit_run_failed', { runId, dry: !!dry, error: message });
    if (runId) await finishRun({ prisma, runId, data: { finishedAt: new Date(), error: message } }).catch(() => null);
    return { ...result, ok: false, error: message, ms: Date.now() - startedMs };
  }
}
