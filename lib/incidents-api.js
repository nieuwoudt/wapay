/**
 * What the incident route does, apart from HTTP (pages/api/internal/incidents.js): the responder's
 * work list and the step that closes one item. Takes `prisma`, so it is tested without a database.
 */
import { resolveFinding } from './audit/store.js';
import { toResponderFinding } from './incidents.js';

const SEV_RANK = { P1: 1, P2: 2, P3: 3 };
export const NOTE_MIN = 12;
export const NOTE_MAX = 500;
export const LIST_MAX = 100;

/**
 * Every open and recurring finding, most urgent first: P1 before P2, a live alert before a daily-audit
 * finding of the same severity, then newest. No account id leaves here.
 */
export async function listForResponder({ prisma, limit = LIST_MAX } = {}) {
  const rows = await prisma.auditFinding.findMany({ where: { status: { in: ['open', 'recurring'] } }, orderBy: [{ lastSeenAt: 'desc' }], take: 400 });
  const findings = (rows || []).map(toResponderFinding).sort((a, b) =>
    (SEV_RANK[a.severity] || 9) - (SEV_RANK[b.severity] || 9)
    || Number(b.live) - Number(a.live)
    || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
  const counts = { open: 0, recurring: 0, live: 0, p1: 0 };
  for (const f of findings) {
    if (f.status in counts) counts[f.status] += 1;
    if (f.live) counts.live += 1;
    if (f.severity === 'P1') counts.p1 += 1;
  }
  return { counts, findings: findings.slice(0, Math.max(1, Math.min(LIST_MAX, Number(limit) || LIST_MAX))) };
}

/**
 * Close one finding. The note is required and has to say something: it is the record of what fixed it
 * (a commit, a BUGLOG number, or why nothing needed fixing).
 * @returns {Promise<{ ok: true, finding: object } | { ok: false, status: number, error: string }>}
 */
export async function resolveForResponder({ prisma, fingerprint, note, by = 'responder' } = {}) {
  const fp = String(fingerprint || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(fp)) return { ok: false, status: 400, error: 'BAD_FINGERPRINT' };
  const text = String(note || '').replace(/\s+/g, ' ').trim();
  if (text.length < NOTE_MIN || text.length > NOTE_MAX) return { ok: false, status: 400, error: 'BAD_NOTE' };
  const row = await resolveFinding({ prisma, fingerprint: fp, note: by === 'responder' ? `[responder] ${text}`.slice(0, NOTE_MAX) : text });
  if (!row) return { ok: false, status: 404, error: 'NOT_FOUND' };
  return { ok: true, finding: toResponderFinding(row) };
}
