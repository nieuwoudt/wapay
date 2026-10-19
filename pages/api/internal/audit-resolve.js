/**
 * POST /api/internal/audit-resolve { fingerprint, note }   (x-internal-api-key)
 *
 * Marks one audit finding resolved by hand (lib/audit/store.js
 * resolveFinding): status resolved, the time, the note (what fixed it, the
 * BUGLOG number). A finding the next run sees again reopens as recurring and
 * keeps the note, so a regression is visible on the Health tab.
 *
 *   curl -X POST -H "x-internal-api-key: $KEY" -H "content-type: application/json" \
 *     -d '{"fingerprint":"<sha1>","note":"BUGLOG #130, build abc1234"}' \
 *     https://wapay-api.vercel.app/api/internal/audit-resolve
 */
import prisma from '../../../lib/prisma.js';
import { requireInternalAuth } from '../../../lib/internal-auth.js';
import { resolveFinding, toAdminFinding } from '../../../lib/audit/store.js';

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }
  if (!requireInternalAuth(req, res)) return;
  const fingerprint = String(req.body?.fingerprint || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(fingerprint)) return res.status(400).json({ ok: false, error: 'BAD_FINGERPRINT' });
  const note = String(req.body?.note || '').trim();
  if (note.length > 500) return res.status(400).json({ ok: false, error: 'BAD_NOTE' });
  try {
    const row = await resolveFinding({ prisma, fingerprint, note });
    if (!row) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    console.log(JSON.stringify({ type: 'audit_finding_resolved', fingerprint, noteChars: note.length }));
    return res.status(200).json({ ok: true, finding: toAdminFinding(row) });
  } catch (error) {
    console.error(JSON.stringify({ type: 'audit_resolve_error', error: error?.message }));
    return res.status(500).json({ ok: false, error: 'UNAVAILABLE' });
  }
}
