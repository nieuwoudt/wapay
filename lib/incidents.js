/**
 * Live incidents: what an alert knows, kept where an agent can pick it up (2026-11-18).
 *
 * Founder, 18 November 2026: "When we pick these up, agents should instantaneously solve it. It
 * shouldn't be mailed to me and then me giving it to you." Until this date an alert was an e-mail
 * and a WhatsApp line. The facts it was built from (which words the model asked for, which account,
 * what category Meta billed) were thrown away once the mail was sent, so whoever fixed it started
 * from a screenshot and re-read production by hand.
 *
 * An incident is one row in the findings table the daily conversation audit already keeps
 * (audit_findings, lib/audit/store.js): the same fingerprint rule, the same statuses, the same
 * Health tab in Mission Control, the same "resolved, with a note" step. It is written the moment
 * the alert fires, with what the fixer needs: what happened, where to look, the masked words. The
 * incident responder (docs/audits/INCIDENT_RESPONDER.md) reads the open rows through
 * GET /api/internal/incidents and closes each one with the commit that fixed it.
 *
 * Rules:
 *   - Masked like the audit's own rows: no number of six digits or more, no known name, quotes cut
 *     to 200 characters. Account ids are kept in the row for an operator and never leave through
 *     the responder route.
 *   - The same incident again is the same row, counted. One that was resolved and comes back
 *     reopens as recurring and keeps its note, so a regression is visible.
 *   - A live row is not the audit's to close: the daily run's "not seen in two runs" rule skips it
 *     (store.js settleStatuses). It stays open until someone resolves it with a note.
 *   - Best effort and never throws: recording an incident must never change what the customer is
 *     sent or delay it by more than a short cap.
 */
import prismaDefault from './prisma.js';
import { fingerprintOf, mergeAccounts, ACCOUNTS_KEPT, LIVE_RUN_ID } from './audit/store.js';
import { redactText, maskNames, nameParts } from './audit/export.js';

export { LIVE_RUN_ID };
const CAP_MS = 3000;
const SEVERITIES = new Set(['P1', 'P2', 'P3']);

const scrub = (text, names, max) => maskNames(redactText(String(text ?? '')), names).replace(/[ \t]+/g, ' ').trim().slice(0, max);

/**
 * The row an incident writes: masked, clamped, fingerprinted. Pure.
 * `phrase` belongs in the title only when it is the product's own words (a command the model named),
 * never the customer's.
 */
export function incidentRow({ severity = 'P1', category = 'other', title, why = null, fix = null, accountId = null, displayName = null, botQuote = null, userQuote = null, now = new Date() } = {}) {
  const names = nameParts(displayName);
  const cleanTitle = scrub(title, names, 160).replace(/\s+/g, ' ');
  if (!cleanTitle) return null;
  const cat = String(category || 'other').toLowerCase().replace(/[^a-z-]/g, '').slice(0, 30) || 'other';
  return {
    fingerprint: fingerprintOf(cat, cleanTitle),
    severity: SEVERITIES.has(severity) ? severity : 'P2',
    category: cat,
    title: cleanTitle,
    why: why ? scrub(why, names, 400) : null,
    fix: fix ? scrub(fix, names, 400) : null,
    account: accountId ? { id: String(accountId), at: new Date(now).toISOString() } : null,
    sampleBotQuote: botQuote ? scrub(botQuote, names, 200) : null,
    sampleUserQuote: userQuote ? scrub(userQuote, names, 200) : null,
  };
}

async function write({ prisma, row, now }) {
  const existing = await prisma.auditFinding.findUnique({ where: { fingerprint: row.fingerprint } });
  const accounts = row.account ? [row.account] : [];
  if (!existing) {
    await prisma.auditFinding.create({
      data: {
        fingerprint: row.fingerprint, severity: row.severity, category: row.category, title: row.title, why: row.why, fix: row.fix,
        firstSeenRunId: LIVE_RUN_ID, lastSeenRunId: LIVE_RUN_ID, firstSeenAt: now, lastSeenAt: now,
        occurrences: 1, accountCount: accounts.length, accountsJson: accounts,
        sampleBotQuote: row.sampleBotQuote, sampleUserQuote: row.sampleUserQuote, status: 'open',
      },
    });
    return { created: true, status: 'open' };
  }
  const known = new Set((Array.isArray(existing.accountsJson) ? existing.accountsJson : []).map((a) => a && a.id).filter(Boolean));
  const fresh = accounts.filter((a) => !known.has(a.id)).length;
  const status = existing.status === 'resolved' ? 'recurring' : existing.status;
  await prisma.auditFinding.update({
    where: { fingerprint: row.fingerprint },
    data: {
      lastSeenAt: now,
      occurrences: (existing.occurrences || 0) + 1,
      accountCount: (existing.accountCount || known.size) + fresh,
      accountsJson: mergeAccounts(existing.accountsJson, accounts, ACCOUNTS_KEPT),
      why: existing.why || row.why, fix: existing.fix || row.fix,
      sampleBotQuote: existing.sampleBotQuote || row.sampleBotQuote,
      sampleUserQuote: existing.sampleUserQuote || row.sampleUserQuote,
      status, resolvedAt: null,
    },
  });
  return { created: false, status };
}

/**
 * Record one incident. Never throws; gives up after a short cap.
 * @returns {Promise<{ ok: boolean, fingerprint?: string, ref?: string, created?: boolean, status?: string, error?: string }>}
 *   `ref` is the first ten characters of the fingerprint: what an alert quotes and the Health tab shows.
 */
export async function recordIncident({ prisma = prismaDefault, now = new Date(), capMs = CAP_MS, ...incident } = {}) {
  try {
    const row = incidentRow({ ...incident, now });
    if (!row) return { ok: false, error: 'NO_TITLE' };
    if (typeof prisma?.auditFinding?.findUnique !== 'function') return { ok: false, error: 'NO_STORE' };
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), capMs); });
    const done = await Promise.race([write({ prisma, row, now: new Date(now) }), timeout]).finally(() => clearTimeout(timer));
    if (done?.timedOut) return { ok: false, error: 'TIMEOUT', fingerprint: row.fingerprint, ref: row.fingerprint.slice(0, 10) };
    console.log(JSON.stringify({ type: 'incident_recorded', fingerprint: row.fingerprint, category: row.category, severity: row.severity, created: done.created, status: done.status }));
    return { ok: true, fingerprint: row.fingerprint, ref: row.fingerprint.slice(0, 10), ...done };
  } catch (error) {
    console.error(JSON.stringify({ type: 'incident_record_failed', error: error?.message }));
    return { ok: false, error: String(error?.message || 'ERROR').slice(0, 120) };
  }
}

/** The line an alert adds so a reader knows the facts are kept and where. Pure. */
export function incidentLine(recorded) {
  return recorded?.ok && recorded.ref
    ? `Recorded as finding ${recorded.ref} (Mission Control, Health). The incident responder reads that list; resolve it there with the commit that fixes it.`
    : '';
}

/** What the responder may read of a row: the audit's own contract plus whether it came from a live alert. Pure. */
export function toResponderFinding(row) {
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  return {
    fingerprint: row.fingerprint,
    ref: String(row.fingerprint || '').slice(0, 10),
    live: row.firstSeenRunId === LIVE_RUN_ID,
    severity: row.severity,
    category: row.category,
    title: row.title,
    status: row.status,
    occurrences: row.occurrences || 0,
    accounts: Math.max(row.accountCount || 0, Array.isArray(row.accountsJson) ? row.accountsJson.length : 0),
    firstSeenAt: iso(row.firstSeenAt),
    lastSeenAt: iso(row.lastSeenAt),
    why: row.why || null,
    fix: row.fix || null,
    sampleBotQuote: row.sampleBotQuote || null,
    sampleUserQuote: row.sampleUserQuote || null,
    resolvedNote: row.resolvedNote || null,
  };
}
